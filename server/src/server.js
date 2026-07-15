#!/usr/bin/env node
// server.js — process entry point.
//
// Startup sequence:
//   1. Load any persisted EPG cache (instant cold-start baseline, survives epg.pw outage).
//   2. Initialise the roster (data layer: bundled local / emergency cache baseline + live fetch).
//   3. Fetch + parse the fresh EPG feed.
//   4. Build the ustv -> epg id map (also re-persists the EPG cache for matched channels).
// Then schedule periodic refreshes and start the HTTP server on 0.0.0.0.

const http = require('http');
const { getRouter } = require('stremio-addon-sdk');

const cfg = require('./config');
const log = require('./log')('Server');
const data = require('./data');
const epg = require('./epg');
const channelMap = require('./channelMap');
const addonInterface = require('./addon');
const proxy = require('./proxy');
const dlhd = require('./dlhd');
const damitv = require('./damitv');

// --- process-level safety net ----------------------------------------------------------------
// This is an always-on streaming addon: the realistic uncaught errors are benign network/stream
// aborts (e.g. a client disconnecting mid-segment). Crashing + rebooting on those is far worse
// than logging — a reboot mid-EPG-fetch also leaves the guide half-loaded. So we log and keep
// running rather than letting one stray async error take the whole process down.
process.on('unhandledRejection', (reason) => {
    const r = reason && reason.stack ? reason.stack : reason;
    if (reason && reason.name === 'AbortError') return; // expected on client disconnect
    log.error(`Unhandled promise rejection (kept alive): ${r}`);
});
process.on('uncaughtException', (err) => {
    if (err && err.name === 'AbortError') {
        log.warn(`Ignored stray AbortError (client disconnect): ${err.message}`);
        return;
    }
    log.error(`Uncaught exception (kept alive): ${err && err.stack ? err.stack : err}`);
});

function logStatus() {
    log.info(`Status: data  = ${JSON.stringify(data.getStatus())}`);
    log.info(`Status: epg   = ${JSON.stringify(epg.getStatus())}`);
    log.info(`Status: map   = ${channelMap.getMatchCount()} channels matched to EPG`);
}

async function initialize() {
    log.info('Starting USA TV Next — combined catalog + EPG + streams');

    // 1. Cold-start EPG baseline from disk (if present). Refreshed in step 3.
    epg.loadCache();

    // 2. Roster baseline + live fetch. The data layer guarantees a non-empty roster
    //    as long as a bundled local file OR an emergency cache exists.
    await data.initRoster();

    // 3. Teach the EPG parser which channels matter: after it scans channel definitions it
    //    calls this to match the roster -> EPG ids, then parses programmes for ONLY those
    //    channels (streaming, channel-filtered -> low memory; persists the matched subset).
    epg.setRelevantIdsProvider(() => {
        channelMap.buildChannelMap();
        return channelMap.matchedEpgIds();
    });

    // 4. Fresh EPG download + streaming parse. On failure it retains the cache from step 1.
    log.info('Loading EPG data (the ~188 MB feed can take up to a minute) ...');
    await epg.fetchEPG();

    // 5. Safety net: if the download failed (fetchEPG kept the disk cache and never ran the
    //    matcher), still build the map against the cached channel names.
    if (channelMap.getMatchCount() === 0) channelMap.buildChannelMap();

    log.info('Initialization complete');
    logStatus();
}

async function refreshData() {
    log.info('Scheduled roster refresh ...');
    const changed = await data.refreshRoster();
    if (changed) channelMap.buildChannelMap(); // roster changed -> rebuild map
}

async function refreshEpg() {
    log.info('Scheduled EPG refresh ...');
    await epg.fetchEPG();  // re-matches (via the relevant-ids provider) + re-persists cache
    if (channelMap.getMatchCount() === 0) channelMap.buildChannelMap();  // safety on fetch failure
    logStatus();
}

function installSignalHandlers() {
    for (const sig of ['SIGTERM', 'SIGINT']) {
        process.on(sig, () => {
            log.info(`Received ${sig}, shutting down.`);
            process.exit(0);
        });
    }
    process.on('unhandledRejection', (reason) => {
        log.error(`Unhandled promise rejection: ${reason && reason.stack ? reason.stack : reason}`);
    });
}

async function main() {
    installSignalHandlers();
    await initialize();

    setInterval(() => {
        refreshData().catch((e) => log.error(`Roster refresh crashed: ${e.message}`));
    }, cfg.DATA_REFRESH_MS);

    setInterval(() => {
        refreshEpg().catch((e) => log.error(`EPG refresh crashed: ${e.message}`));
    }, cfg.EPG_REFRESH_MS);

    // Custom HTTP server: our /proxy route, everything else to the Stremio SDK router.
    const router = getRouter(addonInterface);
    const server = http.createServer((req, res) => {
        proxy.noteRequest(req);  // learn our public base (Funnel/reverse-proxy Host)
        if (req.url && req.url.startsWith(proxy.PREFIX)) {
            return proxy.handle(req, res);
        }
        // DaddyLive re-resolving HLS endpoints (master/media). async — guard against rejections.
        if (req.url && req.url.startsWith(dlhd.PREFIX)) {
            return dlhd.handle(req, res).catch((e) => {
                log.warn(`dlhd handler error: ${e && e.message}`);
                if (!res.headersSent && !res.writableEnded) { res.statusCode = 502; try { res.end('dlhd error'); } catch { /* gone */ } }
            });
        }
        // Token-refreshing HLS for manually vetted persistent Damitv feeds.
        if (req.url && req.url.startsWith(damitv.PREFIX)) {
            return damitv.handle(req, res).catch((e) => {
                log.warn(`damitv handler error: ${e && e.message}`);
                if (!res.headersSent && !res.writableEnded) { res.statusCode = 502; try { res.end('damitv error'); } catch { /* gone */ } }
            });
        }
        if (req.url && req.url.split('?')[0] === '/health') {
            res.setHeader('Content-Type', 'application/json');
            return res.end(JSON.stringify({
                ok: true,
                channels: data.getStatus().channels,
                proxy: {
                    disabled: cfg.PROXY_DISABLE,
                    active: proxy.proxyActive(),
                    publicBase: proxy.publicBase() || null,
                    source: cfg.PROXY_PUBLIC_URL ? 'PROXY_PUBLIC_URL'
                        : proxy.publicBase() ? 'auto-detected' : 'not-yet-known',
                },
                dlhd: {
                    enabled: cfg.DLHD_ENABLE,
                    mappedChannels: dlhd.mappedCount(),
                    outboundProxy: cfg.DLHD_OUTBOUND_PROXY || null,
                },
                damitv: {
                    enabled: cfg.DAMITV_ENABLE,
                    mappedChannels: damitv.mappedCount(),
                    base: cfg.DAMITV_BASE,
                },
            }));
        }
        // EPG match diagnostic — shows what the active guide source provides vs the roster, so
        // name overrides can be tuned (especially after switching to Schedules Direct). Read-only,
        // channel names only (not sensitive). ?full=1 includes the entire EPG name list.
        if (req.url && req.url.split('?')[0] === '/debug/epg') {
            res.setHeader('Content-Type', 'application/json');
            try {
                const full = /[?&]full=1/.test(req.url);
                const report = channelMap.getMatchReport();
                if (!full) report.epgNames = report.epgNames.slice(0, 60); // sample unless ?full=1
                return res.end(JSON.stringify({ epg: epg.getStatus(), report }, null, 2));
            } catch (e) {
                res.statusCode = 500;
                return res.end(JSON.stringify({ error: e.message }));
            }
        }
        // Per-channel schedule dump — diagnoses "guide stuck at 6 PM" issues: shows when the EPG
        // was last fetched, the matched epg id, computed now/next, and the FULL loaded programme
        // list in BOTH UTC and the configured local TZ, so a missing morning/afternoon, a stale
        // cache, or a timezone mismatch is immediately visible. Usage: /debug/schedule?ch=abc
        if (req.url && req.url.split('?')[0] === '/debug/schedule') {
            res.setHeader('Content-Type', 'application/json');
            try {
                const q = new URL(req.url, 'http://x').searchParams.get('ch') || '';
                const ql = q.toLowerCase().trim();
                const roster = data.getRoster();
                const ch = roster.find((c) => c.id === q)
                    || roster.find((c) => (c.name || '').toLowerCase().trim() === ql)
                    || roster.find((c) => (c.name || '').toLowerCase().includes(ql));
                if (!ch) return res.end(JSON.stringify({ error: `no channel matching "${q}"`, hint: 'try ?ch=ABC' }));
                const epgId = channelMap.getEPGChannelId(ch.id);
                const off = epgId ? channelMap.getEPGOffset(ch.id) : 0;
                const fmt = (d) => (d ? d.toLocaleString('en-US', { timeZone: cfg.TZ, hour12: true }) : null);
                const progs = epgId ? epg.getProgrammesFor(epgId) : [];
                const now = epgId ? epg.getNowPlaying(epgId, off) : null;
                const next = epgId ? epg.getUpNext(epgId, off) : null;
                return res.end(JSON.stringify({
                    serverTime: { utc: new Date().toISOString(), local: fmt(new Date()), tz: cfg.TZ },
                    epgStatus: epg.getStatus(),
                    channel: ch.name,
                    epgId: epgId || '(unmatched)',
                    offsetHours: off,
                    nowPlaying: now ? { title: now.title, startLocal: fmt(now.start), stopLocal: fmt(now.stop) } : null,
                    upNext: next ? { title: next.title, startLocal: fmt(next.start) } : null,
                    programmeCount: progs.length,
                    firstProgramme: progs[0] ? { title: progs[0].title, startUtc: progs[0].start.toISOString(), startLocal: fmt(progs[0].start) } : null,
                    lastProgramme: progs.length ? { title: progs[progs.length - 1].title, startUtc: progs[progs.length - 1].start.toISOString(), startLocal: fmt(progs[progs.length - 1].start) } : null,
                    programmes: progs.slice(0, 60).map((p) => ({ startLocal: fmt(p.start), stopLocal: fmt(p.stop), title: p.title })),
                }, null, 2));
            } catch (e) {
                res.statusCode = 500;
                return res.end(JSON.stringify({ error: e.message }));
            }
        }
        // DaddyLive resolver diagnostic — runs the live chain for one dlhd id and reports the
        // resolved master/media URLs, CDN host, and token TTL. Usage: /debug/dlhd?id=44
        if (req.url && req.url.split('?')[0] === '/debug/dlhd') {
            res.setHeader('Content-Type', 'application/json');
            const id = parseInt(new URL(req.url, 'http://x').searchParams.get('id') || '', 10);
            if (!Number.isFinite(id)) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'pass ?id=<dlhd numeric id>, e.g. 44' })); }
            return dlhd.debugResolve(id)
                .then((r) => res.end(JSON.stringify({ enabled: cfg.DLHD_ENABLE, mapped: dlhd.mappedCount(), resolve: r }, null, 2)))
                .catch((e) => { res.statusCode = 502; res.end(JSON.stringify({ error: e.message }, null, 2)); });
        }
        // Damitv resolver diagnostic. Usage: /debug/damitv?id=rally-tv
        if (req.url && req.url.split('?')[0] === '/debug/damitv') {
            res.setHeader('Content-Type', 'application/json');
            const id = new URL(req.url, 'http://x').searchParams.get('id') || '';
            if (!id) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'pass ?id=<source id>, e.g. rally-tv' })); }
            return damitv.debugResolve(id)
                .then((r) => res.end(JSON.stringify({ enabled: cfg.DAMITV_ENABLE, mapped: damitv.mappedCount(), resolve: r }, null, 2)))
                .catch((e) => { res.statusCode = 502; res.end(JSON.stringify({ error: e.message }, null, 2)); });
        }
        router(req, res, () => {
            res.statusCode = 404;
            res.end();
        });
    });
    server.listen(cfg.PORT, cfg.HOST, () => {
        log.info(`Addon running at http://${cfg.HOST}:${cfg.PORT}`);
        log.info(`Manifest:        http://${cfg.HOST}:${cfg.PORT}/manifest.json`);
        const proxyState = cfg.PROXY_DISABLE ? 'disabled (PROXY_DISABLE=1)'
            : cfg.PROXY_PUBLIC_URL ? `on -> ${cfg.PROXY_PUBLIC_URL}`
            : 'auto — activates on the first request via your public URL (set PROXY_PUBLIC_URL to force on now)';
        log.info(`Proxy:           ${proxyState}`);
        log.info(`Health:          http://${cfg.HOST}:${cfg.PORT}/health`);
    });
}

main().catch((err) => {
    log.error(`Fatal error during startup: ${err && err.stack ? err.stack : err}`);
    process.exit(1);
});
