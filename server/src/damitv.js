// damitv.js — token-refreshing resolver for vetted persistent Damitv channels.
//
// /papi/extract-url/<source-id> returns a signed, expiring /live-hls/channel/...
// playlist. Keep that token server-side and expose stable HLS on our own host.
// Only manually identity-verified persistent feeds belong in ROSTER_MAP.

const cfg = require('./config');
const log = require('./log')('Damitv');
const proxy = require('./proxy');

const PREFIX = '/damitv/';
const ROSTER_MAP = {
    'ustv-7ef68dfc-3953-489d-9a1e-17473acc1318': 'rally-tv',
};

const _cache = new Map();
const _inflight = new Map();
const _mediaCache = new Map();
const _MEDIA_TTL_MS = parseInt(process.env.DAMITV_MEDIA_TTL_MS || '2000', 10);

function isAllowedSourceId(sourceId) {
    return Object.values(ROSTER_MAP).includes(sourceId);
}

function sourceIdForRoster(rosterId) {
    if (!cfg.DAMITV_ENABLE) return null;
    return ROSTER_MAP[rosterId] || null;
}

function mappedCount() {
    return cfg.DAMITV_ENABLE ? Object.keys(ROSTER_MAP).length : 0;
}

function _headers() {
    return {
        'User-Agent': cfg.PROXY_USER_AGENT,
        'Accept': '*/*',
        'Referer': `${cfg.DAMITV_BASE}/`,
    };
}

async function _get(url, timeoutMs = cfg.DAMITV_RESOLVE_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const resp = await fetch(url, { headers: _headers(), redirect: 'follow', signal: controller.signal });
        const text = await resp.text();
        if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${new URL(url).host}`);
        return { text, finalUrl: resp.url || url };
    } catch (err) {
        if (controller.signal.aborted || (err && err.name === 'AbortError')) {
            throw new Error(`timeout reaching ${new URL(url).host}`);
        }
        throw err;
    } finally {
        clearTimeout(timer);
    }
}

function _expiryMs(url) {
    try {
        const value = new URL(url).searchParams.get('e');
        if (!value) return 0;
        let n = parseInt(value, 10);
        if (n < 1e12) n *= 1000;
        return Number.isFinite(n) ? n : 0;
    } catch {
        return 0;
    }
}

async function _doResolve(sourceId) {
    const t0 = Date.now();
    const endpoint = `${cfg.DAMITV_BASE}/papi/extract-url/${encodeURIComponent(sourceId)}`;
    const response = await _get(endpoint);
    let data;
    try { data = JSON.parse(response.text); } catch { throw new Error('resolver returned non-JSON'); }
    if (!data.success || !data.hlsUrl) throw new Error(data.error || 'resolver returned no HLS URL');

    const media = new URL(data.hlsUrl, cfg.DAMITV_BASE).toString();
    const expiresMs = _expiryMs(media) || (Date.now() + 60 * 60 * 1000);
    const entry = { sourceId, media, expiresMs, resolvedAt: Date.now() };
    log.info(`resolved ${sourceId} in ${Date.now() - t0}ms (expires ${new Date(expiresMs).toISOString()})`);
    return entry;
}

async function getResolved(sourceId) {
    const cached = _cache.get(sourceId);
    if (cached && cached.expiresMs - Date.now() > cfg.DAMITV_TOKEN_MARGIN_MS) return cached;
    if (_inflight.has(sourceId)) return _inflight.get(sourceId);

    const pending = _doResolve(sourceId)
        .then((entry) => { _cache.set(sourceId, entry); _inflight.delete(sourceId); return entry; })
        .catch((err) => {
            _inflight.delete(sourceId);
            if (cached && cached.expiresMs > Date.now()) {
                log.warn(`re-resolve ${sourceId} failed (${err.message}); serving prior token`);
                return cached;
            }
            throw err;
        });
    _inflight.set(sourceId, pending);
    return pending;
}

function _sendManifest(res, body) {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.end(body);
}

async function _handleMaster(res, sourceId) {
    await getResolved(sourceId);
    const media = `${proxy.publicBase()}${PREFIX}${encodeURIComponent(sourceId)}/media.m3u8`;
    _sendManifest(res, '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=8000000,RESOLUTION=1920x1080,CODECS="avc1.640029"\n' + media + '\n');
}

async function _handleMedia(res, sourceId) {
    const hit = _mediaCache.get(sourceId);
    if (hit && hit.expires > Date.now()) return _sendManifest(res, hit.body);

    const resolved = await getResolved(sourceId);
    const response = await _get(resolved.media);
    if (!response.text.startsWith('#EXTM3U') || !response.text.includes('#EXTINF')) {
        throw new Error('upstream did not return a live media playlist');
    }
    const rewritten = proxy.rewriteManifest(
        response.text,
        response.finalUrl,
        `?ref=${proxy.encodeTarget(`${cfg.DAMITV_BASE}/`)}`,
    );
    _mediaCache.set(sourceId, { body: rewritten, expires: Date.now() + _MEDIA_TTL_MS });
    _sendManifest(res, rewritten);
}

async function handle(req, res) {
    if (!cfg.DAMITV_ENABLE) { res.statusCode = 404; res.end('damitv disabled'); return; }
    const match = /^\/damitv\/([a-z0-9-]+)\/(master|media)\.m3u8$/i.exec(req.url.split('?')[0]);
    if (!match) { res.statusCode = 400; res.end('bad damitv path'); return; }
    const sourceId = match[1];
    if (!isAllowedSourceId(sourceId)) { res.statusCode = 404; res.end('unknown damitv channel'); return; }
    try {
        if (!proxy.publicBase()) { res.statusCode = 503; res.end('proxy base unknown'); return; }
        if (match[2] === 'master') return await _handleMaster(res, sourceId);
        return await _handleMedia(res, sourceId);
    } catch (err) {
        log.warn(`${match[2]} ${sourceId} failed: ${err.message}`);
        if (!res.headersSent && !res.writableEnded) { res.statusCode = 502; res.end(`damitv error: ${err.message}`); }
    }
}

function masterUrlFor(sourceId) {
    const base = proxy.publicBase();
    return base ? `${base}${PREFIX}${encodeURIComponent(sourceId)}/master.m3u8` : null;
}

async function debugResolve(sourceId) {
    if (!cfg.DAMITV_ENABLE) throw new Error('damitv disabled');
    if (!isAllowedSourceId(sourceId)) throw new Error('source id is not allowlisted');
    const resolved = await getResolved(sourceId);
    return {
        sourceId,
        mediaHost: new URL(resolved.media).host,
        expires: new Date(resolved.expiresMs).toISOString(),
        ttlSeconds: Math.round((resolved.expiresMs - Date.now()) / 1000),
        resolvedAt: new Date(resolved.resolvedAt).toISOString(),
    };
}

module.exports = {
    PREFIX,
    handle,
    sourceIdForRoster,
    mappedCount,
    masterUrlFor,
    getResolved,
    debugResolve,
};
