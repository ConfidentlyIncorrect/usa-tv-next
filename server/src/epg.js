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

async function downloadEpg() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.EPG_FETCH_TIMEOUT_MS);
    try {
        const response = await fetch(cfg.EPG_URL, { signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const contentType = response.headers.get('content-type') || '';
        const buf = Buffer.from(await response.arrayBuffer());
        if (cfg.EPG_URL.endsWith('.gz') || contentType.includes('gzip')) {
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

/** Scan only the <channel> definitions (the section before the first <programme>). */
function parseChannels(xml) {
    const out = new Map();
    const limit = (() => { const i = xml.indexOf('<programme'); return i === -1 ? xml.length : i; })();
    let i = xml.indexOf('<channel ');
    while (i !== -1 && i < limit) {
        const end = xml.indexOf('</channel>', i);
        if (end === -1) break;
        const block = xml.slice(i, end);
        const open = block.slice(0, block.indexOf('>') + 1);
        const id = _attr(open, 'id');
        if (id) {
            const name = _tagText(block, 'display-name');
            const iconM = block.match(/<icon\b[^>]*\bsrc="([^"]*)"/);
            out.set(id, { name: name, icon: iconM ? iconM[1] : '' });
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

/**
 * Fetch + parse the EPG as a DUAL/MERGED guide:
 *   • Schedules Direct (when configured) provides accurate, feed/timezone-correct guides — it
 *     wins for every channel it covers.
 *   • The XMLTV feed (epg.pw) is ALSO fetched and FILLS THE GAPS — channels SD didn't match
 *     (e.g. FAST/streaming channels SD has no station for) get their guide from epg.pw.
 * Channels/programmes from each source are namespaced with an "sd:"/"pw:" id prefix so they
 * coexist in one store; channelMap.buildChannelMap() matches SD first, then epg.pw for the rest.
 * On total failure KEEP existing in-memory data so the guide degrades gracefully.
 */
async function fetchEPG() {
    if (fetching) {
        log.debug('Fetch already in progress; skipping concurrent call');
        return;
    }
    fetching = true;
    try {
        const useSD = sd.isConfigured();

        // --- Phase 1: load CHANNELS from each enabled source (names only; cheap) -------------
        let sdStations = new Map();   // stationID -> { name, icon }
        if (useSD) {
            try { sdStations = await sd.loadStations(); }
            catch (err) { log.warn(`Schedules Direct stations failed (${err.message}); using XMLTV only this run.`); }
        }

        let xmlText = null;
        let pwChannels = new Map();   // pwId -> { name, icon }
        try {
            log.info(`Fetching XMLTV gap-fill EPG from ${cfg.EPG_URL} ...`);
            xmlText = await log.timed('EPG download', () => downloadEpg());
            log.info(`Scanning XMLTV (${(xmlText.length / 1024 / 1024).toFixed(1)} MB, streaming) ...`);
            pwChannels = parseChannels(xmlText);
        } catch (err) {
            log.warn(`XMLTV fetch/parse failed (${err.message}); ${useSD ? 'using Schedules Direct only this run.' : 'no EPG source available.'}`);
            xmlText = null;
        }

        if (sdStations.size === 0 && pwChannels.size === 0) {
            log.warn(`No EPG channels from any source; retaining ${channels.size} channels / ${programmes.size} schedules already in memory.`);
            return;
        }

        // --- Phase 2: merge channel directories (prefixed) so the matcher sees both ----------
        const merged = new Map();
        for (const [id, m] of sdStations) merged.set(`sd:${id}`, m);
        for (const [id, m] of pwChannels) merged.set(`pw:${id}`, m);
        channels = merged;

        // --- Phase 3: match roster -> epg ids (SD-first; returns prefixed ids) ---------------
        const keep = computeRelevantIds ? computeRelevantIds() : null;

        // --- Phase 4: pull programmes per source for the matched ids, then merge -------------
        const newProgrammes = new Map();
        const sdIds = keep ? [...keep].filter((k) => k.startsWith('sd:')).map((k) => k.slice(3)) : [];
        const pwIds = keep ? new Set([...keep].filter((k) => k.startsWith('pw:')).map((k) => k.slice(3))) : null;

        if (useSD && sdIds.length) {
            try {
                const sdProgs = await sd.loadSchedules(new Set(sdIds));
                for (const [id, arr] of sdProgs) newProgrammes.set(`sd:${id}`, arr);
            } catch (err) {
                log.warn(`Schedules Direct schedules failed (${err.message}); SD guides skipped this run.`);
            }
        }
        if (xmlText && (pwIds === null || pwIds.size)) {
            const pwProgs = parseProgrammes(xmlText, pwIds); // pwIds null => keep all (no provider)
            for (const [id, arr] of pwProgs) newProgrammes.set(`pw:${id}`, arr);
        }
        programmes = newProgrammes;
        lastFetch = Date.now();

        const sdCount = sdIds.length ? [...programmes.keys()].filter((k) => k.startsWith('sd:')).length : 0;
        const pwCount = [...programmes.keys()].filter((k) => k.startsWith('pw:')).length;
        log.info(`EPG merged: ${channels.size} channels (${sdStations.size} SD + ${pwChannels.size} XMLTV); `
            + `${programmes.size} with schedules (${sdCount} SD, ${pwCount} XMLTV gap-fill)`);
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

function getNowPlaying(epgChannelId, offsetHours = 0) {
    const progs = programmes.get(epgChannelId);
    if (!progs) return null;
    const now = _now(offsetHours);
    return progs.find((p) => p.start <= now && (!p.stop || p.stop > now)) || null;
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
    getEPGChannels,
    persistCache,
    loadCache,
    getStatus,
};
