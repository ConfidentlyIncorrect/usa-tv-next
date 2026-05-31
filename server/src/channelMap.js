// channelMap.js — map USA TV Next channels to epg.pw EPG channel ids.
//
// Ported from the standalone EPG addon. The ONLY structural change: the channel roster
// now comes from the shared data layer (data.getRoster()) instead of this module
// fetching all.json itself. The roster's own resilience (fetch -> emergency cache ->
// bundled local) lives in data.js, so channelMap just consumes whatever it provides.
//
// Matching strategy per channel:
//   1. Manual override table (curated name -> EPG display-name substring)
//   2. Exact case-insensitive name match
//   3. Fuzzy match via Fuse.js (threshold-gated)
// After building the map, the matched EPG ids are handed to epg.persistCache() so the
// guide survives an epg.pw outage on the next cold start.

const Fuse = require('fuse.js');

const data = require('./data');
const epg = require('./epg');
const log = require('./log')('ChannelMap');

let channelMap = new Map(); // ustvId -> epgId

// Per-channel EPG time offset (HOURS) — feed alignment. Our guide matches mostly EAST feeds
// (see overrides), and most streams are East, so the default is 0 and now-playing is already
// correct from the absolute schedule. Add an entry (USATV name lowercased -> hours) for any
// channel whose STREAM is a different feed than the matched guide, to shift "now": e.g. a
// West/Pacific-feed stream on an East guide -> 3. Looked up by getEPGOffset() and applied in
// epg.getNowPlaying/getUpNext/getDaySchedule.
const EPG_OFFSET_HOURS = {
    // 'example west-feed channel': 3,
};

// Manual overrides: USATV name (lowercase) -> EPG display-name substring
const MANUAL_OVERRIDES = {
    'abc': 'ABC National Feed',
    'cbs': 'CBS National Feed',
    'cw': 'CW Network',
    'fox': 'Fox National Feed',
    'nbc': 'NBC National Feed',
    'pbs': 'PBS',
    'cnn': 'CNN HD',
    'fox news': 'Fox News Channel HD',
    'fox business': 'Fox Business HD',
    'msnbc': 'MSNBC HD',
    'espn': 'ESPN HD',
    'espn 2': 'ESPN2 HD',
    'espnews': 'ESPNews HD',
    'espnu': 'ESPNU HD',
    'tbs': 'TBS HD',
    'tnt': 'TNT HD',
    'usa network': 'USA Network HD',
    'fx': 'FX HD',
    'fxx': 'FXX HD',
    'syfy': 'SYFY HD',
    'bravo': 'Bravo HD',
    'e! entertainment television': 'E! HD',
    'a&e': 'A and E HD',
    'amc': 'AMC HD',
    'bet': 'BET HD',
    'comedy central': 'Comedy Central HD',
    'discovery channel': 'Discovery Channel HD',
    'history': 'History Channel HD',
    'hbo': 'HBO East',
    'hbo 2': 'HBO 2 East',
    'showtime': 'Showtime East',
    'starz': 'Starz East',
    'national geographic': 'National Geographic HD',
    'animal planet': 'Animal Planet HD',
    'food network': 'Food Network HD',
    'hgtv': 'HGTV HD',
    'tlc': 'TLC HD',
    'cartoon network': 'Cartoon Network',
    'nickelodeon': 'Nickelodeon HD',
    'disney channel': 'Disney Channel',
    'hallmark channel': 'Hallmark Channel HD',
    'lifetime': 'Lifetime HD',
    'paramount network': 'Paramount Network HD',
    'travel channel': 'Travel Channel HD',
    'golf channel': 'Golf Channel HD',
    'nfl network': 'NFL Network HD',
    'nba tv': 'NBA TV HD',
    'mlb network': 'MLB Network HD',
    'nhl network': 'NHL Network',
    'fs1': 'FS1 HD',
    'fs2': 'FS2 HD',
    'sec network': 'SEC Network HD',
    'acc network': 'ACC Network',
    'big ten network': 'Big Ten Network HD',
    'cnbc': 'CNBC HD',
    'bloomberg tv': 'Bloomberg HD',
    'tcm': 'TCM Turner Classic Movies',
    'cinemax': 'Cinemax',
    'cooking channel': 'Cooking Channel HD',
    'freeform': 'Freeform HD',
    'mtv': 'MTV HD',
    'vh1': 'VH1 HD',
    'cmt': 'CMT HD',
    'oxygen true crime': 'Oxygen HD',
    'investigation discovery': 'Investigation Discovery HD',
    'science channel': 'Science Channel HD',
    'disney jr': 'Disney Junior',
    'disney xd': 'Disney XD',
    'nick jr': 'Nick Jr',
    'boomerang': 'Boomerang',
    'hallmark mystery': 'Hallmark Mystery',
    'ifc': 'IFC HD',
    'sundance tv': 'SundanceTV HD',
    'bbc america': 'BBC America HD',
    'bbc news': 'BBC News (North America) HD',
    'tv land': 'TV Land HD',
    'we tv': 'WE tv HD',
    'newsmax': 'Newsmax HD',
    'newsnation': 'NewsNation HD',
    'court tv': 'Court TV HD',
    'the weather channel': 'The Weather Channel HD',
    'fox weather': 'Fox Weather HD',
    'hln': 'HLN HD',
    'reelz': 'Reelz HD',
    'destination america': 'Destination America HD',
    'discovery life': 'Discovery Life HD',
    'motortrend': 'MotorTrend HD',
    'fyi': 'FYI HD',
    'crime + investigation': 'Crime and Investigation HD',
    'telemundo': 'Telemundo',
    'univision': 'Univision',
    'espn deportes': 'ESPN Deportes',
    'fox deportes': 'Fox Deportes',
    'nicktoons': 'Nicktoons HD',
    'teennick': 'TeenNick HD',
    'game show network': 'Game Show Network HD',
    'ion': 'ION Television',
    'discovery family': 'Discovery Family Channel HD',
    'universal kids': 'Universal Kids',
    'nfl redzone': 'NFL RedZone HD',
    'tennis channel': 'Tennis Channel HD',
    'sportsman channel': 'Sportsman Channel HD',
    'axs tv': 'AXS TV',
    'marquee sports network': 'Marquee Sports Network',
    'nesn': 'NESN HD',
    'yes network': 'YES Network HD',
    'msg': 'MSG HD',
    'spectrum sportsnet la': 'Spectrum SportsNet LA',
    'c-span 1': 'C-SPAN',
    'fx movie channel': 'FX Movie Channel',
    'starz cinema': 'Starz Cinema',
    'starz comedy': 'Starz Comedy',
    'hbo comedy': 'HBO Comedy',
    'hbo family': 'HBO Family',
    'hbo signature': 'HBO Signature',
    'hbo zone': 'HBO Zone',
    'showtime 2': 'Showtime 2',
    'showtime women': 'Showtime Women',
    'mgm+': 'MGM Plus HD',
    '5starmax': '5 StarMAX HD',
    'moremax': 'MoreMAX HD',
    'vice tv': 'Vice TV HD',
    'aspire': 'ASPiRE HD',
    'bet her': 'BET Her',
    'cleo tv': 'Cleo TV',
    'oprah winfrey network (own)': 'OWN HD',
    'outdoor channel': 'Outdoor Channel HD',
    'world fishing network': 'World Fishing Network',
    'outside tv': 'Outside Television',
    'grit': 'Grit TV',
    'buzzr': 'BUZZR',
    'comet': 'Comet TV',
    'bounce': 'Bounce TV',
    'laff': 'Laff TV',
    'charge!': 'Charge!',
    'metv': 'MeTV',
    'metv toons': 'MeTV Toons',
    'pbs kids': 'PBS Kids',
    'lifetime movie network': 'Lifetime Movie Network HD',
    'tv one': 'TV One HD',
    'revolt': 'Revolt TV',
    'fuse': 'Fuse HD',
};

// SD-specific exact-name overrides: roster name (lowercased+trimmed) -> EXACT Schedules Direct
// station name. Highest priority, and binds ONLY when that exact name exists in the active EPG
// source — so it precisely fixes SD mismatches yet is a no-op on the epg.pw fallback (which keeps
// using MANUAL_OVERRIDES). Broadcast nets map to the LOCAL (Denver / SD_ZIP DMA) affiliate
// callsigns since SD has no "national" broadcast feed and the local affiliate matches the TZ —
// change these to your market's callsigns if SD_ZIP is not a Denver ZIP.
const SD_OVERRIDES = {
    // Broadcast affiliates (Denver DMA)
    'abc': 'KMGH', 'cbs': 'KCNC', 'nbc': 'KUSA', 'fox': 'KDVR', 'cw': 'KWGN', 'pbs': 'KRMA',
    // Cable nets whose SD name differs, or that fuzzy mis-bound to the wrong station
    'bet her': 'BET Her',
    'e! entertainment television': 'E! Entertainment Television',
    'espn 2': 'ESPN2',
    'espn deportes': 'ESPN Deportes',
    'espnews': 'ESPNEWS',
    'fx movie channel': 'FX Movie Channel HD',
    'fxx': 'FXX',
    'hbo comedy': 'HBO Comedy HD',
    'lifetime movie network': 'LMN',
    'metv': 'Me TV Network',
    'mtv': 'MTV - Music Television',
    'msnbc': 'MS NOW',                 // MSNBC rebranded to "MS NOW"
    'oprah winfrey network (own)': 'Oprah Winfrey Network',
    'showtime': 'Paramount+ with Showtime',
    'showtime 2': 'SHO 2',
    'starz cinema': 'Starz Cinema HD',
    'starz comedy': 'Starz Comedy HD',
    'cheddar news': 'Cheddar',
    'hgtv': 'Home & Garden Television',   // acronym vs full SD name
    'accuweather now': 'AccuWeather HD',
    'cine sony': 'Sony Cine',
    // Regional sports networks (national/out-of-market feeds in SD)
    'yes network': 'YES Network National Feed HD',
    'nesn': 'New England Sports Network National HD',
    'chicago sports network': 'CHSN Blackout',
    'fanduel detroit': 'FanDuel Sports Network Detroit HD- Out of Market',
};

/**
 * Rebuild the ustvId -> epgId map from the current roster (data.getRoster()) and the
 * current EPG channel list (epg.getEPGChannels()). No-op if either side is empty.
 * After a successful build, persists the EPG cache for the matched channels.
 */
function buildChannelMap() {
    const epgChannels = epg.getEPGChannels();
    const ustvChannels = data.getRoster();

    if (epgChannels.size === 0 || ustvChannels.length === 0) {
        log.warn(`Not enough data to build map yet (epg=${epgChannels.size}, roster=${ustvChannels.length})`);
        return;
    }

    const epgEntries = [];
    for (const [id, meta] of epgChannels) {
        epgEntries.push({ id, name: meta.name, nameLower: meta.name.toLowerCase() });
    }

    const fuse = new Fuse(epgEntries, { keys: ['name'], threshold: 0.3, includeScore: true });

    const newMap = new Map();
    let matched = 0, manual = 0, fuzzy = 0, missed = 0;

    for (const ch of ustvChannels) {
        const ustvName = (ch.name || '').trim();
        const ustvNameLower = ustvName.toLowerCase().trim();

        // 0. Schedules Direct exact-name override (highest priority; precise pin). Binds only
        //    when that exact SD name exists, so it's a no-op on the epg.pw fallback.
        if (SD_OVERRIDES[ustvNameLower]) {
            const t = SD_OVERRIDES[ustvNameLower].toLowerCase();
            const hit = epgEntries.find((e) => e.nameLower === t);
            if (hit) { newMap.set(ch.id, hit.id); matched++; manual++; continue; }
        }

        // 1. Manual override
        if (MANUAL_OVERRIDES[ustvNameLower]) {
            const target = MANUAL_OVERRIDES[ustvNameLower].toLowerCase();
            const found = epgEntries.find((e) => e.nameLower.includes(target) || target.includes(e.nameLower));
            if (found) { newMap.set(ch.id, found.id); matched++; manual++; continue; }
            const fr = fuse.search(MANUAL_OVERRIDES[ustvNameLower]);
            if (fr.length > 0 && fr[0].score < 0.35) { newMap.set(ch.id, fr[0].item.id); matched++; manual++; continue; }
        }

        // 2. Exact match (case-insensitive)
        const exact = epgEntries.find((e) => e.nameLower === ustvNameLower);
        if (exact) { newMap.set(ch.id, exact.id); matched++; continue; }

        // 3. Fuzzy match — stricter threshold (0.30) so a weak match doesn't bind a channel
        //    to the WRONG guide (a wrong match is worse than no guide); near-misses are logged.
        const results = fuse.search(ustvName);
        if (results.length > 0 && results[0].score < 0.30) {
            newMap.set(ch.id, results[0].item.id); matched++; fuzzy++;
        } else {
            missed++;
            const best = results[0];
            if (best && best.score < 0.45) {
                log.info(`EPG near-miss (not bound): "${ustvName}" ~ "${best.item.name}" @ ${best.score.toFixed(2)}`);
            } else {
                log.debug(`No EPG match for "${ustvName}" (best: ${best?.item?.name || 'none'} @ ${best?.score?.toFixed(2) || 'N/A'})`);
            }
        }
    }

    channelMap = newMap;
    log.info(`Mapping complete: ${matched}/${ustvChannels.length} matched (${manual} manual, ${fuzzy} fuzzy, ${missed} missed)`);
    // NOTE: epg.persistCache() now runs inside epg.fetchEPG() AFTER programmes are parsed
    // (programmes don't exist yet at match time in the streaming flow).
}

function getEPGChannelId(ustvId) { return channelMap.get(ustvId) || null; }
function getMatchCount() { return channelMap.size; }
function matchedEpgIds() { return new Set(channelMap.values()); }

// Per-channel feed offset in hours, looked up by the catalog/meta handlers.
function getEPGOffset(ustvId) {
    const ch = data.getRoster().find((c) => c.id === ustvId);
    const name = ch ? (ch.name || '').toLowerCase().trim() : '';
    return EPG_OFFSET_HOURS[name] || 0;
}

/**
 * Diagnostic report for tuning the EPG match (served at /debug/epg). Shows what the active EPG
 * source (epg.pw or Schedules Direct) actually provides vs the roster: matched pairs, unmatched
 * roster channels with their closest candidate (looser fuse, for visibility only — not binding),
 * and the full list of available EPG channel names. Used to build accurate name overrides.
 */
function getMatchReport() {
    const epgChannels = epg.getEPGChannels();
    const roster = data.getRoster();
    const epgEntries = [];
    for (const [id, meta] of epgChannels) epgEntries.push({ id, name: meta.name || '' });
    const fuse = new Fuse(epgEntries, { keys: ['name'], threshold: 0.6, includeScore: true });

    const matched = [];
    const unmatched = [];
    for (const ch of roster) {
        const epgId = channelMap.get(ch.id);
        if (epgId) {
            const meta = epgChannels.get(epgId);
            matched.push({ channel: ch.name, epg: meta ? meta.name : epgId });
        } else {
            const r = fuse.search(ch.name || '')[0];
            unmatched.push({
                channel: ch.name,
                bestCandidate: r ? r.item.name : null,
                score: r ? Number(r.score.toFixed(2)) : null,
            });
        }
    }
    return {
        epgChannelCount: epgChannels.size,
        matchedCount: matched.length,
        unmatchedCount: unmatched.length,
        matched: matched.sort((a, b) => a.channel.localeCompare(b.channel)),
        unmatched: unmatched.sort((a, b) => a.channel.localeCompare(b.channel)),
        epgNames: epgEntries.map((e) => e.name).sort((a, b) => a.localeCompare(b)),
    };
}

module.exports = { buildChannelMap, getEPGChannelId, getMatchCount, matchedEpgIds, getEPGOffset, getMatchReport };
