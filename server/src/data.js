// data.js — hybrid roster + stream data layer.
//
// Design (per product decision: "combination of both"):
//   • BUNDLED LOCAL FILES are the guaranteed baseline. They ship inside the Docker
//     image (<DATA_ROOT>/catalog/tv/all.json and <DATA_ROOT>/stream/tv/<id>.json),
//     so the addon always has *something* to serve even with zero network access.
//   • A periodic INTERVAL FETCH pulls the freshest roster from GitHub raw and writes
//     it to an EMERGENCY CACHE FILE on a persistent volume.
//   • Read precedence (freshest wins, but never nothing):
//        live fetch (in-memory)  ->  emergency cache file  ->  bundled local file
//
// Streams are resolved per channel:
//   inline streams on the roster entry  ->  in-memory fetched cache (fresh)
//   ->  bundled local stream file  ->  lazy GitHub fetch (then cached)  ->  []
//
// Rationale: when the harvester is healthy it writes streams INLINE into all.json
// (see harvester/inject.py), so a single roster fetch refreshes everything. The
// per-channel local stream files are the bundled fallback for channels whose inline
// array is empty (the current on-disk reality), and a lazy GitHub fetch is the last
// resort for channels missing locally.

const fs = require('fs');
const path = require('path');

const cfg = require('./config');
const log = require('./log')('DataLayer');

// --- module state ----------------------------------------------------------

let roster = [];                 // array of channel meta objects (catalog "metas")
let rosterById = new Map();      // id -> meta (rebuilt whenever roster changes)
let rosterSource = 'empty';      // 'fetch' | 'cache' | 'local' | 'empty'
let rosterFetchedAt = 0;         // ms epoch of the value currently held (best effort)
let lastFetchAttemptAt = 0;
let lastFetchOk = null;          // boolean | null (null = never attempted)

// id -> { streams, fetchedAt, source }
const streamCache = new Map();

const ROSTER_CACHE_FILE = path.join(cfg.CACHE_DIR, 'roster-cache.json');
const LOCAL_ROSTER_FILE = path.join(cfg.DATA_ROOT, 'catalog', 'tv', 'all.json');
const localStreamFile = (id) => path.join(cfg.DATA_ROOT, 'stream', 'tv', `${id}.json`);

// --- low-level helpers -----------------------------------------------------

function ensureCacheDir() {
    try {
        fs.mkdirSync(cfg.CACHE_DIR, { recursive: true });
    } catch (err) {
        log.warn(`Could not create cache dir ${cfg.CACHE_DIR}: ${err.message}`);
    }
}

/** Fetch a URL with a hard timeout, returning parsed JSON. Throws on any failure. */
async function fetchJson(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.FETCH_TIMEOUT_MS);
    try {
        const resp = await fetch(url, { signal: controller.signal });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        return await resp.json();
    } finally {
        clearTimeout(timer);
    }
}

/** Atomic JSON write: write to a temp file, then rename over the target. */
function writeJsonAtomic(file, obj) {
    ensureCacheDir();
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(obj), 'utf-8');
    fs.renameSync(tmp, file);
}

function setRoster(metas, source, fetchedAt) {
    roster = Array.isArray(metas) ? metas : [];
    rosterById = new Map(roster.map((ch) => [ch.id, ch]));
    rosterSource = source;
    rosterFetchedAt = fetchedAt || Date.now();
    log.info(`Roster set from "${source}": ${roster.length} channels`);
}

// --- roster loaders --------------------------------------------------------

/** Read the bundled local roster file. Returns { metas, mtimeMs } or null. */
function loadLocalRoster() {
    try {
        const stat = fs.statSync(LOCAL_ROSTER_FILE);
        const data = JSON.parse(fs.readFileSync(LOCAL_ROSTER_FILE, 'utf-8'));
        const metas = data.metas || [];
        log.debug(`Bundled local roster: ${metas.length} channels (mtime ${new Date(stat.mtimeMs).toISOString()})`);
        return { metas, mtimeMs: stat.mtimeMs };
    } catch (err) {
        log.warn(`No bundled local roster at ${LOCAL_ROSTER_FILE}: ${err.message}`);
        return null;
    }
}

/** Read the emergency cache (last successful fetch). Returns { metas, fetchedAt } or null. */
function loadEmergencyCache() {
    try {
        const data = JSON.parse(fs.readFileSync(ROSTER_CACHE_FILE, 'utf-8'));
        const metas = data.metas || [];
        const fetchedAt = data.fetchedAt || 0;
        log.debug(`Emergency cache roster: ${metas.length} channels (fetchedAt ${new Date(fetchedAt).toISOString()})`);
        return { metas, fetchedAt };
    } catch (err) {
        // ENOENT is normal on first ever run.
        if (err.code !== 'ENOENT') log.warn(`Could not read emergency cache: ${err.message}`);
        return null;
    }
}

/** Fetch the freshest roster from GitHub raw. Throws on failure. Returns metas array. */
async function fetchRemoteRoster() {
    log.debug(`Fetching roster from ${cfg.ROSTER_URL}`);
    const data = await fetchJson(cfg.ROSTER_URL);
    const metas = data.metas || [];
    if (metas.length === 0) throw new Error('remote roster had 0 metas');
    return metas;
}

// --- public roster API -----------------------------------------------------

/**
 * Attempt to refresh the roster from GitHub. On success: update memory + rewrite the
 * emergency cache. On failure: keep whatever we already have. Returns true on success.
 * Safe to call repeatedly (used by the cron schedule).
 */
async function refreshRoster() {
    lastFetchAttemptAt = Date.now();
    try {
        const metas = await log.timed('roster fetch', () => fetchRemoteRoster());
        const fetchedAt = Date.now();
        setRoster(metas, 'fetch', fetchedAt);
        lastFetchOk = true;
        try {
            writeJsonAtomic(ROSTER_CACHE_FILE, { fetchedAt, metas });
            log.info(`Emergency cache updated (${metas.length} channels) -> ${ROSTER_CACHE_FILE}`);
        } catch (writeErr) {
            log.warn(`Roster fetched OK but emergency cache write failed: ${writeErr.message}`);
        }
        return true;
    } catch (err) {
        lastFetchOk = false;
        log.warn(`Roster fetch failed (${err.message}); keeping current roster from "${rosterSource}" (${roster.length} channels)`);
        return false;
    }
}

/**
 * Initialise the roster on startup. Establishes the freshest baseline that does NOT
 * require the network (cache vs bundled-local, newest wins), then attempts a live
 * fetch to override. Guarantees a non-empty roster as long as either the bundled
 * file or the cache exists.
 */
async function initRoster() {
    ensureCacheDir();

    const local = loadLocalRoster();
    const cache = loadEmergencyCache();

    // Pick the newer of (bundled local, emergency cache) as the offline baseline.
    if (cache && local) {
        if (cache.fetchedAt >= local.mtimeMs) {
            setRoster(cache.metas, 'cache', cache.fetchedAt);
        } else {
            log.debug('Bundled local roster is newer than emergency cache; preferring local');
            setRoster(local.metas, 'local', local.mtimeMs);
        }
    } else if (cache) {
        setRoster(cache.metas, 'cache', cache.fetchedAt);
    } else if (local) {
        setRoster(local.metas, 'local', local.mtimeMs);
    } else {
        log.error('No roster available from cache OR bundled local files — starting empty');
    }

    // Now try to get the very latest. If this fails we keep the baseline above.
    await refreshRoster();
    log.info(`Roster initialised: ${roster.length} channels (current source: "${rosterSource}")`);
}

function getRoster() {
    return roster;
}

function getChannelById(id) {
    return rosterById.get(id);
}

// --- stream resolution -----------------------------------------------------

function loadLocalStreams(id) {
    try {
        const data = JSON.parse(fs.readFileSync(localStreamFile(id), 'utf-8'));
        return Array.isArray(data.streams) ? data.streams : [];
    } catch (err) {
        if (err.code !== 'ENOENT') log.warn(`Local stream file read error for ${id}: ${err.message}`);
        return [];
    }
}

async function fetchRemoteStreams(id) {
    const url = cfg.STREAM_URL(id);
    log.debug(`Lazy-fetching streams for ${id} from ${url}`);
    const data = await fetchJson(url);
    return Array.isArray(data.streams) ? data.streams : [];
}

/**
 * Resolve the streams for a channel. Precedence:
 *   1. inline streams on the roster entry (freshest when harvester is healthy)
 *   2. in-memory cache of a previous lazy fetch (if still within TTL)
 *   3. bundled local stream file
 *   4. lazy GitHub fetch (result cached in memory)
 *   5. [] (nothing anywhere)
 * Always resolves to an array; never throws.
 */
async function getStreams(id) {
    // 1. inline on the roster entry
    const ch = rosterById.get(id);
    if (ch && Array.isArray(ch.streams) && ch.streams.length > 0) {
        log.debug(`Streams for ${id}: ${ch.streams.length} from inline roster`);
        return ch.streams;
    }

    // 2. fresh in-memory lazy-fetch cache
    const cached = streamCache.get(id);
    if (cached && Date.now() - cached.fetchedAt < cfg.STREAM_FETCH_TTL_MS) {
        log.debug(`Streams for ${id}: ${cached.streams.length} from in-memory cache (source: ${cached.source})`);
        return cached.streams;
    }

    // 3. bundled local stream file
    const local = loadLocalStreams(id);
    if (local.length > 0) {
        log.debug(`Streams for ${id}: ${local.length} from bundled local file`);
        // Seed the cache so we don't re-read disk every click.
        streamCache.set(id, { streams: local, fetchedAt: Date.now(), source: 'local' });
        return local;
    }

    // 4. lazy GitHub fetch (last resort)
    try {
        const remote = await fetchRemoteStreams(id);
        streamCache.set(id, { streams: remote, fetchedAt: Date.now(), source: 'fetch' });
        log.debug(`Streams for ${id}: ${remote.length} from lazy GitHub fetch`);
        return remote;
    } catch (err) {
        log.warn(`No streams resolvable for ${id} (inline/cache/local empty, fetch failed: ${err.message})`);
        return [];
    }
}

// --- diagnostics -----------------------------------------------------------

function getStatus() {
    return {
        channels: roster.length,
        rosterSource,
        rosterFetchedAt: rosterFetchedAt ? new Date(rosterFetchedAt).toISOString() : null,
        lastFetchAttemptAt: lastFetchAttemptAt ? new Date(lastFetchAttemptAt).toISOString() : null,
        lastFetchOk,
        streamCacheEntries: streamCache.size,
    };
}

module.exports = {
    initRoster,
    refreshRoster,
    getRoster,
    getChannelById,
    getStreams,
    getStatus,
};
