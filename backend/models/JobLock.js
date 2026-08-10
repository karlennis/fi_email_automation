const mongoose = require('mongoose');

/**
 * A cross-process mutual-exclusion lock.
 *
 * Every scheduler in this codebase guarded itself with an in-process boolean
 * (`this.isRunning`, `this.lastRunDate`). Those are worthless under PM2 cluster mode -
 * fi-email-backend runs two instances, so every cron in server.js fired twice, and two
 * processes opened a write stream to the same document-register CSV and interleaved it.
 * They are also reset by a restart, so a crash mid-run let the next boot start again on
 * top of the previous attempt.
 *
 * Expiry is enforced by the application, not by Mongo. The TTL index below only reclaims
 * abandoned rows eventually - its monitor runs on a ~60s cycle, so a lock whose expiresAt
 * has passed may sit in the collection for another minute. jobLock.acquire() therefore
 * matches on `expiresAt <= now` rather than assuming the row is gone.
 */
const jobLockSchema = new mongoose.Schema({
  // Logical name of the thing being guarded, e.g. 'document-register-daily'.
  lockName: {
    type: String,
    required: true,
    unique: true
  },

  // `${hostname}:${pid}:${NODE_APP_INSTANCE}` - identifies the holder so release() and
  // renew() cannot act on a lock that has already been taken over by someone else.
  owner: {
    type: String,
    required: true
  },

  acquiredAt: {
    type: Date,
    required: true
  },

  // Bumped by the heartbeat. Useful for diagnosing a long-running holder.
  heartbeatAt: Date,

  // The authoritative expiry. Checked by acquire(); also drives the TTL sweep.
  expiresAt: {
    type: Date,
    required: true,
    index: { expireAfterSeconds: 0 }
  },

  // Free-form context for whoever is looking at a stuck lock (jobId, runId, ...).
  meta: mongoose.Schema.Types.Mixed
}, {
  timestamps: true,
  collection: 'job_locks'
});

module.exports = mongoose.model('JobLock', jobLockSchema);
