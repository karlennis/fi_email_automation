#!/usr/bin/env node
/**
 * Read the full log for a run or a day.
 *
 * `pm2 logs --lines N` tails a file, so it can only ever show you the end of a run. The
 * dated files utils/logger.js writes hold the whole thing; this reads them back.
 *
 *   npm run logs -- --runs                          what ran today, and did it finish
 *   npm run logs -- --runs --date 2026-08-12        ...for a given day
 *   npm run logs -- --run SCAN-20260813-a4f1        one run, start to finish
 *   npm run logs -- --date 2026-08-12 --level error errors only
 *   npm run logs -- --run SCAN-20260813-a4f1 --debug  include the per-document trail
 *   npm run logs -- --date 2026-08-12 --grep 1188422  one project, file or document id
 *   npm run logs -- --date 2026-08-12 --json | jq .   raw records, for piping
 *
 * Read-only, and streamed line by line - it never loads a file into memory, so it is
 * safe against a 50MB day.
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const LEVEL_ORDER = { debug: 0, info: 1, warn: 2, error: 3 };

function usage(message) {
  if (message) process.stderr.write(`${message}\n\n`);
  process.stderr.write(`Usage: npm run logs -- [options]

  --date YYYY-MM-DD   Day to read (default: today, or the date inside --run)
  --run <runId>       Only lines from this run
  --level <level>     Minimum level: debug | info | warn | error (default: info)
  --debug             Read debug-DATE.log too (implies --level debug)
  --grep <text>       Only lines containing this text (case-insensitive)
  --runs              List the runs in the day with their start, end and outcome
  --json              Emit the raw JSON records instead of formatted lines
  --dir <path>        Log directory (default: LOG_DIR, else the logger's own)
  --list              Show which dated log files exist
`);
  process.exit(message ? 1 : 0);
}

function parseArgs(argv) {
  const opts = { level: 'info', files: ['app'] };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) usage(`${arg} needs a value`);
      return value;
    };

    switch (arg) {
      case '--date': opts.date = next(); break;
      case '--run': opts.run = next(); break;
      case '--level': opts.level = next(); break;
      case '--grep': opts.grep = next(); break;
      case '--dir': opts.dir = next(); break;
      // debug-DATE.log is written at level debug, so it already contains every info,
      // warn and error record too. Reading app-DATE.log alongside it would show each of
      // those lines twice.
      case '--debug': opts.files = ['debug']; opts.level = 'debug'; break;
      case '--runs': opts.runs = true; break;
      case '--json': opts.json = true; break;
      case '--list': opts.list = true; break;
      case '-h': case '--help': usage(); break;
      default: usage(`Unknown option: ${arg}`);
    }
  }

  if (LEVEL_ORDER[opts.level] === undefined) usage(`Unknown level: ${opts.level}`);

  // A run id carries its own date (PREFIX-YYYYMMDD-xxxx), so --run alone is enough.
  if (!opts.date && opts.run) {
    const m = /-(\d{4})(\d{2})(\d{2})-/.exec(opts.run);
    if (m) opts.date = `${m[1]}-${m[2]}-${m[3]}`;
  }
  if (!opts.date) opts.date = new Date().toISOString().split('T')[0];

  return opts;
}

const DATED_LOG_RE = /^(app|debug|error)-\d{4}-\d{2}-\d{2}\.log/;

function hasDatedLogs(dir) {
  try {
    return fs.readdirSync(dir).some((name) => DATED_LOG_RE.test(name));
  } catch (error) {
    return false;
  }
}

/**
 * Where to read from.
 *
 * The logger picks /var/log/fi_email only when NODE_ENV === 'production', which PM2 sets
 * for the app but a login shell does not - so asking it directly sent this CLI to
 * backend/logs on the box and it reported "no log for today" while the day sat in
 * /var/log/fi_email. Probe both candidates instead, preferring one that actually holds
 * dated logs.
 */
function resolveLogDir(opts) {
  if (opts.dir) return opts.dir;
  if (process.env.LOG_DIR) return process.env.LOG_DIR;

  const logger = require('../utils/logger');
  const candidates = [logger.logDir, ...(logger.logDirCandidates || [])];

  return candidates.find(hasDatedLogs)
    || candidates.find((dir) => fs.existsSync(dir))
    || logger.logDir;
}

/**
 * Every file holding a given day, in read order. A day that exceeded maxSize is split
 * into app-DATE.log plus numeric suffixes; the suffixed parts are the earlier ones.
 */
function filesForDay(dir, prefixes, date) {
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch (error) {
    process.stderr.write(`Cannot read log directory ${dir}: ${error.message}\n`);
    process.exit(1);
  }

  const found = [];
  for (const prefix of prefixes) {
    const base = `${prefix}-${date}.log`;
    const parts = entries
      .filter((name) => name === base || name.startsWith(`${base}.`))
      .sort((a, b) => {
        const na = Number(a.slice(base.length + 1)) || 0;
        const nb = Number(b.slice(base.length + 1)) || 0;
        return na - nb;
      });
    found.push(...parts.map((name) => path.join(dir, name)));
  }
  return found;
}

function matches(entry, opts) {
  if (LEVEL_ORDER[entry.level] === undefined) return false;
  if (LEVEL_ORDER[entry.level] < LEVEL_ORDER[opts.level]) return false;
  if (opts.run && entry.runId !== opts.run) return false;
  if (opts.grep && !JSON.stringify(entry).toLowerCase().includes(opts.grep.toLowerCase())) return false;
  return true;
}

/**
 * Read every matching record from the day's files, in timestamp order.
 *
 * app-DATE.log and debug-DATE.log are two sorted streams of the same day, so reading
 * them back to back would interleave wrongly. Records are collected and sorted only
 * when more than one file is involved.
 */
async function readEntries(files, opts, onEntry) {
  const needsSort = files.length > 1;
  const collected = [];

  for (const file of files) {
    const rl = readline.createInterface({
      input: fs.createReadStream(file, { encoding: 'utf8' }),
      crlfDelay: Infinity
    });

    for await (const line of rl) {
      if (!line.trim()) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch (error) {
        continue; // a torn final line from a rotation or a crash
      }
      if (!matches(entry, opts)) continue;
      if (needsSort) collected.push(entry);
      else onEntry(entry);
    }
  }

  if (needsSort) {
    collected.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
    for (const entry of collected) onEntry(entry);
  }
}

const SKIP_FIELDS = new Set(['level', 'message', 'timestamp', 'service', 'runId', 'stack']);

function formatEntry(entry) {
  const time = String(entry.timestamp || '').slice(11) || '--:--:--';
  const level = String(entry.level || '?').toUpperCase().padEnd(5);
  const run = entry.runId ? ` [${entry.runId}]` : '';

  const meta = Object.entries(entry)
    .filter(([k, v]) => !SKIP_FIELDS.has(k) && v !== undefined && typeof v !== 'object')
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');

  return [
    `${time} ${level}${run} ${entry.message}`,
    meta && `  ${meta}`,
    entry.stack && `\n${entry.stack}`
  ].filter(Boolean).join('');
}

/**
 * Index of the day: one row per run, built from the 'run start' / 'run end' lines the
 * services emit. Answers "what ran last night, did it finish, and how big was it?"
 * without reading a single log line.
 */
function printRunIndex(runs) {
  if (runs.size === 0) {
    process.stdout.write('No runs found. (Runs are identified by their "run start" / "run end" lines.)\n');
    return;
  }

  const rows = [...runs.values()].sort((a, b) => a.start.localeCompare(b.start));
  const width = Math.max(...rows.map((r) => r.runId.length), 5);

  process.stdout.write(
    `${'RUN'.padEnd(width)}  ${'START'.padEnd(8)}  ${'END'.padEnd(8)}  ${'OUTCOME'.padEnd(9)}  ${'ERR'.padStart(4)}  ${'WARN'.padStart(4)}  DETAIL\n`
  );

  for (const row of rows) {
    // "UNFINISHED" only means something for a run that announced a start and never
    // reached an end. Short-lived work that logs neither (a request, a quiet cleanup
    // tick) is just lines, and calling it unfinished would be a false alarm.
    const outcome = row.end ? (row.failed ? 'FAILED' : 'ok')
      : row.sawStart ? 'UNFINISHED'
      : '-';
    process.stdout.write(
      `${row.runId.padEnd(width)}  ${row.start.slice(11, 19)}  ` +
      `${(row.end ? row.end.slice(11, 19) : '-').padEnd(8)}  ${outcome.padEnd(9)}  ` +
      `${String(row.errors).padStart(4)}  ${String(row.warnings).padStart(4)}  ${row.detail}\n`
    );
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const dir = resolveLogDir(opts);

  if (opts.list) {
    const days = new Map();
    for (const name of fs.readdirSync(dir)) {
      const m = /^(app|debug|error)-(\d{4}-\d{2}-\d{2})\.log/.exec(name);
      if (!m) continue;
      const size = fs.statSync(path.join(dir, name)).size;
      const day = days.get(m[2]) || { app: 0, debug: 0, error: 0 };
      day[m[1]] += size;
      days.set(m[2], day);
    }
    const mb = (n) => `${(n / 1048576).toFixed(1)}MB`;
    process.stdout.write(`Log directory: ${dir}\n\nDATE          APP     DEBUG     ERROR\n`);
    for (const [day, sizes] of [...days].sort()) {
      process.stdout.write(`${day}  ${mb(sizes.app).padStart(7)}  ${mb(sizes.debug).padStart(8)}  ${mb(sizes.error).padStart(8)}\n`);
    }
    return;
  }

  // --runs needs the run start/end lines, which are info.
  const prefixes = opts.runs ? ['app'] : opts.files;
  let files = filesForDay(dir, prefixes, opts.date);

  // The three files have different retention (debug 3d, app 14d, error 30d), so an
  // older day may only survive in the longer-lived one. Fall back rather than claiming
  // the day has no logs at all.
  if (files.length === 0 && prefixes[0] === 'debug') {
    files = filesForDay(dir, ['app'], opts.date);
    if (files.length > 0) {
      process.stderr.write(`No debug log for ${opts.date} (kept 3 days) - showing app log instead.\n\n`);
    }
  }
  if (files.length === 0 && opts.level === 'error') {
    files = filesForDay(dir, ['error'], opts.date);
  }

  if (files.length === 0) {
    process.stderr.write(`No ${prefixes.join('/')} log for ${opts.date} in ${dir}.\n`);

    // The undated names are the logger's degraded mode - it could not load
    // winston-daily-rotate-file, so nothing is split by day. Say so, rather than letting
    // this read as "that day has no logs".
    if (prefixes.some((p) => fs.existsSync(path.join(dir, `${p}.log`)))) {
      process.stderr.write(
        `\nFound undated ${prefixes.join('/')}.log instead. The logger falls back to these when\n` +
        `winston-daily-rotate-file is missing, so there are no per-day files to read.\n` +
        `Fix with: cd backend && npm install\n`
      );
    } else {
      process.stderr.write(`Try: npm run logs -- --list\n`);
    }
    process.exit(1);
  }

  if (opts.runs) {
    const runs = new Map();
    await readEntries(files, { ...opts, level: 'debug' }, (entry) => {
      const id = entry.runId;
      if (!id) return;

      const row = runs.get(id) || {
        runId: id, start: entry.timestamp, end: null, failed: false,
        sawStart: false, errors: 0, warnings: 0, detail: ''
      };

      if (entry.level === 'error') row.errors++;
      if (entry.level === 'warn') row.warnings++;

      const message = String(entry.message || '');
      if (message.startsWith('run start')) {
        row.start = entry.timestamp;
        row.sawStart = true;
      }
      if (message.startsWith('run end')) {
        row.end = entry.timestamp;
        row.failed = message.includes('FAILED');
        row.detail = Object.entries(entry)
          .filter(([k, v]) => !SKIP_FIELDS.has(k) && typeof v !== 'object')
          .map(([k, v]) => `${k}=${v}`)
          .join(' ');
      }

      runs.set(id, row);
    });

    printRunIndex(runs);
    return;
  }

  let count = 0;
  await readEntries(files, opts, (entry) => {
    count++;
    process.stdout.write((opts.json ? JSON.stringify(entry) : formatEntry(entry)) + '\n');
  });

  if (count === 0 && !opts.json) {
    process.stderr.write(`No matching lines. Read: ${files.map((f) => path.basename(f)).join(', ')}\n`);
  }
}

main().catch((error) => {
  // EPIPE is normal when the output is piped into head or less.
  if (error && error.code === 'EPIPE') return;
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
