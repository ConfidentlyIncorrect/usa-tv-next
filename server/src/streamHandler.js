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
const epg = require('./epg');
const channelMap = require('./channelMap');
const log = require('./log')('StreamHandler');
const proxy = require('./proxy');

// --- EPG guide string (for the NuvioTV custom fork's focus-reactive left panel) ------------
// We attach the CHANNEL's now/next to each stream as a non-standard `epg` field. The fork's
// stream-selection screen shows the focused stream's `epg` in its left panel (falling back to
// `description`); standard Stremio clients ignore the unknown field. We use one channel-level
// guide for all of a channel's streams (they share a feed), so the stream/provider list is
// untouched. Read-only against in-memory EPG — never forces a fetch on the playback path.
function formatTime(date) {
    if (!date) return '';
    return date.toLocaleTimeString('en-US', {
        hour: 'numeric', minute: '2-digit', hour12: true, timeZone: cfg.TZ,
    });
}

function buildStreamGuide(now, next) {
    const lines = [];
    if (now) {
        const range = now.stop ? `${formatTime(now.start)} - ${formatTime(now.stop)}` : formatTime(now.start);
        lines.push(`▶ NOW · ${range}`);
        if (now.title) lines.push(now.title);
    }
    if (next) {
        if (lines.length) lines.push('');
        lines.push(`⏭ NEXT · ${formatTime(next.start)}`);
        if (next.title) lines.push(next.title);
    }
    return lines.join('\n');
}

// --- provider policy (blocklist + priority) --------------------------------

function isBlocked(url) {
    const u = (url || '').toLowerCase();
    return cfg.STREAM_BLOCKLIST_HOSTS.some((h) => u.includes(h));
}

// Hosts that MUST always be proxied (when the proxy is active), for two reasons:
//   • redirect/tokenized: 302 to a tokenized/IP-bound/load-balanced host whose token or
//     SSAI session is minted per-request, so a naive player's playlist refresh mints a
//     NEW session every poll and its segments 404 -> infinite buffer. Covers:
//       - tvpass.org -> *.thetvapp.to (expiring token);
//       - dai.google.com -> /stream/<session> (Google DAI, CBS);
//       - *.a.run.app  -> dai.google.com (the "amd-mediator" SSAI front for CBS Sports
//         Golazo: 302s into a fresh DAI session each request, so direct playback buffers
//         forever; proxying pins the whole redirect+session chain to one server IP).
//   • SSAI ad-stitching session: feeds that splice ads server-side mint a per-request
//     session and play a second of black then EXIT (or buffer) when hit directly. Proxying
//     normalizes the manifest/session path and they play. Covers:
//       - *.fast.nbcuni.com (XUMO — confirmed on the Telemundo feeds / Universal Crime East);
//       - *.amagi.tv        (amagi SSAI — Vevo, Court TV, Estrella, AccuWeather NOW, … 37 feeds);
//       - *.uplynk.com      (Verizon/EdgeCast SSAI);
//       - *.mediatailor.*   (AWS Elemental MediaTailor SSAI — Documentary+, Red Bull TV).
// The proxy gives the player ONE stable URL and does the redirect/token/segment handling
// from a single consistent server IP.
const FORCE_PROXY_HOSTS = ['tvpass.org', 'thetvapp.to', 'dai.google.com', 'a.run.app',
    'fast.nbcuni.com', 'amagi.tv', 'uplynk.com', 'mediatailor'];

// SSAI ad-stitch markers that live in the URL (not the host): XUMO's per-request ad-session feeds
// are served from generic CloudFront hosts but carry "?ads.xumo_channelId=" — played directly they
// mint a fresh ad session and "black then exit", so pin them through the proxy too (one stable IP).
const FORCE_PROXY_URL_MARKERS = ['ads.xumo_channelid'];

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
            || FORCE_PROXY_HOSTS.some((h) => host.endsWith(h) || host.includes(h))
            // SSAI markers in the URL/query (e.g. XUMO ads.xumo_channelId on plain CloudFront hosts)
            || FORCE_PROXY_URL_MARKERS.some((m) => lo.includes(m))
            // operator-forced hosts (alive-but-flaky SSAI feeds, e.g. xumo/nbcuni)
            || cfg.PROXY_FORCE_HOSTS.some((h) => lo.includes(h))
        );
    } catch {
        return false;
    }
}

// Quality rank from the stream's display name "{Channel} ({FHD|HD|SD|Audio})": lower = better.
// Unknown-quality video sits between SD and Audio; Audio is always last.
function qualityRank(name) {
    const m = (name || '').match(/\((FHD|HD|SD|Audio)\)/i);
    if (!m) return 3;
    const q = m[1].toUpperCase();
    return q === 'FHD' ? 0 : q === 'HD' ? 1 : q === 'SD' ? 2 : 4;
}

function isPriorityHost(url) {
    const u = (url || '').toLowerCase();
    return cfg.STREAM_PRIORITY_HOSTS.some((h) => u.includes(h));
}

// Quality-first ordering (STREAM_SORT_QUALITY): primary = quality, tiebreaker = priority provider
// (tvpass) within the same quality tier, final tiebreaker = the harvester's original order (stable).
// Surfaces the best-quality feed — usually the one carrying WebVTT subtitles — as the default.
function orderStreams(streams) {
    if (!cfg.STREAM_SORT_QUALITY) return streams;
    return streams
        .map((s, i) => ({ s, i }))
        .sort((a, b) => (qualityRank(a.s.name) - qualityRank(b.s.name))
            || ((isPriorityHost(a.s.url) ? 0 : 1) - (isPriorityHost(b.s.url) ? 0 : 1))
            || (a.i - b.i))
        .map((x) => x.s);
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
        // Drop blocklisted providers (e.g. Pluto TV — no longer accessible), then order by
        // QUALITY (FHD>HD>SD>Audio) with the priority provider (tvpass) as a same-tier tiebreaker
        // and the harvester's original (regional) order kept as the final, stable tiebreaker. This
        // makes the best-quality feed — usually the one carrying WebVTT subtitles — the default.
        // Set STREAM_SORT=data to keep the raw harvester order instead (orderStreams is then a no-op).
        const allowed = valid.filter((s) => !isBlocked(s.url));
        const dropped = valid.length - allowed.length;
        const streams = orderStreams(allowed).map(normalizeStream);

        // Attach the channel's guide to EVERY stream so the fork's left panel is formatted
        // CONSISTENTLY for ALL channels — same `epg` slot every time, only the data inside
        // changes. EPG now/next where available; otherwise a channel description (genre · Live
        // TV) so it's never blank and never falls back to the bare stream/provider label.
        const epgId = channelMap.getEPGChannelId(id);
        const off = epgId ? channelMap.getEPGOffset(id) : 0;
        let guide = '';
        let schedule = null; // [{s,e,t}] absolute times -> client computes live now/next & ticks
        if (epgId) {
            guide = buildStreamGuide(epg.getNowPlaying(epgId, off), epg.getUpNext(epgId, off));
            schedule = epg.getGuideWindow(epgId, off);
            if (!schedule.length) schedule = null;
        }
        if (!guide) {
            const ch = data.getChannelById(id);
            const genre = ch && ((ch.genres && ch.genres[0]) || ch.genre);
            const desc = `${genre ? `${genre} · ` : ''}Live TV`;
            guide = epgId ? desc : `${desc}\nNo program guide available`;
        }
        // `epg` = the server-rendered now/next string (back-compat + fallback for clients that
        // don't tick). `epgSchedule` = the absolute-time window the NuvioTV fork recomputes
        // now/next from on a 30s clock, so the panel stays live even if this response is cached.
        streams.forEach((s) => { s.epg = guide; if (schedule) s.epgSchedule = schedule; });

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
