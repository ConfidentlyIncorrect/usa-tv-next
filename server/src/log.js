// log.js — tiny leveled logger with consistent, greppable formatting.
//
// Format:  <ISO-8601 timestamp> <LEVEL> [Component] message
// Example: 2026-05-28T16:04:11.512Z INFO  [DataLayer] Loaded 169 channels from bundled local files
//
// Verbosity is controlled by the LOG_LEVEL env var (error < warn < info < debug).
// Default is "info"; set LOG_LEVEL=debug for the full firehose (per-request routing,
// cache hits/misses, fetch timings, fallback decisions).

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

function currentThreshold() {
    const raw = (process.env.LOG_LEVEL || 'info').toLowerCase().trim();
    return LEVELS[raw] !== undefined ? LEVELS[raw] : LEVELS.info;
}

function emit(level, component, args) {
    if (LEVELS[level] > currentThreshold()) return;
    const ts = new Date().toISOString();
    // Pad level to 5 chars so columns line up: "INFO " / "DEBUG" / "WARN " / "ERROR".
    const tag = level.toUpperCase().padEnd(5, ' ');
    const prefix = `${ts} ${tag} [${component}]`;
    const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    sink(prefix, ...args);
}

/**
 * Create a logger scoped to a component name.
 * @param {string} component e.g. "DataLayer", "EPG", "StreamHandler"
 */
function createLogger(component) {
    return {
        error: (...args) => emit('error', component, args),
        warn: (...args) => emit('warn', component, args),
        info: (...args) => emit('info', component, args),
        debug: (...args) => emit('debug', component, args),
        /**
         * Time an async operation and log its duration at debug level.
         * Returns whatever the wrapped function returns.
         */
        async timed(label, fn) {
            const start = Date.now();
            try {
                const result = await fn();
                emit('debug', component, [`${label} completed in ${Date.now() - start}ms`]);
                return result;
            } catch (err) {
                emit('warn', component, [`${label} failed after ${Date.now() - start}ms: ${err.message}`]);
                throw err;
            }
        },
    };
}

module.exports = createLogger;
