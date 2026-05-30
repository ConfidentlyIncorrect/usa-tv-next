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

    // 3. Fresh EPG download + parse. On failure it retains the cache loaded in step 1.
    log.info('Loading EPG data (the ~188 MB feed can take up to a minute) ...');
    await epg.fetchEPG();

    // 4. Map roster channels to EPG ids; persists the matched EPG subset to disk.
    channelMap.buildChannelMap();

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
    await epg.fetchEPG();
    channelMap.buildChannelMap(); // EPG changed -> rebuild map (+ re-persist cache)
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
            }));
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
