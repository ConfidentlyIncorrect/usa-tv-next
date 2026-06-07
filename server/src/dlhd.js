// dlhd.js — DaddyLive (dlhd.pk) live-resolver + re-serving HLS endpoints.
//
// WHY THIS EXISTS
// When tvpass.org died, ~69 premium/cable/sports channels (ESPN family, RSNs, A&E, AMC,
// CNBC/MSNBC, HBO/Showtime/Starz multiplexes, …) lost their only stream. DaddyLive carries
// that exact tier as stable 24/7 channels (dlhd.pk/watch.php?id=N, N pinned in dlhdChannels.js).
//
// HOW DADDYLIVE STREAMS WORK (verified end-to-end)
//   watch.php?id=N  -> iframe stream/stream-N.php (obfuscated player)
//                   -> iframe https://<rotating-embed-host>/premiumtv/daddy3.php?id=N
//   the embed page base64-encodes (atob) the FINAL media URL, e.g.
//     https://<cdn>/premiumN/index.m3u8?md5v1=..&md5v2=..&expires=<unixSec>
//   That master -> a single media playlist (tracks-v1a1/mono.m3u8?md5=..&expires=..)
//   -> .ts segments (disguised as .pdf/.js on ANOTHER rotating host).
//
// KEY FACTS THAT SHAPE THE DESIGN
//   • NO referer/origin lock anywhere — auth is entirely the in-URL md5/expires token, so
//     our existing /proxy (which only adds a UA + same-origin referer) plays them fine and
//     the CLIENT (NuvioTV) needs ZERO changes: it just gets a clean HLS URL on our host.
//   • The token expires ~58 min after it's minted, and is minted FRESH per resolve. So a
//     URL can't be statically injected (it dies within the hour) — it must be resolved live
//     and RE-resolved before expiry for long sessions.
//   • The embed host + segment host ROTATE periodically. We discover the embed host from
//     stream-N.php every resolve, so rotation self-heals without code changes.
//
// THE TWO ENDPOINTS (served by handle(), routed at /dlhd/ in server.js)
//   GET /dlhd/<id>/master.m3u8  -> a synthesized master whose only variant points at our
//                                  OWN media endpoint below (so the player polls US, not the
//                                  expiring CDN URL directly).
//   GET /dlhd/<id>/media.m3u8   -> fetches the CURRENT (cached, auto-refreshed-before-expiry)
//                                  media playlist and rewrites its segments through /proxy.
//                                  Because this endpoint re-resolves under the hood, token
//                                  expiry is invisible to the player and sessions run forever.
//
// Resolution is cached per dlhd id and single-flighted; we hit dlhd.pk at most ~once/hour/chan.

const { Readable } = require('stream');

const cfg = require('./config');
const log = require('./log')('DaddyLive');
const proxy = require('./proxy');
const { DARK, EXTRA } = require('./dlhdChannels');

const PREFIX = '/dlhd/';

// --- roster -> dlhd id ------------------------------------------------------
// DARK channels always get dlhd (it's their only source). EXTRA (channels that still have a
// free feed) only when DLHD_INCLUDE_EXTRA=1. Built once at load.
const _rosterMap = Object.assign({}, DARK, cfg.DLHD_INCLUDE_EXTRA ? EXTRA : {});

/** dlhd numeric id for a roster channel id, or null if not mapped/enabled. */
function dlhdIdForRoster(rosterId) {
    if (!cfg.DLHD_ENABLE) return null;
    return Object.prototype.hasOwnProperty.call(_rosterMap, rosterId) ? _rosterMap[rosterId] : null;
}

function mappedCount() {
    return cfg.DLHD_ENABLE ? Object.keys(_rosterMap).length : 0;
}

// --- resolve cache ----------------------------------------------------------
// dlhd id -> { master, media, streamInf, expiresMs, resolvedAt }
const _cache = new Map();
const _inflight = new Map();   // dlhd id -> Promise (single-flight)

function _baseHost() {
    try { return new URL(cfg.DLHD_BASE).host; } catch { return 'dlhd.pk'; }
}

function _headers(referer) {
    const h = { 'User-Agent': cfg.PROXY_USER_AGENT, 'Accept': '*/*' };
    if (referer) h.Referer = referer;
    return h;
}

// undici's fetch throws a bare "fetch failed" and buries the REAL reason (DNS, refused,
// TLS, …) in err.cause[.cause]. Surface it so the logs say *why* — the difference between
// "ENOTFOUND" (a filtering DNS is blocking the sketchy dlhd/CDN domains — the usual cause on
// a Pi-hole/NextDNS/AdGuard network) and "ECONNREFUSED"/timeout (the host blocks our egress IP).
function _causeStr(err) {
    const c = err && err.cause;
    if (!c) return (err && err.message) || String(err);
    const inner = c.cause ? ` (${c.cause.code || c.cause.message || c.cause})` : '';
    return `${c.code || c.message || c}${inner}`;
}

async function _get(url, referer, timeoutMs, attempt = 0) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs || cfg.DLHD_RESOLVE_TIMEOUT_MS);
    let host = url; try { host = new URL(url).host; } catch { /* keep url */ }
    try {
        const resp = await fetch(url, { headers: _headers(referer), redirect: 'follow', signal: controller.signal });
        const text = await resp.text();
        if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${host}`);
        return { text, finalUrl: resp.url || url };
    } catch (err) {
        const isHttp = /^HTTP \d/.test(err && err.message || '');
        // One retry for a transient network blip (not for HTTP status errors or client aborts).
        if (attempt < 1 && !isHttp && err && err.name !== 'AbortError') {
            clearTimeout(timer);
            await new Promise((r) => setTimeout(r, 600));
            return _get(url, referer, timeoutMs, attempt + 1);
        }
        if (isHttp) throw err;
        if (err && err.name === 'AbortError') {
            throw new Error(`timeout after ${(timeoutMs || cfg.DLHD_RESOLVE_TIMEOUT_MS) / 1000}s reaching ${host}`);
        }
        throw new Error(`cannot reach ${host}: ${_causeStr(err)}`);
    } finally {
        clearTimeout(timer);
    }
}

/** Find the embed-player URL inside stream-N.php (host rotates; we read it fresh). */
function _extractEmbedUrl(streamPageText, dlhdId) {
    const baseHost = _baseHost();
    // All absolute *.php?id=<id> links; the embed is the one NOT on dlhd's own host.
    const re = new RegExp(`https?://[^\\s"'<>]+\\.php\\?id=${dlhdId}\\b[^\\s"'<>]*`, 'gi');
    const seen = new Set();
    for (const m of streamPageText.matchAll(re)) {
        const u = m[0];
        if (seen.has(u)) continue;
        seen.add(u);
        let host = '';
        try { host = new URL(u).host; } catch { continue; }
        if (host && host !== baseHost) return u;   // off-host = the embed player
    }
    // Fallback: an explicit embed host from config.
    if (cfg.DLHD_EMBED_HOST) {
        return `https://${cfg.DLHD_EMBED_HOST}/premiumtv/daddy3.php?id=${dlhdId}`;
    }
    return null;
}

/** Decode the embed page's atob() blobs and return the first that is an .m3u8 URL. */
function _extractMasterUrl(embedText) {
    const re = /atob\(\s*['"]([A-Za-z0-9+/=]+)['"]\s*\)/g;
    for (const m of embedText.matchAll(re)) {
        let decoded = '';
        try { decoded = Buffer.from(m[1], 'base64').toString('utf-8'); } catch { continue; }
        if (/^https?:\/\/\S+\.m3u8(\?|$)/i.test(decoded)) return decoded.trim();
    }
    return null;
}

/** Pull the unix-seconds expiry out of a tokenized URL (master or media). */
function _expiryMsFromUrl(url) {
    const m = /[?&]expires=(\d{9,13})\b/.exec(url);
    if (!m) return 0;
    let n = parseInt(m[1], 10);
    if (n < 1e12) n *= 1000;     // seconds -> ms
    return n;
}

/** Parse a master playlist: capture the STREAM-INF line + resolve the child media URL. */
function _parseMaster(masterText, masterUrl) {
    const lines = masterText.split('\n').map((l) => l.replace(/\r$/, ''));
    let streamInf = null;
    for (let i = 0; i < lines.length; i++) {
        const t = lines[i].trim();
        if (t.startsWith('#EXT-X-STREAM-INF')) {
            streamInf = t;
            // next non-blank, non-comment line is the variant (media) URI
            for (let j = i + 1; j < lines.length; j++) {
                const c = lines[j].trim();
                if (!c || c.startsWith('#')) continue;
                try { return { streamInf, media: new URL(c, masterUrl).toString() }; } catch { return { streamInf, media: null }; }
            }
        }
    }
    // No STREAM-INF -> this IS a media playlist already.
    if (/#EXTINF/.test(masterText)) return { streamInf: null, media: masterUrl };
    return { streamInf, media: null };
}

/** The actual resolve chain (no caching here — getResolved() wraps with cache/single-flight). */
async function _doResolve(dlhdId) {
    const t0 = Date.now();
    const streamPage = `${cfg.DLHD_BASE}/stream/stream-${dlhdId}.php`;
    const s = await _get(streamPage, `${cfg.DLHD_BASE}/watch.php?id=${dlhdId}`);
    const embedUrl = _extractEmbedUrl(s.text, dlhdId);
    if (!embedUrl) throw new Error(`no embed url in stream-${dlhdId}.php`);

    const e = await _get(embedUrl, `${cfg.DLHD_BASE}/`);
    const master = _extractMasterUrl(e.text);
    if (!master) throw new Error(`no m3u8 in embed for id=${dlhdId} (${new URL(embedUrl).host})`);

    const mResp = await _get(master, `${cfg.DLHD_BASE}/`);
    const { streamInf, media } = _parseMaster(mResp.text, mResp.finalUrl);
    if (!media) throw new Error(`no media playlist in master for id=${dlhdId}`);

    const expiresMs = _expiryMsFromUrl(media) || _expiryMsFromUrl(master)
        || (Date.now() + 50 * 60 * 1000);  // assume ~50min if untokenized
    const entry = { master, media, streamInf, expiresMs, resolvedAt: Date.now() };
    log.info(`resolved id=${dlhdId} in ${Date.now() - t0}ms via ${new URL(embedUrl).host} `
        + `(expires ${new Date(expiresMs).toISOString()}, cdn ${new URL(media).host})`);
    return entry;
}

/**
 * Resolve (cached) a dlhd id to { master, media, streamInf, expiresMs }. Re-resolves when the
 * cached token is within DLHD_TOKEN_MARGIN_MS of expiry. Single-flight: concurrent callers for
 * the same id share one in-flight resolve. Throws on resolve failure (no cache entry to serve).
 */
async function getResolved(dlhdId) {
    const cached = _cache.get(dlhdId);
    if (cached && cached.expiresMs - Date.now() > cfg.DLHD_TOKEN_MARGIN_MS) return cached;

    if (_inflight.has(dlhdId)) return _inflight.get(dlhdId);
    const p = _doResolve(dlhdId)
        .then((entry) => { _cache.set(dlhdId, entry); _inflight.delete(dlhdId); return entry; })
        .catch((err) => {
            _inflight.delete(dlhdId);
            // If we still hold a not-yet-expired entry, serve it rather than failing outright.
            if (cached && cached.expiresMs > Date.now()) {
                log.warn(`re-resolve id=${dlhdId} failed (${err.message}); serving prior token`);
                return cached;
            }
            throw err;
        });
    _inflight.set(dlhdId, p);
    return p;
}

// --- media playlist micro-cache (collapses the ~every-5s live re-poll) ------
const _mediaCache = new Map();   // dlhd id -> { body, expires }
const _MEDIA_TTL_MS = parseInt(process.env.DLHD_MEDIA_TTL_MS || '2000', 10);

// --- HTTP endpoints ---------------------------------------------------------

function _sendManifest(res, body) {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.end(body);
}

async function _handleMaster(res, dlhdId) {
    const r = await getResolved(dlhdId);
    const base = proxy.publicBase();
    const mediaUrl = `${base}${PREFIX}${dlhdId}/media.m3u8`;
    // Re-emit the upstream STREAM-INF (codecs/bw/res) so ExoPlayer keeps its track metadata,
    // but point the variant at OUR re-resolving media endpoint instead of the expiring CDN url.
    const streamInf = r.streamInf
        || '#EXT-X-STREAM-INF:BANDWIDTH=4520000,RESOLUTION=1280x720,CODECS="avc1.640029,mp4a.40.2"';
    _sendManifest(res, `#EXTM3U\n${streamInf}\n${mediaUrl}\n`);
}

async function _handleMedia(req, res, dlhdId) {
    const hit = _mediaCache.get(dlhdId);
    if (hit && hit.expires > Date.now()) return _sendManifest(res, hit.body);

    const r = await getResolved(dlhdId);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.DLHD_RESOLVE_TIMEOUT_MS);
    const onClose = () => controller.abort();
    req.on('close', onClose);
    try {
        const resp = await fetch(r.media, { headers: _headers(`${cfg.DLHD_BASE}/`), redirect: 'follow', signal: controller.signal });
        const text = await resp.text();
        if (!resp.ok || !/#EXTM3U/.test(text)) throw new Error(`bad media playlist (HTTP ${resp.status})`);
        // Route every segment/key/map through the EXISTING /proxy (root-relative). Segments aren't
        // header-locked, but proxying keeps the client on our host and reuses the proxy's Range/
        // error handling + manifest micro-cache.
        const rewritten = proxy.rewriteManifest(text, resp.url || r.media);
        _mediaCache.set(dlhdId, { body: rewritten, expires: Date.now() + _MEDIA_TTL_MS });
        _sendManifest(res, rewritten);
    } finally {
        clearTimeout(timer);
        req.off('close', onClose);
    }
}

/** Route handler for /dlhd/<id>/(master|media).m3u8. Returns true if it handled the request. */
async function handle(req, res) {
    const path = req.url.split('?')[0];
    const m = /^\/dlhd\/(\d+)\/(master|media)\.m3u8$/.exec(path);
    if (!m) { res.statusCode = 400; res.end('bad dlhd path'); return; }
    const dlhdId = parseInt(m[1], 10);
    const kind = m[2];
    try {
        if (!proxy.publicBase()) { res.statusCode = 503; res.end('proxy base unknown'); return; }
        if (kind === 'master') return await _handleMaster(res, dlhdId);
        return await _handleMedia(req, res, dlhdId);
    } catch (err) {
        if (err && err.name === 'AbortError') { if (!res.writableEnded) res.destroy(); return; }
        log.warn(`dlhd ${kind} id=${dlhdId} failed: ${err.message}`);
        if (!res.headersSent && !res.writableEnded) {
            res.statusCode = 502;
            try { res.end(`dlhd error: ${err.message}`); } catch { /* client gone */ }
        }
    }
}

/** Absolute URL handed to the player for a channel's dlhd stream (the master endpoint). */
function masterUrlFor(dlhdId) {
    const base = proxy.publicBase();
    return base ? `${base}${PREFIX}${dlhdId}/master.m3u8` : null;
}

/** Diagnostics for /debug/dlhd. */
async function debugResolve(dlhdId) {
    const r = await getResolved(dlhdId);
    return {
        dlhdId,
        master: r.master,
        media: r.media,
        cdnHost: (() => { try { return new URL(r.media).host; } catch { return null; } })(),
        streamInf: r.streamInf,
        expires: new Date(r.expiresMs).toISOString(),
        ttlSeconds: Math.round((r.expiresMs - Date.now()) / 1000),
        resolvedAt: new Date(r.resolvedAt).toISOString(),
    };
}

module.exports = {
    PREFIX,
    handle,
    dlhdIdForRoster,
    mappedCount,
    masterUrlFor,
    getResolved,
    debugResolve,
};
