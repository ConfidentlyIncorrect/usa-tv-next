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
const { XMLParser } = require('fast-xml-parser');
const { gunzipSync } = require('zlib');

const cfg = require('./config');
const log = require('./log')('EPG');

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

/** Fetch + parse the EPG. On failure, KEEP the existing in-memory data (never wipe). */
async function fetchEPG() {
    if (fetching) {
        log.debug('Fetch already in progress; skipping concurrent call');
        return;
    }
    fetching = true;
    log.info(`Fetching EPG data from ${cfg.EPG_URL} ...`);
    try {
        let xmlText = await log.timed('EPG download', () => downloadEpg());
        log.info(`Parsing XML (${(xmlText.length / 1024 / 1024).toFixed(1)} MB) ...`);

        const parser = new XMLParser({
            ignoreAttributes: false,
            attributeNamePrefix: '@_',
            isArray: (name) => name === 'channel' || name === 'programme' || name === 'category',
            textNodeName: '#text',
        });
        const parsed = parser.parse(xmlText);
        xmlText = null; // free the raw string before building maps to reduce peak memory
        const tv = parsed.tv || parsed.TV;
        if (!tv) throw new Error('No <tv> root element found');

        const newChannels = new Map();
        for (const ch of (tv.channel || [])) {
            const id = ch['@_id'];
            const nameNode = ch['display-name'];
            let name = '';
            if (typeof nameNode === 'string') name = nameNode;
            else if (nameNode && typeof nameNode === 'object') name = nameNode['#text'] || nameNode.toString();
            const icon = ch.icon ? (ch.icon['@_src'] || '') : '';
            newChannels.set(id, { name: String(name).trim(), icon });
        }

        const newProgrammes = new Map();
        for (const prog of (tv.programme || [])) {
            const chId = prog['@_channel'];
            const start = parseDateTime(prog['@_start']);
            const stop = parseDateTime(prog['@_stop']);
            if (!start || !chId) continue;

            let title = '';
            const titleNode = prog.title;
            if (typeof titleNode === 'string') title = titleNode;
            else if (titleNode && typeof titleNode === 'object') title = titleNode['#text'] || '';

            let desc = '';
            const descNode = prog.desc;
            if (typeof descNode === 'string') desc = descNode;
            else if (descNode && typeof descNode === 'object') desc = descNode['#text'] || '';

            let categories = [];
            if (prog.category) {
                const cats = Array.isArray(prog.category) ? prog.category : [prog.category];
                categories = cats.map((c) => (typeof c === 'string' ? c : (c['#text'] || ''))).filter(Boolean);
            }

            let icon = '';
            if (prog.icon) icon = prog.icon['@_src'] || '';

            if (!newProgrammes.has(chId)) newProgrammes.set(chId, []);
            newProgrammes.get(chId).push({ start, stop, title, desc, categories, icon });
        }

        for (const [, progs] of newProgrammes) progs.sort((a, b) => a.start - b.start);

        channels = newChannels;
        programmes = newProgrammes;
        lastFetch = Date.now();
        log.info(`Loaded ${newChannels.size} channels, ${newProgrammes.size} with programmes`);
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

function getNowPlaying(epgChannelId) {
    const progs = programmes.get(epgChannelId);
    if (!progs) return null;
    const now = new Date();
    return progs.find((p) => p.start <= now && (!p.stop || p.stop > now)) || null;
}

function getUpNext(epgChannelId) {
    const progs = programmes.get(epgChannelId);
    if (!progs) return null;
    const now = new Date();
    return progs.find((p) => p.start > now) || null;
}

function getDaySchedule(epgChannelId) {
    const progs = programmes.get(epgChannelId);
    if (!progs) return [];
    const now = new Date();
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
    getNowPlaying,
    getUpNext,
    getDaySchedule,
    getEPGChannels,
    persistCache,
    loadCache,
    getStatus,
};
