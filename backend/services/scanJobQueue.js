const Bull = require('bull');
const logger = require('../utils/logger');

let scanQueue;

function getRedisConfig() {
  if (process.env.REDIS_URL) {
    // Log Redis connection info (without exposing full credentials)
    const redisHost = process.env.REDIS_URL.includes('@')
      ? process.env.REDIS_URL.split('@')[1].split(':')[0]
      : 'localhost';
    logger.info(`[scanJobQueue] Using Redis host: ${redisHost}`);
    return process.env.REDIS_URL;
  }

  const host = process.env.REDIS_HOST || '127.0.0.1';
  const port = process.env.REDIS_PORT || '6379';
  const password = process.env.REDIS_PASSWORD;

  if (password) {
    return `redis://:${password}@${host}:${port}`;
  }

  return `redis://${host}:${port}`;
}

function getScanQueue() {
  if (!scanQueue) {
    const redisUrl = getRedisConfig();

    // Log Redis connection info (without exposing full credentials)
    const redisHost = redisUrl.includes('@')
      ? redisUrl.split('@')[1].split(':')[0]
      : 'localhost';
    logger.info(`[scanJobQueue] Using Redis host: ${redisHost}`);

    // Parse URL and build config for Upstash compatibility
    let redisConfig;
    if (redisUrl.startsWith('redis://') || redisUrl.startsWith('rediss://')) {
      const url = new URL(redisUrl);
      redisConfig = {
        host: url.hostname,
        port: parseInt(url.port || '6379', 10),
        password: url.password || undefined,
        tls: url.protocol === 'rediss:' ? {} : undefined,
        // Required for Bull + cloud Redis (Upstash): prevents "ERR caller gone"
        // when the blocking BRPOPLPUSH connection is dropped and ioredis reconnects
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
        connectTimeout: 10000,
        keepAlive: 5000,
        retryStrategy: (times) => Math.min(times * 500, 10000)
      };
    } else {
      // Fallback to URL string (ioredis will parse it)
      redisConfig = redisUrl;
    }

    // Bull requires redis config in options object
    scanQueue = new Bull('scan-jobs', {
      redis: redisConfig,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: 50,
        removeOnFail: 100
      },
      settings: {
        // Optimize for low Redis request usage (Upstash 500k/month limit)
        stalledInterval: 600000,  // Check for stalled jobs every 10 minutes (was 60s)
        maxStalledCount: 2,       // Max times a job can be recovered
        guardInterval: 30000,     // Renew lock every 30s (was 10s)
        lockDuration: 90000,      // Lock duration 90s (was 30s)
        drainDelay: 1000          // 1s delay between checks (was 5ms) - CRITICAL for reducing EVALSHA
      }
    });

    scanQueue.on('error', (err) => {
      // "ERR caller gone" is a transient ioredis reconnect event (BRPOPLPUSH
      // interrupted when the Redis connection drops). Bull recovers automatically;
      // log as warn to avoid false-alarm alerts.
      if (err.message && err.message.includes('caller gone')) {
        logger.warn('⚠️ Scan queue: Redis connection dropped and reconnecting (ERR caller gone)');
      } else {
        logger.error('❌ Scan queue error:', err);
      }
    });
  }

  return scanQueue;
}

// A waiting/active Bull job older than this is presumed abandoned - its worker died
// without Bull noticing. Bull's own stalled check (stalledInterval 10min,
// maxStalledCount 2) is the normal recovery, but under Upstash it can give up quietly,
// and the fixed job key then blocks every future enqueue for that job forever.
const STALE_QUEUE_JOB_MS = parseInt(process.env.SCAN_STALE_QUEUE_JOB_MS || String(6 * 60 * 60 * 1000), 10);

/**
 * Bull job key for a scan.
 *
 * Keying by jobId alone meant a backfill for a specific day collided with the nightly
 * run of the same job: the second enqueue found an existing key and silently returned
 * without queueing anything. Days 2..N of a backfill would simply never run.
 */
function buildJobKey(jobId, targetDate) {
  return targetDate ? `scan:${jobId}:${targetDate}` : `scan:${jobId}`;
}

async function enqueueScanJob(jobId, options = {}) {
  const queue = getScanQueue();
  const targetDate = options.targetDate || null;
  const jobKey = buildJobKey(jobId, targetDate);

  const existing = await queue.getJob(jobKey);
  if (existing) {
    // Check the state of the existing job
    const state = await existing.getState();
    const progress = await existing.progress();

    logger.info(`📋 Job already exists: ${jobKey} (state: ${state}, progress: ${progress})`);

    // If job is waiting or active, don't re-queue - unless it has clearly been
    // abandoned, in which case leaving it would block this job permanently.
    if (state === 'waiting' || state === 'active') {
      const startedAt = existing.processedOn || existing.timestamp || 0;
      const ageMs = startedAt ? Date.now() - startedAt : 0;

      if (startedAt && ageMs > STALE_QUEUE_JOB_MS) {
        logger.warn(
          `🧹 Queue job ${jobKey} has been ${state} for ${(ageMs / 3600000).toFixed(1)}h ` +
          `(limit ${(STALE_QUEUE_JOB_MS / 3600000).toFixed(1)}h) - its worker is presumed dead. ` +
          `Removing and re-queueing.`
        );
        await existing.remove();
      } else {
        logger.info(`⏭️ Job ${jobKey} is already in queue with state: ${state}`);
        return existing;
      }
    } else if (state === 'completed' || state === 'failed') {
      // If job is completed/failed, remove it and re-queue
      logger.info(`🔄 Job ${jobKey} is ${state}, removing and re-queueing...`);
      await existing.remove();
    }
  }

  logger.info(`📥 Enqueuing scan job: ${jobKey}`);
  return queue.add(
    'scan-job',
    { jobId, ...options },
    { jobId: jobKey }
  );
}

module.exports = {
  getScanQueue,
  enqueueScanJob,
  buildJobKey,
  STALE_QUEUE_JOB_MS
};
