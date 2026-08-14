/**
 * Where the log files live.
 *
 * Separate from utils/logger.js on purpose: requiring the logger *constructs its
 * transports*, which creates the log directory and an empty set of dated files. That is
 * correct for an app that is about to write logs, and wrong for a tool that only wants to
 * read them - scripts/logs.js used to require the logger just to ask for a path, and in
 * doing so created empty app-DATE.log files in the development directory on the
 * production box, then picked that directory to read from because it now had dated files
 * in it. Reading logs must not write logs.
 *
 * This module has no side effects.
 */

const fs = require('fs');
const path = require('path');

const PRODUCTION_LOG_DIR = '/var/log/fi_email';
const DEVELOPMENT_LOG_DIR = path.join(__dirname, '../logs');

// app-2026-08-14.log, debug-2026-08-14.log.1, error-2026-08-14.log
const DATED_LOG_RE = /^(app|debug|error)-(\d{4}-\d{2}-\d{2})\.log(\.\d+)?$/;

/**
 * The directory this process should WRITE to. NODE_ENV is set for the PM2 apps, so they
 * resolve to /var/log/fi_email; everything else stays in backend/logs.
 */
function writeDir() {
  return process.env.LOG_DIR
    || (process.env.NODE_ENV === 'production' ? PRODUCTION_LOG_DIR : DEVELOPMENT_LOG_DIR);
}

/**
 * The most recent modification time of any dated log in `dir`, or 0 if it holds none.
 *
 * Used to pick between candidate directories. A plain "does it contain dated files"
 * test is not enough: both directories can end up holding dated files, and the stale one
 * would win on ordering alone. The directory being actively written to is the live one.
 */
function datedLogFreshness(dir) {
  let newest = 0;
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!DATED_LOG_RE.test(name)) continue;
      try {
        newest = Math.max(newest, fs.statSync(path.join(dir, name)).mtimeMs);
      } catch (error) {
        // raced with rotation; ignore
      }
    }
  } catch (error) {
    return 0;
  }
  return newest;
}

/**
 * The directory a READER should look in.
 *
 * An explicit --dir or LOG_DIR always wins. Otherwise both candidates are probed and the
 * one with the freshest dated logs is chosen, because a login shell has no NODE_ENV and
 * so cannot tell which of the two the running apps are using.
 */
function readDir(explicitDir) {
  if (explicitDir) return explicitDir;
  if (process.env.LOG_DIR) return process.env.LOG_DIR;

  const candidates = [PRODUCTION_LOG_DIR, DEVELOPMENT_LOG_DIR];
  const ranked = candidates
    .map((dir) => ({ dir, freshness: datedLogFreshness(dir) }))
    .sort((a, b) => b.freshness - a.freshness);

  if (ranked[0].freshness > 0) return ranked[0].dir;

  return candidates.find((dir) => fs.existsSync(dir)) || DEVELOPMENT_LOG_DIR;
}

module.exports = {
  PRODUCTION_LOG_DIR,
  DEVELOPMENT_LOG_DIR,
  DATED_LOG_RE,
  datedLogFreshness,
  writeDir,
  readDir
};
