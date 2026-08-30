/**
 * Tests for the summary-email send claim.
 *
 * On 2026-08-30 a single nightly enqueue produced two identical FI reports. The scan ran
 * 5h21m over a 15,734 document day, blocked the event loop for 7m29s during the final
 * aggregation, and lost its Bull lock (lockDuration was 90s). The stalled sweep re-queued
 * the job while the original was still running; the completion could not be recorded
 * ("Missing lock for job ..."), and five seconds later the worker picked the re-queued
 * copy up and ran the whole scan again, emailing the same report at 10:52 that it had
 * already sent at 05:31.
 *
 * scanJobQueue's raised lockDuration makes that far less likely. This claim makes the
 * second send impossible regardless, and covers the `attempts: 3` retry path too.
 *
 * No mongo: ScanJobDailyResult is spied on directly.
 */

// scanJobProcessor destructures enqueueScanJob at require time, so a spy on the module
// object would never be seen. Mock the module, keeping the real (pure) buildJobKey.
jest.mock('../scanJobQueue', () => {
  const actual = jest.requireActual('../scanJobQueue');
  return {
    buildJobKey: actual.buildJobKey,
    STALE_QUEUE_JOB_MS: actual.STALE_QUEUE_JOB_MS,
    SCAN_JOB_LOCK_MS: actual.SCAN_JOB_LOCK_MS,
    enqueueScanJob: jest.fn(),
    getScanQueue: jest.fn()
  };
});

const ScanJobDailyResult = require('../../models/ScanJobDailyResult');
const scanJobProcessor = require('../scanJobProcessor');

/**
 * Local midnight, not UTC midnight: saveDailyScanResult normalises scanDate with
 * setHours(0,0,0,0), and the claim has to land on the same row or it would never
 * collide with the send it is meant to block.
 */
function localMidnight(dateKey) {
  const [y, m, d] = dateKey.split('-').map(Number);
  return new Date(y, m - 1, d, 0, 0, 0, 0);
}

function duplicateKeyError() {
  const err = new Error('E11000 duplicate key error collection: scanjobdailyresults');
  err.code = 11000;
  return err;
}

describe('claimSummaryEmailSend', () => {
  afterEach(() => jest.restoreAllMocks());

  test('the first caller for a day wins the claim', async () => {
    const upsert = jest.spyOn(ScanJobDailyResult, 'findOneAndUpdate').mockResolvedValue({});

    const claimed = await scanJobProcessor.claimSummaryEmailSend(
      'SCAN-1', localMidnight('2026-08-30'), 'admin@example.com'
    );

    expect(claimed).toBe(true);
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  test('the claim filter only matches a day that has not sent yet', async () => {
    const upsert = jest.spyOn(ScanJobDailyResult, 'findOneAndUpdate').mockResolvedValue({});

    await scanJobProcessor.claimSummaryEmailSend(
      'SCAN-1', localMidnight('2026-08-30'), 'admin@example.com'
    );

    const [filter, update, options] = upsert.mock.calls[0];
    // Without this term the upsert would match an already-sent row and update it,
    // handing the duplicate run a second send.
    expect(filter).toEqual({
      jobId: 'SCAN-1',
      scanDate: localMidnight('2026-08-30'),
      summaryEmailSentAt: null
    });
    expect(update.$set.summaryEmailTo).toBe('admin@example.com');
    expect(update.$set.summaryEmailSentAt).toBeInstanceOf(Date);
    // The unique {jobId, scanDate} index is what turns the losing race into an error.
    expect(options.upsert).toBe(true);
  });

  test('a second execution of the same run does not get to send', async () => {
    jest.spyOn(ScanJobDailyResult, 'findOneAndUpdate').mockRejectedValue(duplicateKeyError());

    const claimed = await scanJobProcessor.claimSummaryEmailSend(
      'SCAN-1', localMidnight('2026-08-30'), 'admin@example.com'
    );

    expect(claimed).toBe(false);
  });

  test('a claim that cannot be evaluated fails closed rather than sending', async () => {
    jest.spyOn(ScanJobDailyResult, 'findOneAndUpdate').mockRejectedValue(new Error('mongo down'));

    const claimed = await scanJobProcessor.claimSummaryEmailSend(
      'SCAN-1', localMidnight('2026-08-30'), 'admin@example.com'
    );

    // A duplicate report is the failure being fixed; the scan itself still succeeded.
    expect(claimed).toBe(false);
  });

  test('a scanDate carrying a time of day is normalised to the row key', async () => {
    const upsert = jest.spyOn(ScanJobDailyResult, 'findOneAndUpdate').mockResolvedValue({});
    const midMorning = new Date(2026, 7, 30, 10, 52, 43);

    await scanJobProcessor.claimSummaryEmailSend('SCAN-1', midMorning, 'admin@example.com');

    expect(upsert.mock.calls[0][0].scanDate).toEqual(localMidnight('2026-08-30'));
  });

  test('claims for different days are independent', async () => {
    const upsert = jest.spyOn(ScanJobDailyResult, 'findOneAndUpdate').mockResolvedValue({});

    await scanJobProcessor.claimSummaryEmailSend('SCAN-1', localMidnight('2026-08-29'), 'a@b.com');
    await scanJobProcessor.claimSummaryEmailSend('SCAN-1', localMidnight('2026-08-30'), 'a@b.com');

    // A backfill walking several days must still email each one.
    expect(upsert.mock.calls[0][0].scanDate).toEqual(localMidnight('2026-08-29'));
    expect(upsert.mock.calls[1][0].scanDate).toEqual(localMidnight('2026-08-30'));
  });
});

describe('releaseSummaryEmailClaim', () => {
  afterEach(() => jest.restoreAllMocks());

  test('clears the claim so a later pass can still deliver the report', async () => {
    const update = jest.spyOn(ScanJobDailyResult, 'updateOne').mockResolvedValue({});

    await scanJobProcessor.releaseSummaryEmailClaim('SCAN-1', localMidnight('2026-08-30'));

    const [filter, doc] = update.mock.calls[0];
    expect(filter).toEqual({ jobId: 'SCAN-1', scanDate: localMidnight('2026-08-30') });
    expect(doc.$set.summaryEmailSentAt).toBeNull();
  });

  test('a release that fails does not take the run down with it', async () => {
    jest.spyOn(ScanJobDailyResult, 'updateOne').mockRejectedValue(new Error('mongo down'));

    await expect(
      scanJobProcessor.releaseSummaryEmailClaim('SCAN-1', localMidnight('2026-08-30'))
    ).resolves.toBeUndefined();
  });
});
