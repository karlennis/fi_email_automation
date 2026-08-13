/**
 * Run context - attaches a run/batch identifier to every log line beneath an entrypoint.
 *
 * The scan path alone has ~175 log statements spread across scanJobProcessor,
 * s3Service, fiDetectionService and emailService. Threading a runId parameter through
 * all of them is not practical, and prefixing message strings by hand (as
 * dailyRunWorker used to) gets forgotten the moment someone adds a new line.
 *
 * AsyncLocalStorage solves it once: wrap an entrypoint in runWith(), and the winston
 * format in utils/logger.js reads getContext() for every record emitted underneath -
 * at any async depth, through await, Promise.all, setTimeout and callbacks alike.
 *
 * Node built-in, no dependency.
 */

const { AsyncLocalStorage } = require('node:async_hooks');

const store = new AsyncLocalStorage();

/**
 * Run `fn` with `fields` attached to every log line it produces.
 *
 * Nested calls merge rather than replace, so a scan job wrapped inside the nightly
 * scheduler keeps the parent's fields and adds its own.
 *
 * @param {object} fields e.g. { runId: 'SCAN-20260813-a4f1', job: 'SCAN-1042' }
 * @param {Function} fn
 * @returns {*} whatever fn returns (including a promise, which stays in context)
 */
function runWith(fields, fn) {
  const merged = { ...getContext(), ...fields };
  return store.run(merged, fn);
}

/**
 * Fields for the currently running entrypoint, or {} outside one.
 * Callers must not mutate the result.
 */
function getContext() {
  return store.getStore() || {};
}

/**
 * The active runId, or undefined outside a run.
 */
function getRunId() {
  return getContext().runId;
}

/**
 * Add fields to the current run without starting a new one. No-op outside a run.
 *
 * Used where an identifier only becomes known part-way in - the scan job's target date
 * is resolved after the run has already started logging, for example.
 */
function addContext(fields) {
  const current = store.getStore();
  if (current) Object.assign(current, fields);
}

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/**
 * `PREFIX-YYYYMMDD-xxxx` - short enough to sit in every line, unique enough to grep for,
 * and sortable by eye. Mirrors the shape of DailyRun.runId.
 *
 * @param {string} prefix e.g. 'SCAN', 'NIGHTLY', 'ROUTE'
 * @param {Date} [now] injectable for tests
 */
function newRunId(prefix, now = new Date()) {
  const date = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0')
  ].join('');

  let suffix = '';
  for (let i = 0; i < 4; i++) {
    suffix += ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)];
  }

  return `${prefix}-${date}-${suffix}`;
}

module.exports = { runWith, getContext, getRunId, addContext, newRunId };
