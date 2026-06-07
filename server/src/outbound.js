// outbound.js — optional egress proxy for DaddyLive traffic only (split tunnel).
//
// WHY: DaddyLive's premium embed + CDN origins drop datacenter/VPS egress IPs (the main
// dlhd.pk site is reachable, but the embed/CDN time out from a VPS — "cannot reach ...:
// CONNECT_TIMEOUT"). A VPN exit fixes it, but routing the WHOLE addon through a VPN is
// undesirable (it would also tunnel EPG/GitHub/iptv-org/Tubi and can break the public Funnel
// inbound). So we tunnel ONLY the dlhd fetches — the resolver chain and the CDN segments —
// through a proxy on a residential/VPN exit (e.g. a gluetun sidecar's HTTP proxy), leaving
// everything else direct.
//
// Node's global fetch is undici, and it accepts any undici Dispatcher via the `dispatcher`
// option. We build a ProxyAgent once (lazily) from DLHD_OUTBOUND_PROXY and hand it to the
// dlhd fetches. If the proxy isn't configured we return undefined (= direct, normal fetch).
// If the `undici` package isn't installed we log once and fall back to direct, so the addon
// still runs (DaddyLive just stays subject to the IP block).

const cfg = require('./config');
const log = require('./log')('Outbound');

let _agent;          // undici ProxyAgent | undefined
let _initialised = false;

/** The undici Dispatcher to route DaddyLive requests through, or undefined for a direct fetch. */
function dlhdDispatcher() {
    if (!cfg.DLHD_OUTBOUND_PROXY) return undefined;
    if (!_initialised) {
        _initialised = true;
        try {
            const { ProxyAgent } = require('undici');
            _agent = new ProxyAgent(cfg.DLHD_OUTBOUND_PROXY);
            log.info(`DaddyLive egress -> proxy ${cfg.DLHD_OUTBOUND_PROXY} (split tunnel; other sources stay direct)`);
        } catch (err) {
            log.warn(`DLHD_OUTBOUND_PROXY set but couldn't init undici ProxyAgent (${err.message}); `
                + 'DaddyLive will egress directly. Ensure "undici" is installed.');
            _agent = undefined;
        }
    }
    return _agent;
}

/** Whether DaddyLive egress is being tunnelled (for diagnostics). */
function dlhdProxied() {
    return !!cfg.DLHD_OUTBOUND_PROXY;
}

module.exports = { dlhdDispatcher, dlhdProxied };
