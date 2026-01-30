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
        tls: url.protocol === 'rediss:' ? {} : undefined
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
