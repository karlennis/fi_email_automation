const ScanJob = require('../models/ScanJob');
const logger = require('../utils/logger');
const scanJobProcessor = require('./scanJobProcessor');
const { getScanQueue } = require('./scanJobQueue');

async function processScanJob(job) {
  const { jobId, targetDate } = job.data;
  logger.info(`🧵 Worker picked up scan job: ${jobId}`);

  const scanJob = await ScanJob.findOne({ jobId })
    .populate('customers.customerId', 'email company name projectId filters');

  if (!scanJob) {
    throw new Error(`Scan job not found: ${jobId}`);
  }

  scanJob.status = 'RUNNING';
  scanJob.checkpoint = scanJob.checkpoint || {};
  scanJob.checkpoint.isResuming = !!scanJob.checkpoint.processedCount;
  await scanJob.save();

  try {
    await scanJobProcessor.processJob(scanJob, targetDate || null);
    scanJob.status = 'ACTIVE';
    scanJob.checkpoint.isResuming = false;

    // A success clears the failure history, so an occasional transient error never
    // accumulates toward the auto-recovery cap.
    scanJob.recovery = scanJob.recovery || {};
    scanJob.recovery.consecutiveFailures = 0;
    scanJob.recovery.needsAttention = false;
    scanJob.recovery.pausedAt = null;

    await scanJob.save();
    logger.info(`✅ Worker completed scan job: ${jobId}`);
  } catch (error) {
    logger.error(`❌ Worker failed scan job ${jobId}:`, error);
    scanJob.status = 'PAUSED';
    scanJob.checkpoint.isResuming = true;

    // Recorded so sweepStuckJobs can tell a first failure (retry it) from a job that
    // has been failing all week (alert instead of looping).
    scanJob.recovery = scanJob.recovery || {};
    scanJob.recovery.consecutiveFailures = (scanJob.recovery.consecutiveFailures || 0) + 1;
    scanJob.recovery.lastFailureAt = new Date();
    scanJob.recovery.lastFailureReason = String(error && error.message ? error.message : error).slice(0, 500);
    scanJob.recovery.pausedAt = new Date();

    await scanJob.save();
    throw error;   // let Bull run its remaining attempts
  }
}

async function startScanWorker() {
  const queue = getScanQueue();
  const concurrency = parseInt(process.env.SCAN_WORKER_CONCURRENCY || '1', 10);

  logger.info(`🧵 Starting scan worker (concurrency: ${concurrency})`);
  queue.process('scan-job', concurrency, processScanJob);

  // Add event listeners for debugging
  queue.on('waiting', (jobId) => {
    logger.debug(`⏳ Job ${jobId} is waiting to be processed`);
  });

  queue.on('active', (job) => {
    logger.info(`🚀 Job ${job.id} is now active (data: ${JSON.stringify(job.data)})`);
  });

  queue.on('progress', (job, progress) => {
    logger.debug(`📊 Job ${job.id} progress: ${progress}%`);
  });

  queue.on('completed', (job) => {
    logger.info(`✅ Job ${job.id} completed successfully`);
  });

  queue.on('failed', (job, err) => {
    logger.error(`❌ Job ${job.id} failed:`, err.message);
  });

  queue.on('error', (err) => {
    if (err.message && err.message.includes('caller gone')) {
      logger.warn('⚠️ Queue: Redis connection dropped and reconnecting (ERR caller gone)');
    } else {
      logger.error(`❌ Queue error:`, err);
    }
  });

  logger.info(`✅ Scan worker started with event listeners`);
}

module.exports = {
  startScanWorker
};
