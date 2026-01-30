const ScanJob = require('../models/ScanJob');
const logger = require('../utils/logger');
const scanJobProcessor = require('./scanJobProcessor');
const { getScanQueue } = require('./scanJobQueue');

async function processScanJob(job) {
  const { jobId, targetDate } = job.data;
  logger.info(`🧵 Worker picked up scan job: ${jobId}`);

  const scanJob = await ScanJob.findOne({ jobId })
    .populate('customers.customerId', 'email company name projectId');

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
    await scanJob.save();
    logger.info(`✅ Worker completed scan job: ${jobId}`);
  } catch (error) {
    logger.error(`❌ Worker failed scan job ${jobId}:`, error);
    scanJob.status = 'PAUSED';
    scanJob.checkpoint.isResuming = true;
    await scanJob.save();
    throw error;
  }
}

async function startScanWorker() {
  const queue = getScanQueue();
  const concurrency = parseInt(process.env.SCAN_WORKER_CONCURRENCY || '1', 10);

  logger.info(`🧵 Starting scan worker (concurrency: ${concurrency})`);
  queue.process('scan-job', concurrency, processScanJob);
}

module.exports = {
  startScanWorker
};
