// config.js — single source of truth for all env-driven configuration.
//
// Every tunable is read from the environment with a sensible default so the addon
// runs with zero configuration in development and is fully controllable in Docker.

const path = require('path');

const log = require('./log')('Config');

// --- Paths -----------------------------------------------------------------

// DATA_ROOT is the directory that contains the bundled static data dirs:
//   <DATA_ROOT>/catalog/tv/all.json
//   <DATA_ROOT>/stream/tv/<id>.json
//   <DATA_ROOT>/meta/tv/<id>.json
//
// In Docker we COPY those dirs to /app and set DATA_ROOT=/app.
// In local dev (running from server/src/), the repo root is two levels up.
const DATA_ROOT = process.env.DATA_ROOT
    ? path.resolve(process.env.DATA_ROOT)
    : path.resolve(__dirname, '..', '..');

// CACHE_DIR is a WRITABLE directory for the emergency cache files. It must persist
// across restarts to be useful, so in Docker this should be a mounted volume.
const CACHE_DIR = process.env.CACHE_DIR
    ? path.resolve(process.env.CACHE_DIR)
    : path.join(DATA_ROOT, 'cache');

// --- Remote sources --------------------------------------------------------

// Base for fetching the latest published JSON (roster + per-channel streams) from
// GitHub raw. NOTE: no trailing slash. Stream files live at <base>/stream/tv/<id>.json
// and the roster at <base>/catalog/tv/all.json.
const GITHUB_RAW_BASE = (process.env.GITHUB_RAW_BASE
    || 'https://raw.githubusercontent.com/ConfidentlyIncorrect/usa-tv-next/main').replace(/\/+$/, '');

const ROSTER_URL = `${GITHUB_RAW_BASE}/catalog/tv/all.json`;
const STREAM_URL = (id) => `${GITHUB_RAW_BASE}/stream/tv/${id}.json`;

// XMLTV EPG source (gzipped or plain XML auto-detected by epg.js).
const EPG_URL = process.env.EPG_URL || 'https://epg.pw/xmltv/epg_US.xml';

// --- Provider policy (mirrors harvester/config.py) -------------------------
// Streams whose URL contains a blocklisted host are never served (Pluto TV is no
// longer accessible). Streams from priority hosts are sorted to the top of each
// channel's list (tvpass.org is the most stable provider). Comma-separated env
// overrides; matching is case-insensitive substring on the URL.
const splitList = (v, def) =>
    (v || def).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const STREAM_BLOCKLIST_HOSTS = splitList(process.env.STREAM_BLOCKLIST_HOSTS, 'pluto.tv');
const STREAM_PRIORITY_HOSTS = splitList(process.env.STREAM_PRIORITY_HOSTS, 'tvpass.org');

// --- Stream proxy (fixes fragile HTTP/IP/header-gated feeds) ----------------
// The stream handler routes FRAGILE upstream URLs (http / raw-IP / odd-port / cors-proxy
// / shortener) through this server's /proxy route, which fetches them with proper headers
// over the public TLS endpoint and rewrites HLS manifests so segments are proxied too.
// Clean HTTPS streams are left direct.
//
// The public base is normally AUTO-DETECTED from the request Host (Tailscale Funnel and
// any reverse proxy pass the real public host), so a Funnel deployment needs no config.
// PROXY_PUBLIC_URL forces an explicit base (e.g. https://tv.example.com); PROXY_DISABLE=1
// turns the proxy off entirely (fragile streams then served direct, just sorted last).
const PROXY_PUBLIC_URL = (process.env.PROXY_PUBLIC_URL || '').trim().replace(/\/+$/, '');
const PROXY_DISABLE = process.env.PROXY_DISABLE === '1';
const PROXY_USER_AGENT = process.env.PROXY_USER_AGENT
    || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PROXY_TIMEOUT_MS = parseInt(process.env.PROXY_TIMEOUT_MS || '20000', 10);

// --- Server ----------------------------------------------------------------

const PORT = parseInt(process.env.PORT || '7001', 10);
const HOST = process.env.HOST || '0.0.0.0';
const TZ = process.env.TZ || 'America/Denver';

// --- Refresh / cache intervals --------------------------------------------

const hours = (envName, def) => {
    const n = parseFloat(process.env[envName]);
    return (Number.isFinite(n) && n > 0 ? n : def) * 60 * 60 * 1000;
};

// How often to re-fetch the roster from GitHub and rewrite the emergency cache.
const DATA_REFRESH_MS = hours('DATA_REFRESH_HOURS', 6);
// How often to re-fetch + re-parse the EPG XML.
const EPG_REFRESH_MS = hours('EPG_REFRESH_HOURS', 6);
// In-memory TTL for lazily-fetched per-channel stream files before we try GitHub again.
const STREAM_FETCH_TTL_MS = hours('STREAM_FETCH_TTL_HOURS', 6);

// cacheMaxAge (seconds) returned to Stremio on catalog/meta/stream responses.
const RESPONSE_CACHE_SECS = parseInt(process.env.RESPONSE_CACHE_SECS || '300', 10);

// Timeout (ms) for small JSON fetches (roster, per-channel streams).
const FETCH_TIMEOUT_MS = parseInt(process.env.FETCH_TIMEOUT_MS || '15000', 10);

// Timeout (ms) for the EPG download specifically. The XMLTV file is ~188 MB, so this
// must be far larger than FETCH_TIMEOUT_MS or the download will be aborted mid-stream.
const EPG_FETCH_TIMEOUT_MS = parseInt(process.env.EPG_FETCH_TIMEOUT_MS || '120000', 10);

const config = {
    DATA_ROOT,
    CACHE_DIR,
    GITHUB_RAW_BASE,
    ROSTER_URL,
    STREAM_URL,
    EPG_URL,
    PORT,
    HOST,
    TZ,
    DATA_REFRESH_MS,
    EPG_REFRESH_MS,
    STREAM_FETCH_TTL_MS,
    RESPONSE_CACHE_SECS,
    FETCH_TIMEOUT_MS,
    EPG_FETCH_TIMEOUT_MS,
    STREAM_BLOCKLIST_HOSTS,
    STREAM_PRIORITY_HOSTS,
    PROXY_PUBLIC_URL,
    PROXY_DISABLE,
    PROXY_USER_AGENT,
    PROXY_TIMEOUT_MS,
};

// Log the resolved configuration once at load so every container start is auditable.
log.info('Resolved configuration:');
log.info(`  DATA_ROOT          = ${DATA_ROOT}`);
log.info(`  CACHE_DIR          = ${CACHE_DIR}`);
log.info(`  GITHUB_RAW_BASE    = ${GITHUB_RAW_BASE}`);
log.info(`  EPG_URL            = ${EPG_URL}`);
log.info(`  PORT / HOST        = ${PORT} / ${HOST}`);
log.info(`  TZ                 = ${TZ}`);
log.info(`  DATA_REFRESH_MS    = ${DATA_REFRESH_MS} (${DATA_REFRESH_MS / 3600000}h)`);
log.info(`  EPG_REFRESH_MS     = ${EPG_REFRESH_MS} (${EPG_REFRESH_MS / 3600000}h)`);
log.info(`  RESPONSE_CACHE_SECS= ${RESPONSE_CACHE_SECS}`);
log.info(`  BLOCKLIST_HOSTS    = ${STREAM_BLOCKLIST_HOSTS.join(', ') || '(none)'}`);
log.info(`  PRIORITY_HOSTS     = ${STREAM_PRIORITY_HOSTS.join(', ') || '(none)'}`);
log.info(`  PROXY              = ${PROXY_DISABLE ? 'disabled (PROXY_DISABLE=1)'
    : PROXY_PUBLIC_URL ? `on -> ${PROXY_PUBLIC_URL}` : 'auto (public base learned from request Host)'}`);

module.exports = config;
