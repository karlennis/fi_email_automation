const Bull = require('bull');
const logger = require('../utils/logger');

let scanQueue;

function getRedisConfig() {
  if (process.env.REDIS_URL) {
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
    scanQueue = new Bull('scan-jobs', redisUrl, {
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: 50,
        removeOnFail: 100
      }
    });

    scanQueue.on('error', (err) => {
      logger.error('❌ Scan queue error:', err);
    });
  }

  return scanQueue;
}

async function enqueueScanJob(jobId, options = {}) {
  const queue = getScanQueue();
  const jobKey = `scan:${jobId}`;

  const existing = await queue.getJob(jobKey);
  if (existing) {
    logger.info(`⏭️ Scan job already queued: ${jobId}`);
    return existing;
  }

  logger.info(`📥 Enqueuing scan job: ${jobId}`);
  return queue.add(
    'scan-job',
    { jobId, ...options },
    { jobId: jobKey }
  );
}

module.exports = {
  getScanQueue,
  enqueueScanJob
};
