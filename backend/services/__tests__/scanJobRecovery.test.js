/**
 * Tests for the stuck-job sweeper (audit item 15).
 *
 * scanJobWorker sets PAUSED on failure and rethrows so Bull retries three times, but the
 * daily recovery query only ever looked for ACTIVE/RUNNING. Once those attempts were
 * exhausted nothing looked at the job again: no dead-letter consumer, no alert, and the
 * job silently stopped producing leads. scripts/check-stuck-jobs.js exists because of it.
 *
 * No mongo, no redis: ScanJob statics, the queue accessor and emailService are spied on.
 */

// scanJobProcessor destructures these at require time, so a spy on the module object
// would never be seen. Mock the module itself, keeping the real (pure) buildJobKey.
jest.mock('../scanJobQueue', () => {
  const actual = jest.requireActual('../scanJobQueue');
  return {
    buildJobKey: actual.buildJobKey,
    STALE_QUEUE_JOB_MS: actual.STALE_QUEUE_JOB_MS,
    enqueueScanJob: jest.fn(),
    getScanQueue: jest.fn()
  };
});

const ScanJob = require('../../models/ScanJob');
const emailService = require('../emailService');
const scanJobQueue = require('../scanJobQueue');
const scanJobProcessor = require('../scanJobProcessor');

const MINUTE = 60 * 1000;

/** A ScanJob stand-in that records saves. */
function fakeJob(overrides = {}) {
  return {
    jobId: 'SCAN-1',
    name: 'Acoustic nightly',
    status: 'PAUSED',
    checkpoint: { processedCount: 100, totalDocuments: 200, lastCheckpointTime: null },
    recovery: {},
    save: jest.fn().mockResolvedValue(undefined),
    ...overrides
  };
}

function stubFind(jobs) {
  return jest.spyOn(ScanJob, 'find').mockReturnValue({
    select: jest.fn().mockResolvedValue(jobs)
  });
}

let enqueueSpy;
let alertSpy;
let updateOneSpy;

beforeEach(() => {
  // These tests call recoverStuckJobs() directly, bypassing the withLock wrapper in
  // sweepStuckJobs, so no mongoose connection is needed.
  enqueueSpy = scanJobQueue.enqueueScanJob.mockResolvedValue({});
  alertSpy = jest.spyOn(emailService, 'sendJobAlertEmail').mockResolvedValue({ success: true });
  updateOneSpy = jest.spyOn(ScanJob, 'updateOne').mockResolvedValue({});
  scanJobQueue.getScanQueue.mockReturnValue({
    getFailed: jest.fn().mockResolvedValue([]),
    getJob: jest.fn().mockResolvedValue(null)
  });
});

afterEach(() => {
  jest.restoreAllMocks();
  scanJobQueue.enqueueScanJob.mockReset();
  scanJobQueue.getScanQueue.mockReset();
  delete process.env.SCAN_MAX_AUTO_RECOVERY;
  delete process.env.ALERT_COOLDOWN_HOURS;
});

describe('which jobs the sweeper will touch', () => {
  test('only PAUSED jobs the worker actually failed are eligible', async () => {
    // status defaults to PAUSED on the schema, so "PAUSED" alone also means "created but
    // never started". Resuming one of those would launch a job an admin never enabled and
    // email its customers unbidden.
    const findSpy = stubFind([]);

    await scanJobProcessor.recoverStuckJobs();

    const filter = findSpy.mock.calls[0][0];
    const pausedClause = filter.$or.find(clause => clause.status === 'PAUSED');
    expect(pausedClause['recovery.consecutiveFailures']).toEqual({ $gte: 1 });
  });

  test('RUNNING jobs are swept without a failure count - only the worker sets RUNNING', async () => {
    const findSpy = stubFind([]);
    await scanJobProcessor.recoverStuckJobs();

    const filter = findSpy.mock.calls[0][0];
    expect(filter.$or).toContainEqual({ status: 'RUNNING' });
  });
});

describe('PAUSED recovery', () => {
  test('resumes a job past the grace period and re-queues it', async () => {
    const job = fakeJob({
      recovery: { consecutiveFailures: 1, pausedAt: new Date(Date.now() - 45 * MINUTE) }
    });
    stubFind([job]);

    const summary = await scanJobProcessor.recoverStuckJobs();

    expect(job.status).toBe('ACTIVE');
    expect(job.checkpoint.isResuming).toBe(true);
    expect(enqueueSpy).toHaveBeenCalledWith('SCAN-1', { targetDate: null });
    expect(summary.resumed).toBe(1);
  });

  test('leaves a job still inside the grace period alone, so Bull can finish its retries', async () => {
    const job = fakeJob({
      recovery: { consecutiveFailures: 1, pausedAt: new Date(Date.now() - 5 * MINUTE) }
    });
    stubFind([job]);

    const summary = await scanJobProcessor.recoverStuckJobs();

    expect(job.status).toBe('PAUSED');
    expect(enqueueSpy).not.toHaveBeenCalled();
    expect(summary.resumed).toBe(0);
  });

  test('stops auto-resuming at the failure cap and flags for attention instead', async () => {
    const job = fakeJob({
      recovery: {
        consecutiveFailures: 3,
        pausedAt: new Date(Date.now() - 45 * MINUTE),
        lastFailureReason: 'Memory limit reached at 1750MB'
      }
    });
    stubFind([job]);

    const summary = await scanJobProcessor.recoverStuckJobs();

    expect(enqueueSpy).not.toHaveBeenCalled();
    expect(job.recovery.needsAttention).toBe(true);
    expect(summary.needsAttention).toBe(1);

    expect(alertSpy).toHaveBeenCalledTimes(1);
    const alert = alertSpy.mock.calls[0][1];
    expect(alert.severity).toBe('critical');
    expect(alert.details['Last error']).toContain('Memory limit');
  });

  test('a job that cannot be dated is left for manual review, never guessed at', async () => {
    const job = fakeJob({ recovery: { consecutiveFailures: 2 } });
    job.checkpoint.lastCheckpointTime = null;
    stubFind([job]);

    const summary = await scanJobProcessor.recoverStuckJobs();

    expect(enqueueSpy).not.toHaveBeenCalled();
    expect(job.status).toBe('PAUSED');
    expect(summary.resumed).toBe(0);
  });

  test('falls back to the checkpoint heartbeat for a job predating recovery.pausedAt', async () => {
    const job = fakeJob({ recovery: { consecutiveFailures: 1 } });
    job.checkpoint.lastCheckpointTime = new Date(Date.now() - 90 * MINUTE);
    stubFind([job]);

    await scanJobProcessor.recoverStuckJobs();

    expect(enqueueSpy).toHaveBeenCalledWith('SCAN-1', { targetDate: null });
  });

  test('honours SCAN_MAX_AUTO_RECOVERY', async () => {
    process.env.SCAN_MAX_AUTO_RECOVERY = '1';
    const job = fakeJob({
      recovery: { consecutiveFailures: 1, pausedAt: new Date(Date.now() - 45 * MINUTE) }
    });
    stubFind([job]);

    const summary = await scanJobProcessor.recoverStuckJobs();

    expect(enqueueSpy).not.toHaveBeenCalled();
    expect(summary.needsAttention).toBe(1);
  });
});

describe('alert rate limiting', () => {
  test('suppresses a second alert inside the cooldown', async () => {
    const job = fakeJob({
      recovery: {
        consecutiveFailures: 3,
        pausedAt: new Date(Date.now() - 45 * MINUTE),
        alertedAt: new Date(Date.now() - 30 * MINUTE)
      }
    });
    stubFind([job]);

    await scanJobProcessor.recoverStuckJobs();

    // Otherwise a permanently broken job emails every 15 minutes, forever.
    expect(alertSpy).not.toHaveBeenCalled();
  });

  test('sends again once the cooldown has elapsed', async () => {
    process.env.ALERT_COOLDOWN_HOURS = '1';
    const job = fakeJob({
      recovery: {
        consecutiveFailures: 3,
        pausedAt: new Date(Date.now() - 45 * MINUTE),
        alertedAt: new Date(Date.now() - 90 * MINUTE)
      }
    });
    stubFind([job]);

    await scanJobProcessor.recoverStuckJobs();

    expect(alertSpy).toHaveBeenCalledTimes(1);
  });

  test('stamps alertedAt even when the send fails, so a dead transporter cannot spam', async () => {
    alertSpy.mockResolvedValue({ success: false, reason: 'Email service not configured' });
    const job = fakeJob({
      recovery: { consecutiveFailures: 3, pausedAt: new Date(Date.now() - 45 * MINUTE) }
    });
    stubFind([job]);

    await scanJobProcessor.recoverStuckJobs();

    const stamped = updateOneSpy.mock.calls.find(
      ([, update]) => update?.$set && 'recovery.alertedAt' in update.$set
    );
    expect(stamped).toBeDefined();
  });
});

describe('stalled RUNNING recovery', () => {
  test('resets a RUNNING job whose heartbeat stopped and has no active queue job', async () => {
    const job = fakeJob({
      status: 'RUNNING',
      checkpoint: { processedCount: 50, totalDocuments: 900, lastCheckpointTime: new Date(Date.now() - 120 * MINUTE) }
    });
    stubFind([job]);

    const summary = await scanJobProcessor.recoverStuckJobs();

    expect(job.status).toBe('ACTIVE');
    expect(job.checkpoint.isResuming).toBe(true);
    expect(summary.runningReset).toBe(1);
  });

  test('leaves a RUNNING job alone while a live queue job is still active', async () => {
    scanJobQueue.getScanQueue.mockReturnValue({
      getFailed: jest.fn().mockResolvedValue([]),
      getJob: jest.fn().mockResolvedValue({ getState: jest.fn().mockResolvedValue('active') })
    });
    const job = fakeJob({
      status: 'RUNNING',
      checkpoint: { processedCount: 50, totalDocuments: 900, lastCheckpointTime: new Date(Date.now() - 120 * MINUTE) }
    });
    stubFind([job]);

    const summary = await scanJobProcessor.recoverStuckJobs();

    expect(job.status).toBe('RUNNING');
    expect(summary.runningReset).toBe(0);
  });

  test('leaves a recently-checkpointing RUNNING job alone', async () => {
    const job = fakeJob({
      status: 'RUNNING',
      checkpoint: { processedCount: 50, totalDocuments: 900, lastCheckpointTime: new Date(Date.now() - 2 * MINUTE) }
    });
    stubFind([job]);

    const summary = await scanJobProcessor.recoverStuckJobs();

    expect(job.status).toBe('RUNNING');
    expect(summary.runningReset).toBe(0);
  });

  test('does nothing when redis is unreachable rather than duplicating a live scan', async () => {
    scanJobQueue.getScanQueue.mockReturnValue({
      getFailed: jest.fn().mockResolvedValue([]),
      getJob: jest.fn().mockRejectedValue(new Error('ECONNREFUSED'))
    });
    const job = fakeJob({
      status: 'RUNNING',
      checkpoint: { processedCount: 50, totalDocuments: 900, lastCheckpointTime: new Date(Date.now() - 120 * MINUTE) }
    });
    stubFind([job]);

    const summary = await scanJobProcessor.recoverStuckJobs();

    expect(job.status).toBe('RUNNING');
    expect(summary.runningReset).toBe(0);
  });
});

describe('dead-letter drain', () => {
  test('removes exhausted queue jobs and records why they failed', async () => {
    // removeOnFail: 100 leaves failures in redis with nothing consuming them, and the
    // fixed job key then blocks every future enqueue for that job.
    const remove = jest.fn().mockResolvedValue(undefined);
    scanJobQueue.getScanQueue.mockReturnValue({
      getJob: jest.fn().mockResolvedValue(null),
      getFailed: jest.fn().mockResolvedValue([
        { id: 'scan:SCAN-1', data: { jobId: 'SCAN-1' }, failedReason: 'boom', finishedOn: Date.now(), remove }
      ])
    });
    stubFind([]);

    const summary = await scanJobProcessor.recoverStuckJobs();

    expect(remove).toHaveBeenCalled();
    expect(summary.drained).toBe(1);
    const recorded = updateOneSpy.mock.calls.find(
      ([, update]) => update?.$set?.['recovery.lastFailureReason'] === 'boom'
    );
    expect(recorded).toBeDefined();
  });

  test('survives redis being down', async () => {
    scanJobQueue.getScanQueue.mockReturnValue({
      getJob: jest.fn().mockResolvedValue(null),
      getFailed: jest.fn().mockRejectedValue(new Error('ECONNREFUSED'))
    });
    stubFind([]);

    await expect(scanJobProcessor.recoverStuckJobs()).resolves.toEqual(
      expect.objectContaining({ drained: 0 })
    );
  });
});

describe('enqueueScanJob keying', () => {
  const { buildJobKey } = scanJobQueue;

  test('a targetDate produces a distinct key from the nightly run', () => {
    // With a single scan:<jobId> key, the second enqueue found the existing key and
    // returned without queueing - so backfill days 2..N would silently never run.
    expect(buildJobKey('SCAN-1', null)).toBe('scan:SCAN-1');
    expect(buildJobKey('SCAN-1', '2026-08-01')).toBe('scan:SCAN-1:2026-08-01');
    expect(buildJobKey('SCAN-1', '2026-08-02'))
      .not.toBe(buildJobKey('SCAN-1', '2026-08-01'));
  });
});
