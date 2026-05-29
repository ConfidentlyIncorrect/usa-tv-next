// metaHandler.js — channel detail view with full EPG day schedule.
//
// Builds NOW PLAYING / UP NEXT / today's schedule into `description`.
//
// CLIENT-RENDERING NOTES (verified against client source):
//   • Stremio: shows `meta.description` on the detail/board page.
//   • Nuvio (Android TV + mobile): its content mapper sets the detail synopsis from
//     `meta.description` ONLY (no fallback to plot/overview), maps `meta.background`
//     -> banner, and applies NO `type === 'tv'` special-casing — so a channel renders
//     through the identical path as a movie and the EPG text lands in the same place as
//     a movie synopsis (after the channel is picked, before choosing a stream).
//   Therefore `description` MUST carry the EPG text and MUST lead with the most useful
//   line (NOW PLAYING), so it reads well even where the synopsis box is line-clamped.
//   `plot`/`overview` are kept purely as belt-and-suspenders for other/older clients.

const cfg = require('./config');
const epg = require('./epg');
const data = require('./data');
const channelMap = require('./channelMap');
const log = require('./log')('MetaHandler');

const FALLBACK_POSTER = 'https://raw.githubusercontent.com/ConfidentlyIncorrect/usa-tv-next/main/public/logo.png';
const FALLBACK_BACKGROUND = 'https://raw.githubusercontent.com/ConfidentlyIncorrect/usa-tv-next/main/public/background.jpg';

function formatTime(date) {
    if (!date) return '';
    return date.toLocaleTimeString('en-US', {
        hour: 'numeric', minute: '2-digit', hour12: true, timeZone: cfg.TZ,
    });
}

async function handleMeta({ type, id }) {
    log.debug(`meta request: type=${type} id=${id}`);
    if (type !== 'tv' || !id || !id.startsWith('ustv')) {
        log.debug(`Ignoring unsupported meta request (type=${type}, id=${id})`);
        return { meta: {} };
    }

    try { await epg.ensureLoaded(); } catch (err) { log.warn(`ensureLoaded failed (continuing): ${err.message}`); }

    try {
        const ch = data.getChannelById(id);
        if (!ch) {
            log.warn(`No channel in roster for id ${id}`);
            return { meta: {} };
        }

        const epgId = channelMap.getEPGChannelId(id);
        const now = epgId ? epg.getNowPlaying(epgId) : null;
        const next = epgId ? epg.getUpNext(epgId) : null;
        const schedule = epgId ? epg.getDaySchedule(epgId) : [];

        const descLines = [];
        if (now) {
            descLines.push(`▶ NOW PLAYING: ${now.title}`);
            descLines.push(`  ${formatTime(now.start)} - ${now.stop ? formatTime(now.stop) : 'TBD'}`);
            if (now.desc) descLines.push(`  ${now.desc}`);
            if (now.categories && now.categories.length) descLines.push(`  Category: ${now.categories.join(', ')}`);
            descLines.push('');
        }
        if (next) {
            descLines.push(`⏭ UP NEXT: ${next.title} (${formatTime(next.start)})`);
            if (next.desc) descLines.push(`  ${next.desc.length > 100 ? next.desc.slice(0, 97) + '...' : next.desc}`);
            descLines.push('');
        }
        if (schedule.length > 0) {
            descLines.push(`📺 TODAY'S SCHEDULE (${cfg.TZ.replace('America/', '').replace('_', ' ')}):`);
            descLines.push('─'.repeat(30));
            for (const prog of schedule.slice(0, 20)) {
                const isNow = now && prog.start.getTime() === now.start.getTime();
                descLines.push(`${isNow ? '▶ ' : '  '}${formatTime(prog.start)} ${prog.title}`);
            }
            if (schedule.length > 20) descLines.push(`  ... and ${schedule.length - 20} more programs`);
        }
        if (descLines.length === 0) {
            // Never leave the synopsis empty — an empty description can make the detail
            // page look broken on TV clients. Show channel identity + a clear hint.
            descLines.push(ch.name);
            const genreLabel = (ch.genres && ch.genres[0]) || ch.genre;
            if (genreLabel) descLines.push(`${genreLabel} • Live TV`);
            descLines.push('');
            descLines.push('Live channel — select a stream below to start watching.');
            descLines.push('No program guide data is currently available for this channel.');
        }

        const description = descLines.join('\n');
        log.debug(`meta for ${id} ("${ch.name}"): epgId=${epgId || 'none'}, schedule=${schedule.length} programs`);

        return {
            meta: {
                id: ch.id,
                type: 'tv',
                name: ch.name,
                poster: ch.poster || ch.logo || FALLBACK_POSTER,
                posterShape: 'landscape',
                logo: ch.logo || '',
                // Nuvio maps `background` -> detail-page banner; never leave it empty.
                background: ch.poster || ch.logo || FALLBACK_BACKGROUND,
                // `description` is the field Nuvio actually reads for the synopsis.
                // plot/overview are duplicated only for other/older clients.
                description,
                plot: description,
                overview: description,
                genres: ch.genres || [ch.genre].filter(Boolean),
                releaseInfo: now ? now.title : undefined,
            },
            cacheMaxAge: cfg.RESPONSE_CACHE_SECS,
        };
    } catch (err) {
        log.error(`Error building meta for ${id}: ${err.message}`);
        return { meta: {}, cacheMaxAge: 60 };
    }
}

module.exports = { handleMeta };
