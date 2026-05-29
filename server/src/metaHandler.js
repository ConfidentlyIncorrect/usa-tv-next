// metaHandler.js — channel detail view with full EPG day schedule.
//
// Builds NOW PLAYING / UP NEXT / today's schedule into description (and duplicates into
// plot + overview for client compatibility — different Stremio clients read different
// fields). Roster comes from the shared data layer; EPG from epg.js.

const cfg = require('./config');
const epg = require('./epg');
const data = require('./data');
const channelMap = require('./channelMap');
const log = require('./log')('MetaHandler');

const FALLBACK_POSTER = 'https://raw.githubusercontent.com/ConfidentlyIncorrect/usa-tv-next/main/public/logo.png';

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
            descLines.push('No EPG guide data available for this channel.');
            descLines.push('The channel is still playable.');
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
                background: ch.poster || '',
                // Main field + compatibility duplicates (clients vary on which they read).
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
