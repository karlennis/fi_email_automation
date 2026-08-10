/**
 * Tests for services/jobLock.js
 *
 * The lock exists because fi-email-backend runs two PM2 cluster instances and every
 * scheduler guarded itself with an in-process boolean, so each cron fired twice and two
 * processes interleaved their writes to the same document-register CSV.
 *
 * JobLock is mocked with an in-memory store that reproduces the one behaviour the design
 * depends on: the unique index on lockName, which turns a losing upsert into E11000.
 * No mongo, no network.
 */

jest.mock('../../models/JobLock');

const mongoose = require('mongoose');
const JobLock = require('../../models/JobLock');
const jobLock = require('../jobLock');

const { acquire, renew, release, withLock } = jobLock;

// --- in-memory stand-in for the collection ---------------------------------------

let store;

function duplicateKeyError() {
  const error = new Error('E11000 duplicate key error collection: job_locks index: lockName_1');
  error.code = 11000;
  return error;
}

/**
 * findOneAndUpdate({lockName, expiresAt: {$lte: now}}, ..., {upsert: true})
 *
 * Matches the real semantics: update if the row is absent or expired; otherwise the
 * upsert attempts an insert and the unique index rejects it.
 */
function fakeFindOneAndUpdate(filter, update) {
  const existing = store.get(filter.lockName);
  const now = filter.expiresAt.$lte;

  if (existing && existing.expiresAt > now) {
    return Promise.reject(duplicateKeyError());
  }

  const doc = { ...(existing || {}), ...update.$set };
  store.set(filter.lockName, doc);
  return Promise.resolve(doc);
}

function fakeUpdateOne(filter, update) {
  const existing = store.get(filter.lockName);
  if (!existing || existing.owner !== filter.owner) {
    return Promise.resolve({ matchedCount: 0, modifiedCount: 0 });
  }
  store.set(filter.lockName, { ...existing, ...update.$set });
  return Promise.resolve({ matchedCount: 1, modifiedCount: 1 });
}

function fakeDeleteOne(filter) {
  const existing = store.get(filter.lockName);
  if (!existing || existing.owner !== filter.owner) {
    return Promise.resolve({ deletedCount: 0 });
  }
  store.delete(filter.lockName);
  return Promise.resolve({ deletedCount: 1 });
}

beforeEach(() => {
  store = new Map();
  JobLock.findOneAndUpdate = jest.fn(fakeFindOneAndUpdate);
  JobLock.updateOne = jest.fn(fakeUpdateOne);
  JobLock.deleteOne = jest.fn(fakeDeleteOne);
  // withLock short-circuits to unlocked execution when mongo is down; default to "up".
  Object.defineProperty(mongoose.connection, 'readyState', { value: 1, configurable: true });
});

afterEach(() => {
  jest.restoreAllMocks();
});

// --- acquire ---------------------------------------------------------------------

describe('acquire', () => {
  test('takes a free lock', async () => {
    const result = await acquire('nightly', { ttlMs: 60000 });
    expect(result.acquired).toBe(true);
    expect(result.owner).toContain(String(process.pid));
  });

  test('refuses a lock held by a live owner', async () => {
    await acquire('nightly', { ttlMs: 60000 });
    const second = await acquire('nightly', { ttlMs: 60000 });
    expect(second.acquired).toBe(false);
  });

  test('takes over an EXPIRED lock - expiry is enforced here, not by the TTL monitor', async () => {
    // Mongo's TTL sweep runs on a ~60s cycle, so an expired row is routinely still
    // present. If acquire relied on the row being gone, a crashed holder would block
    // the job for up to a minute past its own expiry - and forever if the TTL index
    // were ever dropped.
    store.set('nightly', {
      lockName: 'nightly',
      owner: 'dead-host:999',
      expiresAt: new Date(Date.now() - 60_000)
    });

    const result = await acquire('nightly', { ttlMs: 60000 });
    expect(result.acquired).toBe(true);
    expect(store.get('nightly').owner).toBe(result.owner);
  });

  test('exactly one caller wins a concurrent race', async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () => acquire('nightly', { ttlMs: 60000 }))
    );
    expect(results.filter(r => r.acquired)).toHaveLength(1);
  });

  test('stores meta for whoever has to diagnose a stuck lock', async () => {
    await acquire('daily-run-scan', { ttlMs: 60000, meta: { runId: 'RUN-1' } });
    expect(store.get('daily-run-scan').meta).toEqual({ runId: 'RUN-1' });
  });

  test('propagates a non-duplicate-key error rather than reporting "held"', async () => {
    JobLock.findOneAndUpdate = jest.fn(() => Promise.reject(new Error('connection reset')));
    await expect(acquire('nightly', { ttlMs: 60000 })).rejects.toThrow('connection reset');
  });
});

// --- renew / release -------------------------------------------------------------

describe('renew', () => {
  test('extends a lock we still hold', async () => {
    const { owner } = await acquire('nightly', { ttlMs: 60000 });
    const before = store.get('nightly').expiresAt;
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(await renew('nightly', owner, 120000)).toBe(true);
    expect(store.get('nightly').expiresAt.getTime()).toBeGreaterThan(before.getTime());
  });

  test('returns false once the lock has been taken over', async () => {
    const { owner } = await acquire('nightly', { ttlMs: 60000 });
    store.set('nightly', { ...store.get('nightly'), owner: 'someone-else' });
    expect(await renew('nightly', owner, 60000)).toBe(false);
  });
});

describe('release', () => {
  test('releases a lock we own', async () => {
    const { owner } = await acquire('nightly', { ttlMs: 60000 });
    expect(await release('nightly', owner)).toBe(true);
    expect(store.has('nightly')).toBe(false);
  });

  test('will not delete a lock another process now owns', async () => {
    const { owner } = await acquire('nightly', { ttlMs: 60000 });
    store.set('nightly', { ...store.get('nightly'), owner: 'someone-else' });
    expect(await release('nightly', owner)).toBe(false);
    expect(store.has('nightly')).toBe(true);
  });
});

// --- withLock --------------------------------------------------------------------

describe('withLock', () => {
  test('runs fn and reports the result', async () => {
    const outcome = await withLock('nightly', { ttlMs: 60000 }, async () => 'done');
    expect(outcome).toEqual({ ran: true, result: 'done' });
  });

  test('releases afterwards so the next run can proceed', async () => {
    await withLock('nightly', { ttlMs: 60000 }, async () => 'first');
    const second = await withLock('nightly', { ttlMs: 60000 }, async () => 'second');
    expect(second).toEqual({ ran: true, result: 'second' });
  });

  test('does not call fn when the lock is held elsewhere', async () => {
    await acquire('nightly', { ttlMs: 60000 });
    const fn = jest.fn();
    const outcome = await withLock('nightly', { ttlMs: 60000 }, fn);
    expect(fn).not.toHaveBeenCalled();
    expect(outcome).toEqual({ ran: false, reason: 'locked' });
  });

  test('releases in finally when fn throws, so one failure does not wedge the job forever', async () => {
    await expect(
      withLock('nightly', { ttlMs: 60000 }, async () => { throw new Error('boom'); })
    ).rejects.toThrow('boom');

    expect(store.has('nightly')).toBe(false);
    const next = await withLock('nightly', { ttlMs: 60000 }, async () => 'recovered');
    expect(next.ran).toBe(true);
  });

  test('runs unlocked when MongoDB is unavailable', async () => {
    // ingestion-worker.js starts without mongo when MONGODB_URI is unset. Refusing to
    // run there would silently stop the nightly routing job.
    Object.defineProperty(mongoose.connection, 'readyState', { value: 0, configurable: true });
    const fn = jest.fn().mockResolvedValue('ran anyway');

    const outcome = await withLock('ingestion-routing', { ttlMs: 60000 }, fn);

    expect(fn).toHaveBeenCalled();
    expect(outcome).toEqual({ ran: true, result: 'ran anyway', reason: 'no-mongo' });
    expect(JobLock.findOneAndUpdate).not.toHaveBeenCalled();
  });

  test('skips rather than running unguarded when the lock cannot be evaluated', async () => {
    JobLock.findOneAndUpdate = jest.fn(() => Promise.reject(new Error('mongo timeout')));
    const fn = jest.fn();

    const outcome = await withLock('nightly', { ttlMs: 60000 }, fn);

    expect(fn).not.toHaveBeenCalled();
    expect(outcome).toEqual({ ran: false, reason: 'lock-error' });
  });

  test('a failed release does not mask the result', async () => {
    JobLock.deleteOne = jest.fn(() => Promise.reject(new Error('mongo gone')));
    const outcome = await withLock('nightly', { ttlMs: 60000 }, async () => 'value');
    expect(outcome).toEqual({ ran: true, result: 'value' });
  });
});
