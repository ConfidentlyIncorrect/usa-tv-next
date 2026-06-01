// catalogHandler.js — catalog board with EPG-enriched names + descriptions.
//
// Catalog id "all" (preserving the original USA TV Next catalog). Each channel's name
// is enriched with its current programme ("Channel - Now Playing Title") and the
// description shows NOW / NEXT. Roster comes from the shared data layer; EPG lookups
// from epg.js via the ustvId -> epgId map.

const cfg = require('./config');
const epg = require('./epg');
const data = require('./data');
const channelMap = require('./channelMap');
const log = require('./log')('CatalogHandler');

const PAGE_SIZE = 100;
const FALLBACK_POSTER = 'https://raw.githubusercontent.com/ConfidentlyIncorrect/usa-tv-next/main/public/logo.png';
const FALLBACK_BACKGROUND = 'https://raw.githubusercontent.com/ConfidentlyIncorrect/usa-tv-next/main/public/background.jpg';

function formatTime(date) {
    if (!date) return '';
    return date.toLocaleTimeString('en-US', {
        hour: 'numeric', minute: '2-digit', hour12: true, timeZone: cfg.TZ,
    });
}

function formatTimeRange(start, stop) {
    const s = formatTime(start);
    const e = stop ? formatTime(stop) : '';
    return e ? `${s} - ${e}` : s;
}

function buildDescription(ch) {
    const epgId = channelMap.getEPGChannelId(ch.id);
    if (!epgId) return ch.name;
    const off = channelMap.getEPGOffset(ch.id);
    const now = epg.getNowPlaying(epgId, off);
    const next = epg.getUpNext(epgId, off);
    const lines = [];
    if (now) {
        lines.push(`▶ NOW: ${now.title}`);
        lines.push(`  ${formatTimeRange(now.start, now.stop)}`);
        if (now.desc) {
            const shortDesc = now.desc.length > 120 ? now.desc.slice(0, 117) + '...' : now.desc;
            lines.push(`  ${shortDesc}`);
        }
    }
    if (next) lines.push(`⏭ NEXT: ${next.title} (${formatTime(next.start)})`);
    if (lines.length === 0) lines.push('No guide data available');
    return lines.join('\n');
}

// Catalog/grid title stays the clean channel name. The now-playing is NOT baked into the title
// here because the catalog is a bulk, client-cached response — a baked title goes stale against the
// always-fresh detail screen. The live NOW/NEXT is carried per-item as `epgSchedule` (below) and the
// NuvioTV fork recomputes the hover blurb from it on a clock, so the grid stays current.
function buildCatalogName(ch) {
    return ch.name;
}

async function handleCatalog({ type, id, extra }) {
    log.debug(`catalog request: type=${type} id=${id} extra=${JSON.stringify(extra || {})}`);
    if (type !== 'tv' || id !== 'all') {
        log.debug(`Ignoring unsupported catalog request (type=${type}, id=${id})`);
        return { metas: [] };
    }

    try { await epg.ensureLoaded(); } catch (err) { log.warn(`ensureLoaded failed (continuing): ${err.message}`); }

    try {
        const channels = data.getRoster();
        let filtered = [...channels];

        if (extra && extra.search) {
            const query = extra.search.toLowerCase();
            filtered = filtered.filter((ch) => {
                if (ch.name.toLowerCase().includes(query)) return true;
                const epgId = channelMap.getEPGChannelId(ch.id);
                if (epgId) {
                    const now = epg.getNowPlaying(epgId);
                    if (now && now.title.toLowerCase().includes(query)) return true;
                }
                return false;
            });
            log.debug(`search "${extra.search}" -> ${filtered.length} matches`);
        } else if (extra && extra.genre) {
            filtered = filtered.filter((ch) => {
                const genres = ch.genres || [ch.genre];
                return genres.some((g) => g && g.toLowerCase() === extra.genre.toLowerCase());
            });
            log.debug(`genre "${extra.genre}" -> ${filtered.length} matches`);
        }

        const skip = (extra && extra.skip) ? parseInt(extra.skip, 10) : 0;
        const page = filtered.slice(skip, skip + PAGE_SIZE);

        const metas = page.map((ch) => {
            const epgId = channelMap.getEPGChannelId(ch.id);
            const off = epgId ? channelMap.getEPGOffset(ch.id) : 0;
            // Compact absolute-time window (no synopsis, capped small) so the NuvioTV fork's home
            // hero recomputes the focused channel's NOW/NEXT live on a clock — the grid no longer
            // goes stale against the detail screen. `description` stays as the baked fallback for
            // clients that don't read epgSchedule.
            const sched = epgId ? epg.getGuideWindow(epgId, off, 16, false) : [];
            return {
                id: ch.id,
                type: 'tv',
                name: buildCatalogName(ch),
                poster: ch.poster || ch.logo || FALLBACK_POSTER,
                posterShape: 'landscape',
                // NuvioTV (verified: MetaPreviewDto.landscapePoster) uses this for cards.
                landscapePoster: ch.poster || ch.logo || FALLBACK_POSTER,
                description: buildDescription(ch),
                genres: ch.genres || [ch.genre].filter(Boolean),
                logo: ch.logo || '',
                background: ch.poster || ch.logo || FALLBACK_BACKGROUND,
                ...(sched.length ? { epgSchedule: sched } : {}),
            };
        });

        log.debug(`Returning ${metas.length} metas (skip=${skip}, total filtered=${filtered.length})`);
        return { metas, cacheMaxAge: cfg.RESPONSE_CACHE_SECS };
    } catch (err) {
        log.error(`Error building catalog: ${err.message}`);
        return { metas: [], cacheMaxAge: 60 };
    }
}

module.exports = { handleCatalog };
