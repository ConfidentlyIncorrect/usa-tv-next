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

// Set to 0 when the bundled image contains a curated roster that has not yet been
// published to GITHUB_RAW_BASE. In that mode local files are authoritative and a
// stale emergency cache or remote branch cannot silently restore removed channels.
const DATA_REMOTE_ENABLE = !['0', 'false', 'no', 'off'].includes(
    String(process.env.DATA_REMOTE_ENABLE || '1').trim().toLowerCase(),
);

const ROSTER_URL = `${GITHUB_RAW_BASE}/catalog/tv/all.json`;
const STREAM_URL = (id) => `${GITHUB_RAW_BASE}/stream/tv/${id}.json`;

// XMLTV EPG sources (gzipped or plain XML auto-detected by epg.js). These are the 2nd/3rd-tier
// gap-fill sources behind Schedules Direct. EPG_URL = epg.pw (primary XMLTV). EPGSHARE_URLS =
// epgshare01.online feeds (3rd tier — adds FAST/streaming channels neither SD nor epg.pw carry:
// Comet, Buzzr, Court TV, MotorTrend, Vevo, FilmRise, …). Comma-separated; NOT lowercased
// (filenames like US2/PLEX1 are case-sensitive). Set EPGSHARE_URLS='' to disable the 3rd tier.
const EPG_URL = process.env.EPG_URL || 'https://epg.pw/xmltv/epg_US.xml';
// Tier-3 feeds: epgshare01 US2 (broad US FAST/cable) + Matt Huisman's per-platform FAST guides
// (i.mjh.nz: Samsung TV Plus / Plex / Pluto) which cover the niche FAST long tail SD + epg.pw
// miss (XITE, AsianCrush, RetroCrush, Dark Matter, Midnight Pulp, Outside TV, Stadium, Hi-YAH!,
// Comedy Dynamics, Wu Tang, …). All merged into one "es:" pool. Small (<7 MB gz each).
const EPGSHARE_URLS = (process.env.EPGSHARE_URLS !== undefined
    ? process.env.EPGSHARE_URLS
    : 'https://epgshare01.online/epgshare01/epg_ripper_US2.xml.gz,'
    + 'https://i.mjh.nz/SamsungTVPlus/us.xml.gz,'
    + 'https://i.mjh.nz/Plex/all.xml.gz,'
    + 'https://i.mjh.nz/PlutoTV/us.xml.gz,'
    + 'https://i.mjh.nz/Roku/all.xml.gz'
).split(',').map((s) => s.trim()).filter(Boolean);

// --- Schedules Direct (PRIMARY EPG when configured) ------------------------
// Schedules Direct (json.schedulesdirect.org) is a paid ($35/yr), accurate, feed-/timezone-
// correct US listings service. If SD_USERNAME + SD_PASSWORD are set, epg.js uses it as the
// PRIMARY guide and MERGES the EPG_URL XMLTV feed (epg.pw) on top to FILL GAPS — channels SD
// doesn't cover (e.g. FAST/streaming) get their guide from epg.pw. If SD fails entirely, it's
// epg.pw-only. With no credentials set, behaviour is unchanged (epg.pw only).
// Lineup setup is AUTOMATIC: set SD_ZIP to your postal code and the server provisions a
// comprehensive lineup for you via the SD JSON API (no manual curation). It prefers a national
// SATELLITE lineup (DirecTV/Dish carry virtually all national cable/sports/premium nets + your
// local affiliates for that ZIP), so one lineup covers the whole catalog. It only adds a lineup
// when the account has none (idempotent across restarts; never auto-removes; respects SD's
// daily lineup-change limit). Override transport with SD_TRANSPORT (Satellite/Cable/Antenna/
// IPTV). SD_LINEUP optionally filters station collection to one lineup by substring. If you'd
// rather add lineups by hand on the SD website, just leave SD_ZIP unset. SD_DAYS = days of guide.
const SD_USERNAME = (process.env.SD_USERNAME || '').trim();
const SD_PASSWORD = process.env.SD_PASSWORD || '';
const SD_BASE = (process.env.SD_BASE_URL || 'https://json.schedulesdirect.org/20141201').replace(/\/+$/, '');
const SD_LINEUP = (process.env.SD_LINEUP || '').trim();
const SD_DAYS = Math.max(1, Math.min(14, parseInt(process.env.SD_DAYS || '2', 10) || 2));
// Defensively strip surrounding quotes/whitespace — compose `- SD_ZIP="80202"` passes the
// quotes through literally, which would make SD's /headends reject the postalcode (HTTP 400).
const _clean = (v) => (v || '').trim().replace(/^["']|["']$/g, '').trim();
const SD_ZIP = _clean(process.env.SD_ZIP);
const SD_COUNTRY = _clean(process.env.SD_COUNTRY) || 'USA';
const SD_TRANSPORT = _clean(process.env.SD_TRANSPORT); // '' = auto (prefer Satellite)
const SD_FORCE_LINEUP = process.env.SD_FORCE_LINEUP === '1'; // add the auto lineup even if some already exist

// --- Provider policy (mirrors harvester/config.py) -------------------------
// Streams whose URL contains a blocklisted host are never served. Pluto TV is gone, and as of
// this build tvpass.org / thetvapp.to (its tokenized CDN) are offline — blocklisting them stops
// the addon from handing players dead URLs (so channels that still have another provider serve
// that one cleanly, and tvpass-only channels return empty instead of buffering forever). If tvpass
// comes back, override with STREAM_BLOCKLIST_HOSTS=pluto.tv (env). Matching is case-insensitive
// substring on the URL. STREAM_PRIORITY_HOSTS is now moot for tvpass (blocked) — quality-first
// ordering (STREAM_SORT) governs.
const splitList = (v, def) =>
    (v || def).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const STREAM_BLOCKLIST_HOSTS = splitList(process.env.STREAM_BLOCKLIST_HOSTS, 'pluto.tv,tvpass.org,thetvapp.to');
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
// Hosts to force through the proxy even though they look "clean" HTTPS — for feeds that
// are alive but flaky in the player (e.g. XUMO/SSAI nbcuni "black then exit"); routing
// them through the proxy normalizes the manifest + header path. Comma-separated substrings.
const PROXY_FORCE_HOSTS = splitList(process.env.PROXY_FORCE_HOSTS, '');
const PROXY_USER_AGENT = process.env.PROXY_USER_AGENT
    || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PROXY_TIMEOUT_MS = parseInt(process.env.PROXY_TIMEOUT_MS || '20000', 10);

// --- DaddyLive (dlhd.pk) live resolver -------------------------------------
// Restores the ~69 premium/cable/sports channels that went dark when tvpass.org died, by
// resolving dlhd.pk channel ids (mapped in dlhdChannels.js) to fresh tokenized HLS at request
// time and re-serving them through /dlhd + the /proxy. Requires the proxy to be active (the
// resolved CDN tokens expire ~hourly and the client must talk plain HTTPS to our host).
// DLHD_INCLUDE_EXTRA also offers dlhd on channels that still have a free feed (off by default —
// avoids adding a rotating piracy source to channels that already work). DLHD_BASE/DLHD_EMBED_HOST
// let you follow domain rotations without a code change. Set DLHD_ENABLE=0 to turn it all off.
const DLHD_ENABLE = process.env.DLHD_ENABLE !== '0';
// On by default: also offer DaddyLive on channels that still have a free feed (an HD premium-source
// alternate). Quality-first ordering may make the dlhd HD feed the default where the free feed is SD.
// Set DLHD_INCLUDE_EXTRA=0 to restrict dlhd to the DARK (tvpass-dead) channels only.
const DLHD_INCLUDE_EXTRA = process.env.DLHD_INCLUDE_EXTRA !== '0';
const DLHD_BASE = (process.env.DLHD_BASE || 'https://dlhd.pk').trim().replace(/\/+$/, '');
const DLHD_EMBED_HOST = (process.env.DLHD_EMBED_HOST || '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
// Re-resolve a channel when its token is within this margin of expiry (token life is ~58min).
const DLHD_TOKEN_MARGIN_MS = parseInt(process.env.DLHD_TOKEN_MARGIN_MS || '120000', 10);
const DLHD_RESOLVE_TIMEOUT_MS = parseInt(process.env.DLHD_RESOLVE_TIMEOUT_MS || '15000', 10);
// SPLIT-TUNNEL: DaddyLive's premium embed + CDN origins drop datacenter/VPS egress IPs (the
// main dlhd.pk site is fine, but the embed/CDN time out -> "cannot reach ...: CONNECT_TIMEOUT").
// Set DLHD_OUTBOUND_PROXY to an HTTP(S) proxy on a residential/VPN exit (e.g. a gluetun sidecar:
// http://gluetun:8888) and ONLY the DaddyLive fetches — the resolver chain + the CDN segments —
// egress through it; every other source (EPG, GitHub, iptv-org, Tubi, tvpass, …) stays direct.
const DLHD_OUTBOUND_PROXY = (process.env.DLHD_OUTBOUND_PROXY || '').trim();
// Extra (non-DaddyLive) hosts whose proxied fetches should ALSO egress through DLHD_OUTBOUND_PROXY
// (the VPN) — for fragile feeds that likewise reject datacenter/VPS IPs (e.g. the fan-run Toonami
// Aftermath origin, which 500s from a VPS but serves fine residentially). Comma-separated host
// substrings; matched against the proxied target. No effect unless DLHD_OUTBOUND_PROXY is set.
const PROXY_VPN_HOSTS = splitList(process.env.PROXY_VPN_HOSTS, 'toonamiaftermath.com');

// Damitv's general Live TV roster mirrors DaddyLive, but its /papi API also exposes a small
// set of persistent channels. Only identity- and playback-verified entries are mapped.
const DAMITV_ENABLE = !['0', 'false', 'no', 'off'].includes(
    String(process.env.DAMITV_ENABLE || '1').trim().toLowerCase(),
);
const DAMITV_BASE = (process.env.DAMITV_BASE || 'https://damitv.st').trim().replace(/\/+$/, '');
const DAMITV_TOKEN_MARGIN_MS = parseInt(process.env.DAMITV_TOKEN_MARGIN_MS || '300000', 10);
const DAMITV_RESOLVE_TIMEOUT_MS = parseInt(process.env.DAMITV_RESOLVE_TIMEOUT_MS || '15000', 10);

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

// Order each channel's streams by QUALITY (FHD > HD > SD > Audio), with the priority provider
// (tvpass) preferred as a same-quality tiebreaker and the harvester's original order kept as the
// final tiebreaker (stable). This surfaces the best-quality feed — which is also the one that
// usually carries WebVTT subtitles — as the default/auto-play stream. Set STREAM_SORT=data to
// keep the raw harvester (provider/regional) order instead.
const STREAM_SORT_QUALITY = (process.env.STREAM_SORT || 'quality').toLowerCase() !== 'data';

// Timeout (ms) for small JSON fetches (roster, per-channel streams).
const FETCH_TIMEOUT_MS = parseInt(process.env.FETCH_TIMEOUT_MS || '15000', 10);

// Timeout (ms) for the EPG download specifically. The XMLTV file is ~188 MB, so this
// must be far larger than FETCH_TIMEOUT_MS or the download will be aborted mid-stream.
const EPG_FETCH_TIMEOUT_MS = parseInt(process.env.EPG_FETCH_TIMEOUT_MS || '120000', 10);

const config = {
    DATA_ROOT,
    CACHE_DIR,
    GITHUB_RAW_BASE,
    DATA_REMOTE_ENABLE,
    ROSTER_URL,
    STREAM_URL,
    EPG_URL,
    EPGSHARE_URLS,
    SD_USERNAME,
    SD_PASSWORD,
    SD_BASE,
    SD_LINEUP,
    SD_DAYS,
    SD_ZIP,
    SD_COUNTRY,
    SD_TRANSPORT,
    SD_FORCE_LINEUP,
    PORT,
    HOST,
    TZ,
    DATA_REFRESH_MS,
    EPG_REFRESH_MS,
    STREAM_FETCH_TTL_MS,
    RESPONSE_CACHE_SECS,
    FETCH_TIMEOUT_MS,
    EPG_FETCH_TIMEOUT_MS,
    STREAM_SORT_QUALITY,
    STREAM_BLOCKLIST_HOSTS,
    STREAM_PRIORITY_HOSTS,
    PROXY_PUBLIC_URL,
    PROXY_DISABLE,
    PROXY_FORCE_HOSTS,
    PROXY_USER_AGENT,
    PROXY_TIMEOUT_MS,
    DLHD_ENABLE,
    DLHD_INCLUDE_EXTRA,
    DLHD_BASE,
    DLHD_EMBED_HOST,
    DLHD_TOKEN_MARGIN_MS,
    DLHD_RESOLVE_TIMEOUT_MS,
    DLHD_OUTBOUND_PROXY,
    PROXY_VPN_HOSTS,
    DAMITV_ENABLE,
    DAMITV_BASE,
    DAMITV_TOKEN_MARGIN_MS,
    DAMITV_RESOLVE_TIMEOUT_MS,
};

// Log the resolved configuration once at load so every container start is auditable.
log.info('Resolved configuration:');
log.info(`  DATA_ROOT          = ${DATA_ROOT}`);
log.info(`  CACHE_DIR          = ${CACHE_DIR}`);
log.info(`  GITHUB_RAW_BASE    = ${GITHUB_RAW_BASE}`);
log.info(`  DATA REMOTE FETCH  = ${DATA_REMOTE_ENABLE ? 'enabled' : 'disabled (bundled files authoritative)'}`);
log.info(`  EPG_URL            = ${EPG_URL}`);
log.info(`  EPGSHARE_URLS      = ${EPGSHARE_URLS.length ? `${EPGSHARE_URLS.length} feed(s)` : '(disabled)'}`);
log.info(`  EPG SOURCE         = ${SD_USERNAME ? `Schedules Direct (primary, user ${SD_USERNAME}); XMLTV fallback` : 'epg.pw XMLTV (Schedules Direct not configured)'}`);
if (SD_USERNAME) log.info(`  SD_BASE/DAYS/LINEUP= ${SD_BASE} / ${SD_DAYS}d / ${SD_LINEUP || '(all lineups)'}`);
if (SD_USERNAME) log.info(`  SD AUTO-LINEUP     = ${SD_ZIP ? `ZIP ${SD_ZIP} (${SD_COUNTRY}), transport ${SD_TRANSPORT || 'auto: prefer Satellite'}${SD_FORCE_LINEUP ? ', force' : ''}` : 'off (add lineups manually on SD site)'}`);
log.info(`  PORT / HOST        = ${PORT} / ${HOST}`);
log.info(`  TZ                 = ${TZ}`);
log.info(`  DATA_REFRESH_MS    = ${DATA_REFRESH_MS} (${DATA_REFRESH_MS / 3600000}h)`);
log.info(`  EPG_REFRESH_MS     = ${EPG_REFRESH_MS} (${EPG_REFRESH_MS / 3600000}h)`);
log.info(`  RESPONSE_CACHE_SECS= ${RESPONSE_CACHE_SECS}`);
log.info(`  BLOCKLIST_HOSTS    = ${STREAM_BLOCKLIST_HOSTS.join(', ') || '(none)'}`);
log.info(`  PRIORITY_HOSTS     = ${STREAM_PRIORITY_HOSTS.join(', ') || '(none)'}`);
log.info(`  PROXY              = ${PROXY_DISABLE ? 'disabled (PROXY_DISABLE=1)'
    : PROXY_PUBLIC_URL ? `on -> ${PROXY_PUBLIC_URL}` : 'auto (public base learned from request Host)'}`);
log.info(`  DLHD (DaddyLive)   = ${DLHD_ENABLE ? `on -> ${DLHD_BASE}${DLHD_INCLUDE_EXTRA ? ' (+EXTRA channels)' : ''}${DLHD_EMBED_HOST ? `, embed ${DLHD_EMBED_HOST}` : ''}${DLHD_OUTBOUND_PROXY ? `, via proxy ${DLHD_OUTBOUND_PROXY}` : ''}` : 'disabled (DLHD_ENABLE=0)'}`);
if (DLHD_OUTBOUND_PROXY && PROXY_VPN_HOSTS.length) log.info(`  VPN-routed hosts   = ${PROXY_VPN_HOSTS.join(', ')} (also via DLHD_OUTBOUND_PROXY)`);
log.info(`  Damitv             = ${DAMITV_ENABLE ? `on -> ${DAMITV_BASE}` : 'disabled (DAMITV_ENABLE=0)'}`);

module.exports = config;
