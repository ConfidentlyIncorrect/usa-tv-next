// sd.js — Schedules Direct (json.schedulesdirect.org) EPG provider.
//
// PRIMARY EPG source when SD_USERNAME + SD_PASSWORD are configured; epg.js falls back to the
// epg.pw XMLTV path on ANY failure here (so a misconfigured/expired SD account never breaks
// the guide — it just reverts to the previous behaviour). No extra dependencies: uses the
// global fetch + Node's built-in crypto for the password hash.
//
// SD is a JSON REST API (not an XMLTV download). The flow mirrors epg.js's two-phase shape:
//   Phase A  loadStations():  token -> lineups -> stations  ==> the "channels" map
//            (then epg.js runs the roster matcher to learn which stationIDs we care about)
//   Phase B  loadSchedules(keep):  schedules (programIDs + airDateTime + duration) for the
//            matched stations -> programs (title/desc/genres)  ==> the "programmes" map
//
// Both maps use the SAME shape epg.js's lookups expect, so now-playing/up-next/day-schedule,
// the per-channel offset, the disk cache and the channelMap matcher all work unchanged. SD's
// listings are already feed-/timezone-correct, so most channels need no manual offset.
//
// Docs: https://github.com/SchedulesDirect/JSON-Service/wiki/API-20141201

const crypto = require('crypto');
const cfg = require('./config');
const log = require('./log')('SchedulesDirect');

const USER_AGENT = 'usa-tv-next/1.0 (+https://github.com/ConfidentlyIncorrect/usa-tv-next)';
const TOKEN_TTL_MS = 23 * 60 * 60 * 1000;   // SD tokens last 24h; refresh a little early.
const SCHED_BATCH = 500;                     // stations per /schedules POST (well under SD's cap)
const PROG_BATCH = 5000;                     // programIDs per /programs POST (SD's documented cap)

let _token = '';
let _tokenAt = 0;

function isConfigured() { return !!(cfg.SD_USERNAME && cfg.SD_PASSWORD); }

// AFN (American Forces Network) is a tiny ~14-channel military satellite lineup SD returns even
// for civilian ZIPs — useless for this catalog. Used to avoid auto-picking it and to skip its
// stations when a real lineup is also present.
function _isNicheLineup(id, name) { return /\bafn\b|american forces/i.test(`${id || ''} ${name || ''}`); }

async function _api(method, path, body, useToken = true, _isRetry = false) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.FETCH_TIMEOUT_MS * 4); // SD POSTs can be big
    try {
        const headers = { 'User-Agent': USER_AGENT, Accept: 'application/json' };
        if (body) headers['Content-Type'] = 'application/json';
        if (useToken) headers.token = _token;
        const res = await fetch(cfg.SD_BASE + path, {
            method,
            headers,
            body: body ? JSON.stringify(body) : undefined,
            signal: controller.signal,
        });
        const text = await res.text();
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON error body */ }
        if (!res.ok) {
            // A 403 on an authed call usually means SD revoked the token early. Re-auth once
            // and retry so we self-heal instead of failing over to XMLTV for the whole TTL.
            if (useToken && res.status === 403 && !_isRetry) {
                log.warn('Schedules Direct token rejected (403); re-authenticating and retrying once');
                await _auth(true);
                return _api(method, path, body, useToken, true);
            }
            // Surface SD's own code + message/response so 400s are self-explanatory
            // (e.g. "code 2004: The COUNTRY parameter must be ISO-3166-1 alpha-3.").
            const code = json && json.code;
            const detail = json && (json.message || json.response);
            throw new Error(`${path} HTTP ${res.status}`
                + (code !== undefined && code !== null ? ` code ${code}` : '')
                + (detail ? `: ${detail}` : (text ? `: ${text.slice(0, 200)}` : '')));
        }
        // SD signals app-level failures with a non-zero `code` even on HTTP 200.
        if (json && json.code !== undefined && json.code !== 0) {
            throw new Error(`${path} SD code ${json.code}${json.message ? ` (${json.message})` : ''}`);
        }
        return json;
    } finally {
        clearTimeout(timer);
    }
}

async function _auth(force = false) {
    if (!force && _token && (Date.now() - _tokenAt) < TOKEN_TTL_MS) return;
    const pw = crypto.createHash('sha1').update(cfg.SD_PASSWORD, 'utf8').digest('hex');
    const r = await _api('POST', '/token', { username: cfg.SD_USERNAME, password: pw }, false);
    if (!r || !r.token) throw new Error('token response missing token');
    _token = r.token;
    _tokenAt = Date.now();
    log.info('Authenticated with Schedules Direct');
}

/**
 * Read the account's lineups, tolerating SD's quirk of returning HTTP 400 code 4102
 * ("no lineups added") instead of an empty list for a fresh account (JSON-Service issue #62).
 * Returns { lineups, changesRemaining } and treats the no-lineups 400 as simply empty.
 */
async function _getAccountLineups() {
    try {
        const r = await _api('GET', '/lineups');
        return {
            lineups: (r && r.lineups) || [],
            changesRemaining: (r && typeof r.changesRemaining === 'number') ? r.changesRemaining : null,
        };
    } catch (e) {
        if (/code 4102|NO_LINEUPS/i.test(e.message || '')) return { lineups: [], changesRemaining: null };
        throw e;
    }
}

/**
 * Auto-provision a lineup from SD_ZIP via the SD JSON API so the user never has to curate one.
 * Idempotent + safe: only adds when the account has no lineups (unless SD_FORCE_LINEUP), never
 * removes, respects the daily lineup-change limit, and swallows its own errors (best-effort —
 * loadStations still works off whatever lineups already exist). Prefers a national Satellite
 * lineup (DirecTV/Dish), which carries nearly all national cable/sports/premium nets + the ZIP's
 * local affiliates, so a single lineup covers the whole catalog.
 */
async function ensureLineup() {
    if (!cfg.SD_ZIP) return; // nothing to auto-provision with — user adds lineups manually
    try {
        const cur = await _getAccountLineups();
        const existing = cur.lineups;
        // Treat an account that only has AFN as "needs a lineup" so it still gets a comprehensive
        // one auto-added (heals the earlier bad AFN pick).
        const hasGoodLineup = existing.some((l) => !_isNicheLineup(l.lineup || l.lineupID, l.name));
        if (hasGoodLineup && !cfg.SD_FORCE_LINEUP) return; // already has a usable lineup

        const heads = await _api('GET',
            `/headends?country=${encodeURIComponent(cfg.SD_COUNTRY)}&postalcode=${encodeURIComponent(cfg.SD_ZIP)}`);
        const candidates = [];
        for (const h of heads || []) {
            for (const lu of (h.lineups || [])) {
                if (lu.lineup) candidates.push({ lineup: lu.lineup, name: lu.name || '', transport: h.transport || '' });
            }
        }
        log.info(`SD /headends for ${cfg.SD_COUNTRY} ${cfg.SD_ZIP}: ${candidates.length} lineup candidate(s)`
            + (candidates.length ? ` [${candidates.slice(0, 6).map((c) => `${c.lineup}/${c.transport}`).join(', ')}]` : ''));
        if (!candidates.length) {
            log.warn(`No SD headends/lineups found for ${cfg.SD_COUNTRY} ${cfg.SD_ZIP}; add a lineup manually on the SD site.`);
            return;
        }

        // Rank candidates: prefer national satellite (DirecTV/Dish carry the most channels),
        // hard-avoid the tiny AFN military lineup, then honour the transport preference.
        const order = cfg.SD_TRANSPORT ? [cfg.SD_TRANSPORT] : ['Satellite', 'Cable', 'IPTV', 'Antenna'];
        const transportRank = (t) => {
            const i = order.findIndex((o) => (t || '').toLowerCase().includes(o.toLowerCase()));
            return i === -1 ? 9 : i;
        };
        const score = (c) => {
            const hay = `${c.lineup || ''} ${c.name || ''}`.toLowerCase();
            let s = transportRank(c.transport) * 10;
            if (/ditv|directv|dish/.test(hay)) s -= 100;       // national satellite = best coverage
            if (_isNicheLineup(c.lineup, c.name)) s += 100;    // AFN etc. — last resort
            return s;
        };
        const have = new Set(existing.map((l) => l.lineup || l.lineupID));
        const ranked = candidates.filter((c) => !have.has(c.lineup)).sort((a, b) => score(a) - score(b));
        if (!ranked.length) return; // nothing new to add

        // Decide by ACTUAL channel count: preview the top-ranked candidates and pick the one
        // with the most channels — objectively the comprehensive lineup (DirecTV's hundreds vs
        // AFN's ~14). Preview is read-only and does NOT count against the lineup-change limit.
        let pick = ranked[0];
        let bestCount = -1;
        for (const c of ranked.slice(0, 8)) {
            try {
                const pv = await _api('GET', `/lineups/preview/${encodeURIComponent(c.lineup)}`);
                const count = Array.isArray(pv) ? pv.length : 0;
                log.info(`  candidate ${c.lineup} (${c.transport || '?'} — ${c.name}): ${count} channels`);
                if (count > bestCount) { bestCount = count; pick = c; }
            } catch (e) {
                log.debug(`SD preview ${c.lineup} failed: ${e.message}`);
            }
        }

        const remaining = cur.changesRemaining;
        if (remaining !== null && remaining <= 0) {
            log.warn('SD lineup auto-add skipped: no lineup changes remaining today. Remove an unused '
                + 'lineup or wait for the daily reset (or add one manually on the SD site).');
            return;
        }

        log.info(`Auto-adding SD lineup ${pick.lineup} (${pick.transport || '?'} — ${pick.name}`
            + `${bestCount >= 0 ? `, ~${bestCount} channels` : ''}) for ${cfg.SD_COUNTRY} ${cfg.SD_ZIP} ...`);
        await _api('PUT', `/lineups/${encodeURIComponent(pick.lineup)}`);
        log.info(`SD lineup ${pick.lineup} added to the account.`);
    } catch (e) {
        log.warn(`SD lineup auto-provision failed (${e.message}); using whatever lineups already exist.`);
    }
}

/** Phase A: authenticate, auto-provision a lineup if needed, then collect all lineup stations. */
async function loadStations() {
    await _auth();
    await ensureLineup();
    const lineups = (await _getAccountLineups()).lineups;
    if (!lineups.length) {
        log.warn('Schedules Direct account has no lineups — set SD_ZIP to auto-add one, add one '
            + 'on the SD website, or unset SD_USERNAME to use epg.pw. Falling back for now.');
        return new Map();
    }

    // If a real lineup is present, skip AFN's ~14 military channels so they don't pollute the
    // station pool (and cause bogus matches like Ion -> NPR).
    const hasGood = lineups.some((l) => !_isNicheLineup(l.lineup || l.lineupID, l.name));

    const stations = new Map(); // stationID -> { name, icon }
    for (const lu of lineups) {
        const lineupId = lu.lineup || lu.lineupID || '';
        if (cfg.SD_LINEUP && !String(lineupId).toLowerCase().includes(cfg.SD_LINEUP.toLowerCase())) continue;
        if (hasGood && _isNicheLineup(lineupId, lu.name)) {
            log.info(`Skipping niche lineup ${lineupId} (a comprehensive lineup is present)`);
            continue;
        }
        try {
            // NOTE: do NOT use lu.uri here — SD returns it WITH the API-version prefix
            // ("/20141201/lineups/X"), and _api prepends SD_BASE (which already ends in
            // /20141201), so lu.uri would double the prefix and 404. Use the version-less path.
            const d = await _api('GET', `/lineups/${encodeURIComponent(lineupId)}`);
            for (const s of (d && d.stations) || []) {
                if (!s.stationID) continue;
                const name = (s.name || s.callsign || s.stationID || '').trim();
                let icon = '';
                if (s.logo && s.logo.URL) icon = s.logo.URL;
                else if (Array.isArray(s.stationLogo) && s.stationLogo[0] && s.stationLogo[0].URL) icon = s.stationLogo[0].URL;
                // Keep the first occurrence; lineups can overlap on common cable nets.
                if (!stations.has(s.stationID)) stations.set(s.stationID, { name, icon });
            }
        } catch (e) {
            log.warn(`Lineup ${lineupId} fetch failed: ${e.message}`);
        }
    }
    log.info(`Schedules Direct: ${stations.size} stations across ${lineups.length} lineup(s)`);
    return stations;
}

function _dateRange(days) {
    const out = [];
    const base = Date.now();
    for (let i = 0; i < days; i++) {
        out.push(new Date(base + i * 86400000).toISOString().slice(0, 10)); // YYYY-MM-DD (UTC)
    }
    return out;
}

/**
 * Phase B: for the matched station ids, pull schedules then program metadata and build the
 * programmes map (same shape as the XMLTV path). `keep` is the Set of stationIDs from the
 * roster match; if null/empty we return an empty map (nothing matched -> nothing to fetch).
 */
async function loadSchedules(keep) {
    const stationIds = keep instanceof Set ? [...keep] : Array.isArray(keep) ? keep : [];
    if (!stationIds.length) return new Map();
    await _auth();
    const dates = _dateRange(cfg.SD_DAYS);

    // 1) /schedules -> per-station list of { programID, start, stop }
    const stationProgs = new Map(); // stationID -> [{ programID, start, stop }]
    const neededProgramIds = new Set();
    for (let i = 0; i < stationIds.length; i += SCHED_BATCH) {
        const batch = stationIds.slice(i, i + SCHED_BATCH).map((id) => ({ stationID: id, date: dates }));
        const resp = await _api('POST', '/schedules', batch);
        for (const st of resp || []) {
            if (!st || !st.stationID || !Array.isArray(st.programs)) continue;
            const list = [];
            for (const p of st.programs) {
                if (!p.programID || !p.airDateTime) continue;
                const start = new Date(p.airDateTime);
                if (isNaN(start.getTime())) continue;
                const stop = p.duration ? new Date(start.getTime() + p.duration * 1000) : null;
                list.push({ programID: p.programID, start, stop });
                neededProgramIds.add(p.programID);
            }
            if (list.length) stationProgs.set(st.stationID, list);
        }
    }
    if (stationProgs.size === 0) return new Map();

    // 2) /programs -> title / description / genres for the unique programIDs (cap-batched)
    const progMeta = new Map(); // programID -> { title, desc, categories }
    const allProgIds = [...neededProgramIds];
    for (let i = 0; i < allProgIds.length; i += PROG_BATCH) {
        const batch = allProgIds.slice(i, i + PROG_BATCH);
        let resp;
        try {
            resp = await _api('POST', '/programs', batch);
        } catch (e) {
            // Program details are enrichment, not load-bearing — keep titles empty rather
            // than abandoning the whole guide if one programs batch fails.
            log.warn(`programs batch failed (${e.message}); those entries will lack titles`);
            continue;
        }
        for (const pr of resp || []) {
            if (!pr || !pr.programID) continue;
            const title = (pr.titles && pr.titles[0] && (pr.titles[0].title120 || pr.titles[0].title)) || '';
            let desc = '';
            const d = pr.descriptions || {};
            if (Array.isArray(d.description1000) && d.description1000[0]) desc = d.description1000[0].description || '';
            else if (Array.isArray(d.description100) && d.description100[0]) desc = d.description100[0].description || '';
            const categories = Array.isArray(pr.genres) ? pr.genres.slice() : [];
            progMeta.set(pr.programID, { title: String(title).trim(), desc: String(desc).trim(), categories });
        }
    }

    // 3) join into the programmes map (epg.js's exact shape; sorted by start)
    const programmes = new Map();
    for (const [stationID, list] of stationProgs) {
        const arr = [];
        for (const e of list) {
            const meta = progMeta.get(e.programID) || { title: '', desc: '', categories: [] };
            arr.push({
                start: e.start,
                stop: e.stop,
                title: meta.title,
                desc: meta.desc,
                categories: meta.categories,
                icon: '',
            });
        }
        arr.sort((a, b) => a.start - b.start);
        if (arr.length) programmes.set(stationID, arr);
    }
    log.info(`Schedules Direct: ${programmes.size} stations with schedules, ${allProgIds.length} programs (${cfg.SD_DAYS}d)`);
    return programmes;
}

module.exports = { isConfigured, loadStations, loadSchedules };
