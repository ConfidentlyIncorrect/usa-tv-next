// epg.js — XMLTV EPG fetcher/parser + now-playing lookups, with disk-cache resilience.
//
// Ported from the standalone EPG addon, with three changes for the combined server:
//   1. Config/logging come from the shared modules.
//   2. The 188 MB download gets its own (generous) timeout so it isn't aborted.
//   3. The parsed programmes for the channels we actually use can be persisted to disk
//      (persistCache) and reloaded on a cold start when epg.pw is unreachable (loadCache).
//      Cached programmes carry absolute start/stop times, so now-playing still computes
//      correctly from a cache that is up to ~a day old.

const fs = require('fs');
const path = require('path');
const { gunzipSync } = require('zlib');

const cfg = require('./config');
const log = require('./log')('EPG');
const sd = require('./sd');

const REFRESH_INTERVAL_MS = cfg.EPG_REFRESH_MS;
const EPG_CACHE_FILE = path.join(cfg.CACHE_DIR, 'epg-cache.json');

let channels = new Map();     // epgId -> { name, icon }
let programmes = new Map();   // epgId -> [{ start:Date, stop:Date|null, title, desc, categories, icon }]
let lastFetch = 0;
let fetching = false;

// --- parsing ---------------------------------------------------------------

function parseDateTime(str) {
    // XMLTV format: "20260315080003 +0000" or "20260315170000 -0400"
    if (!str) return null;
    const trimmed = String(str).trim();
    const digits = trimmed.substring(0, 14).padEnd(14, '0');
    const y = digits.slice(0, 4);
    const m = digits.slice(4, 6);
    const d = digits.slice(6, 8);
    const h = digits.slice(8, 10);
    const min = digits.slice(10, 12);
    const s = digits.slice(12, 14);
    const tzMatch = trimmed.substring(14).trim().match(/^([+-]\d{2})(\d{2})$/);
    const tz = tzMatch ? `${tzMatch[1]}:${tzMatch[2]}` : '+00:00';
    const date = new Date(`${y}-${m}-${d}T${h}:${min}:${s}${tz}`);
    return isNaN(date.getTime()) ? null : date;
}

async function downloadEpg(url = cfg.EPG_URL) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.EPG_FETCH_TIMEOUT_MS);
    try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const contentType = response.headers.get('content-type') || '';
        const buf = Buffer.from(await response.arrayBuffer());
        if (url.endsWith('.gz') || contentType.includes('gzip')) {
            return gunzipSync(buf).toString('utf-8');
        }
        return buf.toString('utf-8');
    } finally {
        clearTimeout(timer);
    }
}

// --- streaming XMLTV scanner (dependency-free, low-memory) ------------------
// XMLTV is a flat, regular document: all <channel> elements first, then all <programme>
// elements. We scan the raw string element-by-element with indexOf/slice instead of
// building a full DOM (fast-xml-parser's tree for a 188 MB file is ~1 GB — the OOM that
// crashed the periodic refresh). Only ONE element's substring is live at a time, and we
// keep programmes ONLY for the channels the roster actually matched, so peak memory is
// the raw string (~188 MB) + ~250 channels' schedules instead of every US channel's.

const _ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", '#34': '"' };
function decodeEntities(s) {
    if (!s || s.indexOf('&') === -1) return s;
    return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, e) => {
        if (e[0] === '#') {
            const cp = e[1] === 'x' || e[1] === 'X'
                ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
            return Number.isFinite(cp) ? String.fromCodePoint(cp) : m;
        }
        return _ENT[e] !== undefined ? _ENT[e] : m;
    });
}

function _attr(openTag, name) {
    const m = openTag.match(new RegExp(`${name}="([^"]*)"`));
    return m ? m[1] : '';
}

// Inner text of the FIRST <tag ...>...</tag> in block (CDATA-aware, entity-decoded).
function _tagText(block, tag) {
    const m = block.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`));
    if (!m) return '';
    let inner = m[1];
    const cdata = inner.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
    if (cdata) inner = cdata[1];
    return decodeEntities(inner.trim());
}

function _allTagText(block, tag) {
    const out = [];
    const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'g');
    let m;
    while ((m = re.exec(block)) !== null) {
        const t = decodeEntities(m[1].trim());
        if (t) out.push(t);
    }
    return out;
}

/** Scan ALL <channel> definitions in the document.
 *  IMPORTANT: do NOT stop at the first <programme>. Some feeds (notably i.mjh.nz's Plex/
 *  Samsung/Roku/Pluto guides) INTERLEAVE elements — <channel>, then THAT channel's
 *  <programme>s, then the next <channel>, and so on — instead of listing every <channel>
 *  up front. The old "stop at first <programme>" optimization dropped every channel after
 *  the first in those feeds (e.g. AsianCrush, RetroCrush, Dark Matter TV, Hi-YAH!, Stadium,
 *  TMZ, … — ~40 FAST channels), so they never matched the roster. Scanning the whole string
 *  for "<channel " is safe: that exact token never occurs inside a <programme channel="...">
 *  tag (there it's preceded by a space, not "<"), and indexOf over even the 188 MB epg.pw
 *  feed is a single fast linear pass. */
function parseChannels(xml) {
    const out = new Map();
    let i = xml.indexOf('<channel ');
    while (i !== -1) {
        const end = xml.indexOf('</channel>', i);
        if (end === -1) break;
        const block = xml.slice(i, end);
        const open = block.slice(0, block.indexOf('>') + 1);
        const id = _attr(open, 'id');
        if (id) {
            const name = _tagText(block, 'display-name');
            const iconM = block.match(/<icon\b[^>]*\bsrc="([^"]*)"/);
            if (!out.has(id)) out.set(id, { name: name, icon: iconM ? iconM[1] : '' });
        }
        i = xml.indexOf('<channel ', end);
    }
    return out;
}

/** Scan <programme> elements, keeping ONLY those whose channel is in `keep` (a Set), or
 *  all if `keep` is null. */
function parseProgrammes(xml, keep) {
    const out = new Map();
    let i = xml.indexOf('<programme ');
    while (i !== -1) {
        const end = xml.indexOf('</programme>', i);
        if (end === -1) break;
        const next = xml.indexOf('<programme ', end);
        const open = xml.slice(i, xml.indexOf('>', i) + 1);
        const chId = _attr(open, 'channel');
        if (chId && (!keep || keep.has(chId))) {
            const start = parseDateTime(_attr(open, 'start'));
            if (start) {
                const block = xml.slice(i, end);
                let arr = out.get(chId);
                if (!arr) { arr = []; out.set(chId, arr); }
                arr.push({
                    start,
                    stop: parseDateTime(_attr(open, 'stop')),
                    title: _tagText(block, 'title'),
                    desc: _tagText(block, 'desc'),
                    categories: _allTagText(block, 'category'),
                    icon: (block.match(/<icon\b[^>]*\bsrc="([^"]*)"/) || ['', ''])[1],
                });
            }
        }
        i = next;
    }
    for (const [, progs] of out) progs.sort((a, b) => a.start - b.start);
    return out;
}

// Caller-injected (avoids an epg<->channelMap circular import): returns the Set of EPG ids
// the roster matched, so we parse/keep programmes for only those channels.
let computeRelevantIds = null;
function setRelevantIdsProvider(fn) { computeRelevantIds = fn; }

// XMLTV gap-fill sources, in priority order AFTER Schedules Direct. Each is an id-prefix + a
// list of feed URLs (multiple files are merged under the one prefix). channelMap matches in
// this same order: sd -> pw (epg.pw) -> es (epgshare01).
function xmltvSources() {
    const out = [{ prefix: 'pw', urls: [cfg.EPG_URL] }];
    if (cfg.EPGSHARE_URLS && cfg.EPGSHARE_URLS.length) out.push({ prefix: 'es', urls: cfg.EPGSHARE_URLS });
    return out;
}

/**
 * Fetch + parse the EPG as a MERGED multi-source guide:
 *   • Schedules Direct (when configured) — accurate, feed/timezone-correct — wins for every
 *     channel it covers.
 *   • epg.pw (EPG_URL) fills the gaps SD doesn't cover.
 *   • epgshare01 (EPGSHARE_URLS) is a 3rd tier that fills FAST/streaming channels neither of
 *     the above carries.
 * Channels/programmes from each source are namespaced with an "sd:"/"pw:"/"es:" id prefix so
 * they coexist in one store; channelMap.buildChannelMap() matches in priority order. On total
 * failure KEEP existing in-memory data so the guide degrades gracefully.
 */
async function fetchEPG() {
    if (fetching) {
        log.debug('Fetch already in progress; skipping concurrent call');
        return;
    }
    fetching = true;
    try {
        const useSD = sd.isConfigured();

        // --- Phase 1: load CHANNEL directories from every enabled source (names only) --------
        let sdStations = new Map(); // stationID -> { name, icon }
        if (useSD) {
            try { sdStations = await sd.loadStations(); }
            catch (err) { log.warn(`Schedules Direct stations failed (${err.message}); using XMLTV only this run.`); }
        }

        // For each XMLTV source: download its feed(s) and parse channel defs. Keep the raw text
        // (per feed) so we can stream-parse programmes for only the matched channels in phase 4.
        const xmlSources = []; // { prefix, texts:[string], channels: Map<rawId,{name,icon}> }
        for (const src of xmltvSources()) {
            const texts = [];
            const chans = new Map();
            for (const url of src.urls) {
                try {
                    const t = await log.timed(`EPG download [${src.prefix}] ${url.split('/').pop()}`, () => downloadEpg(url));
                    texts.push(t);
                    for (const [id, m] of parseChannels(t)) if (!chans.has(id)) chans.set(id, m);
                } catch (err) {
                    log.warn(`XMLTV fetch/parse failed for ${url} (${err.message}); skipping this feed.`);
                }
            }
            if (texts.length) xmlSources.push({ prefix: src.prefix, texts, channels: chans });
        }

        if (sdStations.size === 0 && xmlSources.every((s) => s.channels.size === 0)) {
            log.warn(`No EPG channels from any source; retaining ${channels.size} channels / ${programmes.size} schedules already in memory.`);
            return;
        }

        // --- Phase 2: merge channel directories (prefixed) so the matcher sees all sources ---
        const merged = new Map();
        for (const [id, m] of sdStations) merged.set(`sd:${id}`, m);
        for (const s of xmlSources) for (const [id, m] of s.channels) merged.set(`${s.prefix}:${id}`, m);
        channels = merged;

        // --- Phase 3: match roster -> epg ids (priority order; returns prefixed ids) ---------
        const keep = computeRelevantIds ? computeRelevantIds() : null;

        // --- Phase 4: pull programmes per source for the matched ids, then merge -------------
        const newProgrammes = new Map();
        const counts = {};
        const sdIds = keep ? [...keep].filter((k) => k.startsWith('sd:')).map((k) => k.slice(3)) : [];
        if (useSD && sdIds.length) {
            try {
                const sdProgs = await sd.loadSchedules(new Set(sdIds));
                for (const [id, arr] of sdProgs) newProgrammes.set(`sd:${id}`, arr);
                counts.sd = sdProgs.size;
            } catch (err) {
                log.warn(`Schedules Direct schedules failed (${err.message}); SD guides skipped this run.`);
            }
        }
        for (const s of xmlSources) {
            const pfx = `${s.prefix}:`;
            const rawIds = keep ? new Set([...keep].filter((k) => k.startsWith(pfx)).map((k) => k.slice(pfx.length))) : null;
            if (keep && (!rawIds || rawIds.size === 0)) continue;
            let n = 0;
            for (const text of s.texts) {
                for (const [id, arr] of parseProgrammes(text, rawIds)) { newProgrammes.set(`${s.prefix}:${id}`, arr); n++; }
            }
            counts[s.prefix] = n;
        }
        programmes = newProgrammes;
        lastFetch = Date.now();

        const srcSummary = Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ') || 'none';
        log.info(`EPG merged: ${channels.size} channels (${sdStations.size} SD`
            + xmlSources.map((s) => ` + ${s.channels.size} ${s.prefix}`).join('')
            + `); ${programmes.size} with schedules (${srcSummary})`);
        if (keep) persistCache(keep);
    } catch (err) {
        log.warn(`Fetch error: ${err.message}. Retaining ${channels.size} channels / ${programmes.size} schedules already in memory.`);
    } finally {
        fetching = false;
    }
}

// --- disk cache (resilience) ----------------------------------------------

/**
 * Persist the programmes + channel names for the given set of EPG channel ids
 * (the ones the roster actually matched) so a future cold start can serve guide
 * data even if epg.pw is unreachable. Keeps the file small by storing only
 * relevant channels. Dates are written as ISO strings.
 */
function persistCache(relevantEpgIds) {
    try {
        const ids = relevantEpgIds instanceof Set ? relevantEpgIds : new Set(relevantEpgIds || []);
        const outChannels = {};
        const outProgrammes = {};
        let kept = 0;
        for (const id of ids) {
            const meta = channels.get(id);
            if (meta) outChannels[id] = meta;
            const progs = programmes.get(id);
            if (progs) {
                outProgrammes[id] = progs.map((p) => ({
                    start: p.start ? p.start.toISOString() : null,
                    stop: p.stop ? p.stop.toISOString() : null,
                    title: p.title,
                    desc: p.desc,
                    categories: p.categories,
                    icon: p.icon,
                }));
                kept++;
            }
        }
        fs.mkdirSync(cfg.CACHE_DIR, { recursive: true });
        const tmp = `${EPG_CACHE_FILE}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify({ savedAt: Date.now(), channels: outChannels, programmes: outProgrammes }), 'utf-8');
        fs.renameSync(tmp, EPG_CACHE_FILE);
        log.info(`EPG cache persisted: ${kept} channels with schedules -> ${EPG_CACHE_FILE}`);
    } catch (err) {
        log.warn(`Could not persist EPG cache: ${err.message}`);
    }
}

/** Load the persisted EPG cache into memory (used as a cold-start baseline). */
function loadCache() {
    try {
        const data = JSON.parse(fs.readFileSync(EPG_CACHE_FILE, 'utf-8'));
        const newChannels = new Map(Object.entries(data.channels || {}));
        const newProgrammes = new Map();
        for (const [id, progs] of Object.entries(data.programmes || {})) {
            newProgrammes.set(id, progs.map((p) => ({
                start: p.start ? new Date(p.start) : null,
                stop: p.stop ? new Date(p.stop) : null,
                title: p.title,
                desc: p.desc,
                categories: p.categories || [],
                icon: p.icon || '',
            })));
        }
        channels = newChannels;
        programmes = newProgrammes;
        lastFetch = data.savedAt || 0; // intentionally old so isStale() triggers a refresh
        log.info(`EPG cache loaded: ${newChannels.size} channels, ${newProgrammes.size} schedules (savedAt ${data.savedAt ? new Date(data.savedAt).toISOString() : 'unknown'})`);
        return true;
    } catch (err) {
        if (err.code !== 'ENOENT') log.warn(`Could not load EPG cache: ${err.message}`);
        return false;
    }
}

// --- lookups ---------------------------------------------------------------

// offsetHours: shift "now" to align the matched EPG feed with the channel's actual stream
// feed (e.g. a West-coast stream mapped to the East-feed guide -> offsetHours=3 looks back
// 3h). Default 0 (East feed / live channels, where the absolute schedule already matches).
function _now(offsetHours) {
    const t = Date.now() - (offsetHours || 0) * 3600000;
    return new Date(t);
}

// The current programme is the one with the GREATEST start <= now (NOT the first match):
// programmes are sorted ascending, so `.find(start<=now && (!stop||stop>now))` used to return
// the EARLIEST start when entries lacked a `stop` — surfacing a programme from hours/days ago.
// Here we take the last-started programme, then validate it really covers `now` using its
// explicit stop, else the next programme's start, else a +6h cap (so a stale/duration-less
// entry can't masquerade as "now" indefinitely).
function getNowPlaying(epgChannelId, offsetHours = 0) {
    const progs = programmes.get(epgChannelId);
    if (!progs || !progs.length) return null;
    const now = _now(offsetHours);
    let idx = -1;
    for (let i = 0; i < progs.length; i++) {
        if (progs[i].start <= now) idx = i; else break;
    }
    if (idx === -1) return null;
    const p = progs[idx];
    const nextStart = progs[idx + 1] && progs[idx + 1].start;
    const effectiveStop = p.stop || nextStart || new Date(p.start.getTime() + 6 * 3600000);
    return effectiveStop > now ? p : null;
}

function getUpNext(epgChannelId, offsetHours = 0) {
    const progs = programmes.get(epgChannelId);
    if (!progs) return null;
    const now = _now(offsetHours);
    return progs.find((p) => p.start > now) || null;
}

function getDaySchedule(epgChannelId, offsetHours = 0) {
    const progs = programmes.get(epgChannelId);
    if (!progs) return [];
    const now = _now(offsetHours);
    const endOfDay = new Date(now);
    endOfDay.setHours(23, 59, 59, 999);
    return progs.filter((p) => p.start <= endOfDay && (!p.stop || p.stop > now));
}

/**
 * A compact upcoming-schedule slice for a channel, as ABSOLUTE wall-clock times the CLIENT can
 * recompute now/next from on its own ticking clock (so the guide panel stays live and is immune
 * to stream-response caching — a slightly stale cached response still contains "now" because the
 * window reaches ~18h forward). Times are shifted by +offsetHours so the client compares against
 * its real clock. Returns [{ s:ISO, e:ISO|null, t:title }] from now-1h to now+18h, capped.
 */
function getGuideWindow(epgChannelId, offsetHours = 0, maxEntries = 48, withDesc = false) {
    const progs = programmes.get(epgChannelId);
    if (!progs || !progs.length) return [];
    const shiftMs = (offsetHours || 0) * 3600000;
    const realNow = Date.now();
    const from = realNow - 1 * 3600000;
    const to = realNow + 18 * 3600000;
    const out = [];
    for (const p of progs) {
        if (!p.start) continue;
        const s = p.start.getTime() + shiftMs;               // shift feed time -> client wall clock
        const e = p.stop ? p.stop.getTime() + shiftMs : null;
        if ((e || s) < from || s > to) continue;             // outside the window
        const entry = { s: new Date(s).toISOString(), e: e ? new Date(e).toISOString() : null, t: p.title || '' };
        if (withDesc && p.desc) entry.d = p.desc;            // detail screen wants synopsis; stream panel doesn't
        out.push(entry);
        if (out.length >= maxEntries) break;
    }
    return out;
}

function getEPGChannels() { return channels; }
function isStale() { return Date.now() - lastFetch > REFRESH_INTERVAL_MS; }

async function ensureLoaded() {
    if (channels.size === 0 || isStale()) await fetchEPG();
}

function getStatus() {
    return {
        channels: channels.size,
        schedules: programmes.size,
        lastFetch: lastFetch ? new Date(lastFetch).toISOString() : null,
        stale: isStale(),
    };
}

module.exports = {
    fetchEPG,
    ensureLoaded,
    setRelevantIdsProvider,
    getNowPlaying,
    getUpNext,
    getDaySchedule,
    getGuideWindow,
    getEPGChannels,
    persistCache,
    loadCache,
    getStatus,
};
