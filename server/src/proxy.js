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
const outbound = require('./outbound');

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
// `suffix` (e.g. "?o=dlhd") is appended so child fetches inherit an egress flag (the base64url
// token has no '?', so this stays a clean single query).
function proxify(uri, baseUrl, suffix = '') {
    try {
        const abs = new URL(uri, baseUrl).toString();
        return PREFIX + encodeTarget(abs) + suffix;
    } catch {
        return uri;
    }
}

// Rewrite URI="..." inside a tag line (EXT-X-KEY / MEDIA / MAP / I-FRAME-STREAM-INF).
function rewriteTagUri(line, baseUrl, suffix = '') {
    return line.replace(/URI="([^"]+)"/g, (_m, uri) => `URI="${proxify(uri, baseUrl, suffix)}"`);
}

function rewriteManifest(text, baseUrl, suffix = '') {
    const out = [];
    for (const raw of text.split('\n')) {
        const line = raw.replace(/\r$/, '');
        const trimmed = line.trim();
        if (trimmed === '') {
            out.push(line);
        } else if (trimmed.startsWith('#')) {
            // Tags with a URI attribute need that URI proxied too.
            out.push(/URI="/.test(trimmed) ? rewriteTagUri(line, baseUrl, suffix) : line);
        } else {
            // A bare URI line = a segment or a variant playlist.
            out.push(proxify(trimmed, baseUrl, suffix));
        }
    }
    return out.join('\n');
}

// --- manifest micro-cache ---------------------------------------------------
// Live HLS players RE-POLL the media playlist every ~target-duration for new segments, and
// startup bursts (master -> several variants) plus ABR switches hit the same playlist URLs
// in quick succession. For redirect/tokenized providers each such fetch is expensive AND
// rate-limited: tvpass.org 302s to thetvapp.to minting a fresh token, and throttles bursts
// (hangs after ~2 rapid hits) — which is exactly the "tvpass is slow" symptom. A tiny TTL
// cache of the REWRITTEN manifest collapses those duplicate upstream fetches without serving
// a stale live edge: media playlists are cached ~2s (well under one segment's duration),
// masters ~15s (their variant sets rarely change). The rewritten body is host-relative
// (/proxy/<b64>) and segments are fetched server-side from our IP, so one cache entry is
// valid for every client. Segments are never cached (we don't buffer video bytes).
const _manifestCache = new Map();   // decoded target URL -> { body, expires }
const _MANIFEST_TTL_MEDIA_MS = parseInt(process.env.PROXY_MANIFEST_TTL_MS || '2000', 10);
const _MANIFEST_TTL_MASTER_MS = parseInt(process.env.PROXY_MASTER_TTL_MS || '15000', 10);
const _MANIFEST_CACHE_MAX = 512;

function _cacheGet(key) {
    const e = _manifestCache.get(key);
    if (!e) return null;
    if (e.expires <= Date.now()) { _manifestCache.delete(key); return null; }
    return e.body;
}

function _cachePut(key, body, ttl) {
    if (ttl <= 0) return;
    if (_manifestCache.size >= _MANIFEST_CACHE_MAX) {
        // Map preserves insertion order — drop the oldest entry (cheap FIFO eviction).
        const oldest = _manifestCache.keys().next().value;
        if (oldest !== undefined) _manifestCache.delete(oldest);
    }
    _manifestCache.set(key, { body, expires: Date.now() + ttl });
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

    // Fast path: a recently-rewritten manifest for this exact target is reusable as-is.
    // Only manifests are ever cached; segment requests carry a Range and always go upstream.
    if (!req.headers['range']) {
        const cached = _cacheGet(target);
        if (cached !== null) {
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Access-Control-Allow-Origin', '*');
            log.debug(`manifest cache HIT: ${target.slice(0, 70)}`);
            return res.end(cached);
        }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.PROXY_TIMEOUT_MS);
    // Abort the upstream fetch if the client goes away (channel switch / seek / player teardown).
    const onClientClose = () => controller.abort();
    req.on('close', onClientClose);

    // dlhd-tagged child fetches (?o=dlhd) egress through the DaddyLive VPN/proxy — the CDN drops
    // VPS IPs just like the embed host. All other proxied feeds (tvpass/xumo/…) stay direct.
    const dispatcher = /[?&]o=dlhd\b/.test(req.url) ? outbound.dlhdDispatcher() : undefined;
    try {
        const upstream = await fetch(target, {
            headers: upstreamHeaders(target, req),
            redirect: 'follow',
            signal: controller.signal,
            dispatcher,
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
            // Cache only good manifests; masters live longer than media playlists.
            if (upstream.status === 200) {
                const isMaster = /#EXT-X-STREAM-INF/.test(text);
                _cachePut(target, rewritten,
                    isMaster ? _MANIFEST_TTL_MASTER_MS : _MANIFEST_TTL_MEDIA_MS);
            }
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
            const body = Readable.fromWeb(upstream.body);
            // A client disconnect aborts the fetch mid-stream, which makes `body` emit 'error'
            // (AbortError). With NO listener that becomes an UNHANDLED 'error' event and crashes
            // the whole process (the ~5-15 min reboot loop). Handle it: the client is gone, so
            // just tear down quietly. Real (non-abort) upstream errors are logged at debug.
            body.on('error', (e) => {
                if (e && e.name !== 'AbortError') {
                    log.debug(`proxy stream error for ${target.slice(0, 70)}: ${e.message}`);
                }
                if (!res.writableEnded) res.destroy();
            });
            res.on('close', () => body.destroy());
            body.pipe(res);
        } else {
            res.end();
        }
    } catch (err) {
        // AbortError on client disconnect is expected/benign — don't log it as a failure.
        if (err && err.name !== 'AbortError') {
            log.warn(`proxy fetch failed for ${target.slice(0, 70)}: ${err.message}`);
        }
        if (!res.headersSent && !res.writableEnded) {
            res.statusCode = 502;
            try { res.end(`proxy error: ${err.message}`); } catch { /* client already gone */ }
        }
    } finally {
        clearTimeout(timer);
        req.off('close', onClientClose);
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
