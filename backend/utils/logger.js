/**
 * Application logger.
 *
 * Layout on disk (LOG_DIR, /var/log/fi_email in production):
 *
 *   app-YYYY-MM-DD.log     INFO and above  - the scannable record of a day.   14d
 *   debug-YYYY-MM-DD.log   everything      - full per-document trail.          3d
 *   error-YYYY-MM-DD.log   ERROR only      - what went wrong, nothing else.   30d
 *   <stdout>               INFO and above  - one human line, captured by PM2.
 *
 * Rotation is by date, not by size, so "the log for 2026-08-12" is a file you can grep
 * rather than a range hidden somewhere inside combined3.log. `npm run logs` reads these
 * (see scripts/logs.js); PM2's own out/error files remain only as a net for crash
 * output that never reaches winston.
 *
 * Every record is stamped with the runId of the entrypoint that produced it - see
 * utils/runContext.js. That is what makes a single night's scan separable from the
 * delivery sweeper, the stuck-job sweeper and two clustered API instances all writing
 * into the same file.
 */

const fs = require('fs');
const path = require('path');
const winston = require('winston');

const runContext = require('./runContext');

// Registers winston.transports.DailyRotateFile as a side effect.
//
// Guarded, because an unguarded require here once took the entire pipeline down: a deploy
// pulled the code without running `npm install`, the module was absent, and every process
// that requires this file - worker.js, server.js, ingestion-worker.js - died at startup.
// PM2 exhausted max_restarts and left them all `errored`. Nothing scanned that night.
//
// Logging must never be the reason a scan does not run. Without the module we fall back
// to plain size-rotated files below and say so loudly; documents still get processed.
let rotationAvailable = true;
let rotationError = null;
try {
  require('winston-daily-rotate-file');
} catch (error) {
  rotationAvailable = false;
  rotationError = error.message;
}

const isTest = process.env.NODE_ENV === 'test';

// Paths live in their own side-effect-free module so a reader (scripts/logs.js) can ask
// where the logs are without requiring this file and thereby creating them.
const logPaths = require('./logPaths');

const LOG_DIR = logPaths.writeDir();

if (!isTest) {
  // Created (and chowned to ubuntu) by deploy-ec2.sh on the box, but a fresh checkout
  // or a custom LOG_DIR has nothing there yet.
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(`Cannot create log directory ${LOG_DIR}: ${error.message}`);
  }
}

/**
 * Merge the active run's fields into every record. Explicit meta on the call site wins,
 * so `logger.info('x', { runId: 'other' })` is still respected.
 */
const withRunContext = winston.format((info) => {
  const ctx = runContext.getContext();
  for (const [key, value] of Object.entries(ctx)) {
    if (info[key] === undefined) info[key] = value;
  }
  return info;
});

// Fields that are rendered positionally or are noise in the key=value tail.
const CONSOLE_SKIP = new Set(['level', 'message', 'timestamp', 'service', 'runId', 'stack']);

// Colour is applied here rather than with winston.format.colorize(), which wraps
// info.level in escape codes and so breaks the padEnd alignment below.
const LEVEL_COLOUR = { error: '\x1b[31m', warn: '\x1b[33m', info: '\x1b[32m', debug: '\x1b[90m' };
const RESET = '\x1b[0m';

/**
 * `14:22:31 INFO  [SCAN-20260813-a4f1] scan complete  processed=3182 matched=7`
 */
function formatLine(info, colour) {
  const time = String(info.timestamp || '').slice(11) || new Date().toISOString().slice(11, 19);
  const level = info.level.toUpperCase().padEnd(5);
  const run = info.runId ? ` [${info.runId}]` : '';

  const meta = Object.entries(info)
    .filter(([k, v]) => !CONSOLE_SKIP.has(k) && v !== undefined && typeof v !== 'object')
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');

  const head = colour
    ? `${time} ${LEVEL_COLOUR[info.level] || ''}${level}${RESET}${run} ${info.message}`
    : `${time} ${level}${run} ${info.message}`;

  return [head, meta && `  ${meta}`, info.stack && `\n${info.stack}`].filter(Boolean).join('');
}

// Colour only when a human is watching. Under PM2 stdout is a pipe into a file, and
// escape codes there make the captured output harder to read, not easier.
const useColour = Boolean(process.stdout.isTTY);
const consoleLine = winston.format.printf((info) => formatLine(info, useColour));

// '50m' -> 52428800. winston's File transport wants bytes where DailyRotateFile takes a
// human string, so the fallback can reuse the same numbers.
function toBytes(size) {
  const match = /^(\d+)([kmg])$/i.exec(String(size));
  if (!match) return undefined;
  const unit = { k: 1024, m: 1024 * 1024, g: 1024 * 1024 * 1024 }[match[2].toLowerCase()];
  return Number(match[1]) * unit;
}

function rotatingFile(prefix, level, maxFiles, maxSize) {
  if (rotationAvailable) {
    return new winston.transports.DailyRotateFile({
      filename: path.join(LOG_DIR, `${prefix}-%DATE%.log`),
      datePattern: 'YYYY-MM-DD',
      level,
      maxFiles,
      maxSize,
      // Not gzipped: a compressed day cannot be grepped, which is the whole point of
      // keeping it. Retention is short enough that the space does not matter.
      zippedArchive: false,
      // Rotation happens on the local day boundary, matching the 12:10 AM scan schedule.
      utc: false
    });
  }

  // Degraded mode: same three streams, same levels, but size-rotated with no date in the
  // name. Deliberately NOT the `<prefix>-YYYY-MM-DD.log` shape, so neither
  // scripts/logs.js nor diskCleanupService's DATED_LOG_RE mistakes these for real
  // rotated days and applies date-based retention to them.
  return new winston.transports.File({
    filename: path.join(LOG_DIR, `${prefix}.log`),
    level,
    maxsize: toBytes(maxSize),
    maxFiles: 5
  });
}

const transports = [];

if (!isTest) {
  transports.push(
    rotatingFile('app', 'info', '14d', '50m'),
    rotatingFile('debug', 'debug', '3d', '100m'),
    rotatingFile('error', 'error', '30d', '20m')
  );
}

transports.push(
  new winston.transports.Console({
    // LOG_LEVEL controls the console only. The files are fixed, so raising it to debug
    // for an hour cannot cost you the app-*.log record, and lowering it cannot cost you
    // the debug trail.
    level: process.env.LOG_LEVEL || 'info',
    silent: isTest,
    // Human-readable in every environment. PM2 captures stdout verbatim, and the
    // machine-readable copy already exists in app-DATE.log - a second JSON stream is
    // just a third copy of every line that nobody reads.
    format: consoleLine
  })
);

const logger = winston.createLogger({
  // Must be 'debug': a transport never receives records below the logger's own level,
  // so leaving this at 'info' would silently produce an empty debug-DATE.log.
  level: 'debug',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    withRunContext(),
    winston.format.json()
  ),
  defaultMeta: { service: 'fi-email-automation' },
  transports,
  exitOnError: false
});

// Emitted through the logger itself, after construction, so the degraded state is
// recorded in the log rather than only on a console nobody is watching. Repeated on every
// boot on purpose - this should be impossible to miss and trivial to fix.
if (!isTest && !rotationAvailable) {
  logger.warn(
    'winston-daily-rotate-file is not installed - logging to size-rotated app.log/debug.log/error.log ' +
    'instead of dated files. `npm run logs` will not find a day until this is fixed. ' +
    'Fix with: cd backend && npm install',
    { err: rotationError }
  );
}

// Create a stream object for HTTP request logging
logger.stream = {
  write: (message) => {
    logger.info(message.trim());
  }
};

logger.logDir = LOG_DIR;
logger.rotationAvailable = rotationAvailable;
// Shared with scripts/logs.js so the CLI renders a stored record exactly as the console
// printed it live.
logger.formatLine = formatLine;

module.exports = logger;
