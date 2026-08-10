/**
 * Cross-process locking for scheduled work.
 *
 * See backend/models/JobLock.js for why this exists. The short version: fi-email-backend
 * runs two PM2 cluster instances, every scheduler guarded itself with an in-process
 * boolean, and so every cron registered in server.js fired twice.
 *
 * Usage:
 *
 *   const { withLock } = require('./jobLock');
 *
 *   const outcome = await withLock('document-register-daily', { ttlMs: 60 * 60 * 1000 }, async () => {
 *     ...
 *   });
 *   if (!outcome.ran) return;   // another instance holds it
 */

const os = require('os');
const mongoose = require('mongoose');
const JobLock = require('../models/JobLock');
const logger = require('../utils/logger');

const DEFAULT_TTL_MS = 30 * 60 * 1000;

// A heartbeat renews at a third of the TTL, so two consecutive misses still leave time
// to recover before another process is entitled to take over.
const HEARTBEAT_DIVISOR = 3;

/**
 * Identifies this process. NODE_APP_INSTANCE distinguishes PM2 cluster forks, which
 * share a hostname and would otherwise be indistinguishable in the lock row.
 */
function buildOwnerId() {
  const instance = process.env.NODE_APP_INSTANCE;
  return `${os.hostname()}:${process.pid}${instance !== undefined ? `:${instance}` : ''}`;
}

/**
 * The ingestion worker runs without MongoDB when MONGODB_URI is unset, and it is a
 * single fork anyway. Rather than crash it, degrade to running unlocked.
 */
function isMongoAvailable() {
  return mongoose.connection && mongoose.connection.readyState === 1;
}

/**
 * Take the lock, or report that someone live is holding it.
 *
 * The upsert matches only on an EXPIRED row. When a live holder exists the filter finds
 * nothing, the upsert tries to insert, and the unique index on lockName turns that into
 * a duplicate-key error - which is the losing outcome. That makes "no row yet" and
 * "row held by someone else" resolve through the same single atomic operation, with
 * exactly one winner under a race.
 *
 * @returns {Promise<{acquired: boolean, owner?: string, expiresAt?: Date}>}
 */
async function acquire(lockName, { ttlMs = DEFAULT_TTL_MS, meta = null } = {}) {
  const owner = buildOwnerId();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMs);

  try {
    await JobLock.findOneAndUpdate(
      { lockName, expiresAt: { $lte: now } },
      {
        $set: { lockName, owner, acquiredAt: now, heartbeatAt: now, expiresAt, meta }
      },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );
    return { acquired: true, owner, expiresAt };
  } catch (error) {
    if (error && (error.code === 11000 || error.code === 11001)) {
      return { acquired: false };
    }
    throw error;
  }
}

/**
 * Extend the lock, but only while we still hold it.
 *
 * @returns {Promise<boolean>} false if the lock was taken over - the caller should abort
 *   rather than keep writing, because another process is now doing the same work.
 */
async function renew(lockName, owner, ttlMs = DEFAULT_TTL_MS) {
  const now = new Date();
  const result = await JobLock.updateOne(
    { lockName, owner },
    { $set: { heartbeatAt: now, expiresAt: new Date(now.getTime() + ttlMs) } }
  );
  return result.matchedCount > 0;
}

/**
 * Release the lock, but only if we still own it. A lock that already expired and was
 * taken over by someone else must not be deleted out from under them.
 */
async function release(lockName, owner) {
  const result = await JobLock.deleteOne({ lockName, owner });
  return result.deletedCount > 0;
}

/**
 * Keep the lock alive while a long job runs. Returns a handle with stop().
 */
function startHeartbeat(lockName, owner, ttlMs = DEFAULT_TTL_MS) {
  const intervalMs = Math.max(5000, Math.floor(ttlMs / HEARTBEAT_DIVISOR));
  let lost = false;

  const timer = setInterval(async () => {
    try {
      const stillOurs = await renew(lockName, owner, ttlMs);
      if (!stillOurs && !lost) {
        lost = true;
        logger.error(
          `🔒 Lost lock "${lockName}" - it was taken over by another process while we were still running. ` +
          `Two processes may now be doing the same work.`
        );
      }
    } catch (error) {
      logger.warn(`🔒 Failed to renew lock "${lockName}": ${error.message}`);
    }
  }, intervalMs);

  // Never hold the event loop open for a heartbeat.
  if (typeof timer.unref === 'function') timer.unref();

  return {
    stop() { clearInterval(timer); },
    get lost() { return lost; }
  };
}

/**
 * Run `fn` under the named lock. Skips (without error) when another process holds it.
 *
 * @param {string} lockName
 * @param {object} options
 * @param {number} options.ttlMs         lock lifetime; must exceed the expected runtime
 * @param {boolean} options.heartbeat    renew while running - use for long jobs
 * @param {object} options.meta          context stored on the lock row
 * @param {string|false} options.skipMessage  what to log when held elsewhere; false to
 *                                            stay silent, for high-frequency sweeps
 * @param {Function} fn
 * @returns {Promise<{ran: boolean, result?: *, reason?: string}>}
 */
async function withLock(lockName, options, fn) {
  const {
    ttlMs = DEFAULT_TTL_MS,
    heartbeat = false,
    meta = null,
    skipMessage = null
  } = options || {};

  if (!isMongoAvailable()) {
    logger.warn(
      `🔒 MongoDB unavailable - running "${lockName}" WITHOUT a lock. ` +
      `Safe only where the process is the sole scheduler for this work.`
    );
    return { ran: true, result: await fn(), reason: 'no-mongo' };
  }

  let acquired;
  try {
    acquired = await acquire(lockName, { ttlMs, meta });
  } catch (error) {
    // A lock we cannot evaluate must not silently become a lock we ignore.
    logger.error(`🔒 Could not acquire lock "${lockName}": ${error.message}`);
    return { ran: false, reason: 'lock-error' };
  }

  if (!acquired.acquired) {
    if (skipMessage !== false) {
      logger.info(skipMessage || `⏭️ Skipping "${lockName}" - held by another process`);
    }
    return { ran: false, reason: 'locked' };
  }

  const beat = heartbeat ? startHeartbeat(lockName, acquired.owner, ttlMs) : null;

  try {
    const result = await fn();
    return { ran: true, result };
  } finally {
    if (beat) beat.stop();
    try {
      await release(lockName, acquired.owner);
    } catch (error) {
      // Not fatal - the TTL reclaims it. Losing the release just delays the next run.
      logger.warn(`🔒 Failed to release lock "${lockName}": ${error.message}`);
    }
  }
}

module.exports = {
  acquire,
  renew,
  release,
  startHeartbeat,
  withLock,
  buildOwnerId,
  DEFAULT_TTL_MS
};
