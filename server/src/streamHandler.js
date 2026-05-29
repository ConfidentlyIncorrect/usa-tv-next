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

// --- provider policy (blocklist + priority) --------------------------------

function isBlocked(url) {
    const u = (url || '').toLowerCase();
    return cfg.STREAM_BLOCKLIST_HOSTS.some((h) => u.includes(h));
}

function normalizeStream(s) {
    // Faithful pass-through with defensive defaults. The harvester writes entries shaped
    // { url, behaviorHints:{notWebReady:true}, name, description }.
    const behaviorHints = Object.assign({ notWebReady: true }, s.behaviorHints || {});
    const out = { url: s.url, behaviorHints };
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
