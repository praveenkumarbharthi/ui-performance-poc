'use strict';

/**
 * Minimal dependency-free logger.
 *
 * - Respects LOG_LEVEL (error | warn | info | debug).
 * - Never logs secrets: callers are responsible for not passing them.
 * - Console output is the log; CI (Jenkins) captures it as the run log.
 */

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const activeName = (process.env.LOG_LEVEL || 'info').toLowerCase();
const activeLevel = Object.prototype.hasOwnProperty.call(LEVELS, activeName)
  ? LEVELS[activeName]
  : LEVELS.info;

function timestamp() {
  return new Date().toISOString();
}

function write(level, message) {
  if (LEVELS[level] > activeLevel) return null;
  const line = `[${timestamp()}] [${level.toUpperCase()}] ${message}`;
  if (level === 'error') {
    // eslint-disable-next-line no-console
    console.error(line);
  } else {
    // eslint-disable-next-line no-console
    console.log(line);
  }
  return line;
}

module.exports = {
  LEVELS,
  level: activeName,
  error: (message) => write('error', message),
  warn: (message) => write('warn', message),
  info: (message) => write('info', message),
  debug: (message) => write('debug', message),
};
