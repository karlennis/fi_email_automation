const ScanJob = require('../models/ScanJob');
const logger = require('../utils/logger');
const runContext = require('../utils/runContext');
const scanJobProcessor = require('./scanJobProcessor');
const { getScanQueue } = require('./scanJobQueue');

/**
 * One Bull job = one run. Everything below inherits this runId, including the several
 * hundred log statements inside scanJobProcessor, s3Service and fiDetectionService,
 * so a night's work can be pulled out with `npm run logs -- --run <id>`.
 */
function processScanJob(job) {
  const runId = runContext.newRunId('SCAN');
  return runContext.runWith({ runId, job: job.data.jobId }, () => runScanJob(job));
}

async function runScanJob(job) {
  const { jobId, targetDate } = job.data;
  const startedAt = Date.now();
  logger.info('run start: scan job', { target: targetDate || 'auto' });

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
    logger.info('run end: scan job ok', {
      processed: scanJob.checkpoint.processedCount || 0,
      matched: scanJob.checkpoint.matchesFound || 0,
      sec: Math.round((Date.now() - startedAt) / 1000)
    });
  } catch (error) {
    logger.error('run end: scan job FAILED', error);
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

  queue.process('scan-job', concurrency, processScanJob);

  // Bull emits these outside the run's async context, so they carry no runId and cannot
  // be filtered with the rest of a run. waiting/active/progress/completed all restate
  // what runScanJob already logs with the id attached - debug only.
  queue.on('waiting', (jobId) => logger.debug('queue: job waiting', { bullId: jobId }));
  queue.on('active', (job) => logger.debug('queue: job active', { bullId: job.id, job: job.data.jobId }));
  queue.on('progress', (job, progress) => logger.debug('queue: job progress', { bullId: job.id, pct: progress }));
  queue.on('completed', (job) => logger.debug('queue: job completed', { bullId: job.id }));

  queue.on('failed', (job, err) => {
    logger.error('queue: job failed', { bullId: job && job.id, job: job && job.data && job.data.jobId, err: err.message });
  });

  queue.on('error', (err) => {
    if (err.message && err.message.includes('caller gone')) {
      logger.warn('queue: redis dropped, reconnecting');
    } else {
      logger.error('queue: error', err);
    }
  });

  logger.info('scan worker started', { concurrency });
}

module.exports = {
  startScanWorker
};
