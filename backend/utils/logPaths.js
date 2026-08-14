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
 * The directory a READER should look in.
 *
 * An explicit --dir or LOG_DIR always wins. Otherwise the production directory is used
 * whenever it exists, and backend/logs only as the development fallback.
 *
 * This is deliberately a fixed precedence rather than "whichever has the freshest logs".
 * That heuristic looked reasonable and failed within the hour: any maintenance script run
 * from a login shell (view-scan-jobs.js, check-stuck-jobs.js, a `node -e` one-liner)
 * requires a service, which requires the logger, which has no NODE_ENV in that shell and
 * so writes a fresh backend/logs/app-DATE.log holding nothing but its own startup lines.
 * Freshness then preferred that file and the reader reported "no runs found" while the
 * night sat in /var/log/fi_email. If /var/log/fi_email exists at all, you are on the box
 * and that is where the apps log.
 */
function readDir(explicitDir) {
  if (explicitDir) return explicitDir;
  if (process.env.LOG_DIR) return process.env.LOG_DIR;
  if (fs.existsSync(PRODUCTION_LOG_DIR)) return PRODUCTION_LOG_DIR;
  return DEVELOPMENT_LOG_DIR;
}

module.exports = {
  PRODUCTION_LOG_DIR,
  DEVELOPMENT_LOG_DIR,
  DATED_LOG_RE,
  writeDir,
  readDir
};
