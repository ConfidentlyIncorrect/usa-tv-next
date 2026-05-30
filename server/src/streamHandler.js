// streamHandler.js — serve playable streams for a channel.
//
// This is the capability the standalone EPG addon lacked (it deferred streams to the
// separate static USATV addon). The combined addon now owns the `stream` resource, so
// all stream resolution logic lives in the data layer (data.getStreams), which walks:
//   inline roster streams -> in-memory cache -> bundled local file -> lazy GitHub fetch.
//
// We pass through the stream entries faithfully (url, name, description, behaviorHints)
// and ensure notWebReady is set so clients treat them as external/live URLs.

const cfg = require('./config');
const data = require('./data');
const log = require('./log')('StreamHandler');
const proxy = require('./proxy');

// --- provider policy (blocklist + priority) --------------------------------

function isBlocked(url) {
    const u = (url || '').toLowerCase();
    return cfg.STREAM_BLOCKLIST_HOSTS.some((h) => u.includes(h));
}

// Providers that 302-redirect to a tokenized / IP-bound / load-balanced host (the
// segment host + token change per request). A naive player refreshing a live playlist
// gets a different host/token each time and 404s its segments -> infinite buffer.
// Proxying gives the player ONE stable URL while the server handles the redirect, token
// and segment rewriting from a single consistent IP. tvpass.org is our PRIMARY provider
// and now uses this scheme (-> *.thetvapp.to), so it MUST be proxied to play.
const REDIRECT_PROVIDERS = ['tvpass.org', 'thetvapp.to', 'dai.google.com'];

// A "fragile" upstream the native player often can't play directly: cleartext HTTP,
// raw-IP host, odd port, a cors-proxy, a URL shortener, a redirect/tokenized provider,
// or an operator-forced host. These are routed through our proxy; clean direct-HTTPS
// streams are left alone.
function isFragile(url) {
    try {
        const u = new URL(url);
        const host = u.hostname;
        const port = u.port ? parseInt(u.port, 10) : (u.protocol === 'https:' ? 443 : 80);
        const lo = url.toLowerCase();
        return (
            u.protocol === 'http:'
            || /^\d+\.\d+\.\d+\.\d+$/.test(host)
            || (port !== 80 && port !== 443)
            || host.includes('proxy')
            || host.includes('jmp2')
            || REDIRECT_PROVIDERS.some((h) => host.endsWith(h) || host.includes(h))
            // operator-forced hosts (alive-but-flaky SSAI feeds, e.g. xumo/nbcuni)
            || cfg.PROXY_FORCE_HOSTS.some((h) => lo.includes(h))
        );
    } catch {
        return false;
    }
}

function normalizeStream(s) {
    // Faithful pass-through with defensive defaults. The harvester writes entries shaped
    // { url, behaviorHints:{notWebReady:true, proxyHeaders}, name, description }.
    const behaviorHints = Object.assign({ notWebReady: true }, s.behaviorHints || {});
    let url = s.url;
    // When the proxy is active (we know our public base), route fragile upstreams through
    // our HTTPS /proxy so the client gets a clean URL and segments are fetched server-side
    // with proper headers.
    if (proxy.proxyActive() && isFragile(url)) {
        url = proxy.proxyUrl(url);
        // The proxy already injects headers upstream; the client talks plain HTTPS to us.
        delete behaviorHints.proxyHeaders;
    }
    const out = { url, behaviorHints };
    if (s.name) out.name = s.name;
    if (s.title) out.title = s.title;
    if (s.description) out.description = s.description;
    return out;
}

async function handleStream({ type, id }) {
    log.debug(`stream request: type=${type} id=${id}`);
    if (type !== 'tv' || !id || !id.startsWith('ustv')) {
        log.debug(`Ignoring unsupported stream request (type=${type}, id=${id})`);
        return { streams: [] };
    }

    try {
        const raw = await data.getStreams(id);
        const valid = (raw || []).filter((s) => s && s.url);
        // Drop blocklisted providers (e.g. Pluto TV — no longer accessible).
        // PRESERVE the data file order: the harvester's regional resolver already orders
        // each channel's feeds (local/Denver > National > ... ; video before audio), so
        // re-sorting here by provider would undo that. Only fall back to provider order
        // if a stream somehow lacks the harvester ordering (no-op for normal data).
        const allowed = valid.filter((s) => !isBlocked(s.url));
        const dropped = valid.length - allowed.length;
        const streams = allowed.map(normalizeStream);
        log.debug(`Returning ${streams.length} stream(s) for ${id}`
            + (dropped ? ` (dropped ${dropped} blocklisted)` : '')
            + ` [top: ${streams[0] ? streams[0].name : 'none'}]`);
        return { streams, cacheMaxAge: cfg.RESPONSE_CACHE_SECS };
    } catch (err) {
        log.error(`Error resolving streams for ${id}: ${err.message}`);
        return { streams: [], cacheMaxAge: 60 };
    }
}

module.exports = { handleStream };
