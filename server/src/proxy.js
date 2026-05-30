// proxy.js — server-side HLS-rewriting stream proxy.
//
// Why: some upstream feeds are "fragile" for a TV client — plain HTTP, raw-IP hosts,
// odd ports, or CDNs that 403 their segments without a Referer/UA. Routing them through
// this proxy fixes all of that server-side:
//   • the client only ever sees a clean HTTPS URL on our own host;
//   • we fetch the upstream with a browser User-Agent + a same-origin Referer, follow
//     redirects, and accept any TLS cert;
//   • for HLS, we REWRITE the manifest so variant playlists, segments, keys and maps are
//     ALSO fetched through us (with the same headers) — otherwise the player would hit
//     the bare segment URLs directly and 403 → buffer forever.
//
// Route: GET /proxy/<base64url(upstreamUrl)>
//   - m3u8  -> rewrite child URIs to /proxy/<base64url(absChildUrl)> (relative to our host)
//   - other -> stream bytes through (Range/seek preserved)
//
// Only http/https upstreams are proxied. Intended for the curated catalog's own streams.

const { Readable } = require('stream');

const cfg = require('./config');
const log = require('./log')('Proxy');

const PREFIX = '/proxy/';

// --- public base URL (auto-detected) ---------------------------------------
// The proxy needs the addon's externally-reachable base to build absolute stream URLs.
// Explicit PROXY_PUBLIC_URL wins; otherwise we LEARN it from the Host header of incoming
// requests (Tailscale Funnel / any reverse proxy passes the real public host), so a
// Funnel deployment needs zero configuration. Pure-local hosts (localhost / private IP)
// are ignored so we don't hand a private URL to external clients.
let _observedBase = '';

function _isPublicHost(host) {
    if (!host) return false;
    const h = host.split(':')[0].toLowerCase();
    if (h === 'localhost' || h === '0.0.0.0') return false;
    if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h)) return false;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return false;
    return h.includes('.') || h.endsWith('.ts.net');
}

/** Record the public base from a request (called for every inbound request). */
function noteRequest(req) {
    if (cfg.PROXY_PUBLIC_URL) return;  // explicit config wins; nothing to learn
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    if (!_isPublicHost(host)) return;
    const proto = (req.headers['x-forwarded-proto'] || '').split(',')[0].trim()
        || (host.endsWith('.ts.net') ? 'https' : 'http');  // Funnel is always HTTPS
    const base = `${proto}://${host}`;
    if (base !== _observedBase) {
        _observedBase = base;
        log.info(`Public base auto-detected: ${base} (proxy active)`);
    }
}

/** The base used to build absolute proxy URLs, or '' if unknown. */
function publicBase() {
    return (cfg.PROXY_PUBLIC_URL || _observedBase || '').replace(/\/+$/, '');
}

/** Whether the proxy can currently rewrite fragile streams. */
function proxyActive() {
    return !cfg.PROXY_DISABLE && !!publicBase();
}

function encodeTarget(url) {
    return Buffer.from(url, 'utf-8').toString('base64url');
}

function decodeTarget(token) {
    try {
        const url = Buffer.from(token, 'base64url').toString('utf-8');
        return /^https?:\/\//i.test(url) ? url : null;
    } catch {
        return null;
    }
}

// --- header policy ---------------------------------------------------------

function upstreamHeaders(targetUrl, clientReq) {
    let origin = '';
    try {
        const u = new URL(targetUrl);
        origin = `${u.protocol}//${u.host}`;
    } catch { /* ignore */ }
    const h = { 'User-Agent': cfg.PROXY_USER_AGENT };
    if (origin) {
        h.Referer = origin + '/';
        h.Origin = origin;
    }
    // Pass through Range so seeking / segment byte-ranges work.
    const range = clientReq.headers['range'];
    if (range) h.Range = range;
    return h;
}

// --- HLS manifest rewriting -------------------------------------------------

const _M3U8_HINT = /#EXTM3U|#EXT-X-/;

function isManifest(contentType, url) {
    const ct = (contentType || '').toLowerCase();
    return ct.includes('mpegurl') || ct.includes('vnd.apple') || /\.m3u8(\?|$)/i.test(url);
}

// Rewrite a URI (segment / variant / key / map) to its absolute form, then to our proxy.
function proxify(uri, baseUrl) {
    try {
        const abs = new URL(uri, baseUrl).toString();
        return PREFIX + encodeTarget(abs);
    } catch {
        return uri;
    }
}

// Rewrite URI="..." inside a tag line (EXT-X-KEY / MEDIA / MAP / I-FRAME-STREAM-INF).
function rewriteTagUri(line, baseUrl) {
    return line.replace(/URI="([^"]+)"/g, (_m, uri) => `URI="${proxify(uri, baseUrl)}"`);
}

function rewriteManifest(text, baseUrl) {
    const out = [];
    for (const raw of text.split('\n')) {
        const line = raw.replace(/\r$/, '');
        const trimmed = line.trim();
        if (trimmed === '') {
            out.push(line);
        } else if (trimmed.startsWith('#')) {
            // Tags with a URI attribute need that URI proxied too.
            out.push(/URI="/.test(trimmed) ? rewriteTagUri(line, baseUrl) : line);
        } else {
            // A bare URI line = a segment or a variant playlist.
            out.push(proxify(trimmed, baseUrl));
        }
    }
    return out.join('\n');
}

// --- request handler --------------------------------------------------------

async function handle(req, res) {
    const path = req.url.split('?')[0];
    const token = path.slice(PREFIX.length);
    const target = decodeTarget(token);
    if (!target) {
        res.statusCode = 400;
        return res.end('bad proxy target');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.PROXY_TIMEOUT_MS);
    req.on('close', () => controller.abort());

    try {
        const upstream = await fetch(target, {
            headers: upstreamHeaders(target, req),
            redirect: 'follow',
            signal: controller.signal,
        });

        const ctype = upstream.headers.get('content-type') || '';

        if (isManifest(ctype, target)) {
            const text = await upstream.text();
            if (!_M3U8_HINT.test(text)) {
                // Not actually a playlist — pass through as-is.
                res.statusCode = upstream.status;
                res.setHeader('Content-Type', ctype || 'application/octet-stream');
                return res.end(text);
            }
            const rewritten = rewriteManifest(text, upstream.url || target);
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Access-Control-Allow-Origin', '*');
            log.debug(`manifest proxied: ${target.slice(0, 70)} (${rewritten.length} B)`);
            return res.end(rewritten);
        }

        // Binary (segment / key / etc.) — relay status + headers + body.
        res.statusCode = upstream.status;
        for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
            const v = upstream.headers.get(h);
            if (v) res.setHeader(h, v);
        }
        res.setHeader('Access-Control-Allow-Origin', '*');
        if (upstream.body) {
            Readable.fromWeb(upstream.body).pipe(res);
        } else {
            res.end();
        }
    } catch (err) {
        if (!res.headersSent) {
            res.statusCode = 502;
            res.end(`proxy error: ${err.message}`);
        }
        log.warn(`proxy fetch failed for ${target.slice(0, 70)}: ${err.message}`);
    } finally {
        clearTimeout(timer);
    }
}

/** Absolute proxy URL for a target, using the configured/auto-detected public base. */
function proxyUrl(target) {
    return `${publicBase()}${PREFIX}${encodeTarget(target)}`;
}

module.exports = {
    handle, proxyUrl, proxyActive, publicBase, noteRequest, PREFIX,
    isManifest, rewriteManifest, encodeTarget, decodeTarget,
};
