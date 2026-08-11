/**
 * Tests for coverage-gap detection and bounded backfill (audit item 13).
 *
 * lookbackDays is hardcoded to 1 for the scan window and there was no gap detection at
 * all, so a scan that overran 24h meant the following day was never enqueued and those
 * documents were never examined. Production covered 130 of 132 days, plus 5 days that
 * processed zero documents.
 *
 * The 0-processed case matters as much as the missing-row case: a resume that never
 * re-finds its checkpoint marker skips every document and then writes a 0-match daily
 * result, which is indistinguishable from a genuinely quiet day (audit §1.2).
 *
 * No mongo: ScanJobDailyResult.find and the queue are spied on.
 */

// scanJobProcessor destructures enqueueScanJob at require time, so a spy on the module
// object would never be seen. Mock the module, keeping the real (pure) buildJobKey.
jest.mock('../scanJobQueue', () => {
  const actual = jest.requireActual('../scanJobQueue');
  return {
    buildJobKey: actual.buildJobKey,
    STALE_QUEUE_JOB_MS: actual.STALE_QUEUE_JOB_MS,
    enqueueScanJob: jest.fn(),
    getScanQueue: jest.fn()
  };
});

const ScanJobDailyResult = require('../../models/ScanJobDailyResult');
const scanJobQueue = require('../scanJobQueue');
const scanJobProcessor = require('../scanJobProcessor');

// Fixed "now" so the horizon walk is deterministic. Yesterday is 2026-08-10.
const NOW = new Date('2026-08-11T09:00:00.000Z');

function stubRows(rows) {
  return jest.spyOn(ScanJobDailyResult, 'find').mockReturnValue({
    select: jest.fn().mockReturnValue({
      lean: jest.fn().mockResolvedValue(rows)
    })
  });
}

/**
 * Build a stored row for a day.
 *
 * Local midnight, not UTC midnight: saveDailyScanResult normalises scanDate with
 * setHours(0,0,0,0), so a fixture built at UTC midnight would land on the previous day
 * on any host east of Greenwich and the whole suite would drift with the TZ.
 */
function localMidnight(dateKey) {
  const [y, m, d] = dateKey.split('-').map(Number);
  return new Date(y, m - 1, d, 0, 0, 0, 0);
}

function row(date, { processedCount = 100, scanAttempts = 1 } = {}) {
  return { scanDate: localMidnight(date), processedCount, scanAttempts };
}

function job(overrides = {}) {
  return { jobId: 'SCAN-1', schedule: { lookbackDays: 1 }, checkpoint: {}, ...overrides };
}

let enqueueSpy;

beforeEach(() => {
  jest.useFakeTimers().setSystemTime(NOW);
  enqueueSpy = jest.spyOn(scanJobQueue, 'enqueueScanJob').mockResolvedValue({});
  process.env.SCAN_BACKFILL_ENABLED = 'true';
  delete process.env.SCAN_BACKFILL_HORIZON_DAYS;
  delete process.env.SCAN_BACKFILL_MAX_DAYS_PER_NIGHT;
});

afterEach(() => {
  jest.restoreAllMocks();
  // restoreAllMocks unwraps the spy but leaves the underlying jest.fn() from jest.mock,
  // so its call log would carry into the next test.
  scanJobQueue.enqueueScanJob.mockClear();
  jest.useRealTimers();
  delete process.env.SCAN_BACKFILL_ENABLED;
  delete process.env.SCAN_BACKFILL_HORIZON_DAYS;
});

describe('findCoverageGaps', () => {
  test('a fully covered horizon has no gaps', async () => {
    stubRows(['2026-08-08', '2026-08-09', '2026-08-10'].map(d => row(d)));

    const gaps = await scanJobProcessor.findCoverageGaps(job(), { horizonDays: 3 });

    expect(gaps).toEqual([]);
  });

  test('a missing row is a gap', async () => {
    stubRows([row('2026-08-08'), row('2026-08-10')]);

    const gaps = await scanJobProcessor.findCoverageGaps(job(), { horizonDays: 3 });

    expect(gaps).toEqual(['2026-08-09']);
  });

  test('a row that processed zero documents is a gap, not a covered day', async () => {
    // Audit §1.2: a resume whose checkpoint marker is missing skips every document and
    // still "completes", writing a 0-processed result. Treating that as covered is what
    // let five production days disappear silently.
    stubRows([
      row('2026-08-08'),
      row('2026-08-09', { processedCount: 0, scanAttempts: 1 }),
      row('2026-08-10')
    ]);

    const gaps = await scanJobProcessor.findCoverageGaps(job(), { horizonDays: 3 });

    expect(gaps).toEqual(['2026-08-09']);
  });

  test('a genuinely empty day is accepted after enough attempts', async () => {
    // Otherwise a bank holiday is re-scanned every night forever, at a full bucket walk
    // each time.
    stubRows([
      row('2026-08-08'),
      row('2026-08-09', { processedCount: 0, scanAttempts: 2 }),
      row('2026-08-10')
    ]);

    const gaps = await scanJobProcessor.findCoverageGaps(job(), { horizonDays: 3 });

    expect(gaps).toEqual([]);
  });

  test('gaps come back oldest first so nothing starves behind newer days', async () => {
    stubRows([row('2026-08-10')]);

    const gaps = await scanJobProcessor.findCoverageGaps(job(), { horizonDays: 4 });

    expect(gaps).toEqual(['2026-08-07', '2026-08-08', '2026-08-09']);
  });

  test('never proposes today - it is still accumulating documents', async () => {
    stubRows([]);

    const gaps = await scanJobProcessor.findCoverageGaps(job(), { horizonDays: 3 });

    expect(gaps).not.toContain('2026-08-11');
    expect(gaps[gaps.length - 1]).toBe('2026-08-10');
  });

  test('the horizon is the configured cap, whatever lookbackDays says', async () => {
    // lookbackDays governs delivery and is 1 for essentially every job. Using it as the
    // gap horizon would limit detection to yesterday - the day the nightly run has just
    // enqueued - and backfill would never find anything at all.
    stubRows([]);

    const daily = await scanJobProcessor.findCoverageGaps(job({ schedule: { lookbackDays: 1 } }));
    const yearly = await scanJobProcessor.findCoverageGaps(job({ schedule: { lookbackDays: 365 } }));

    // Every backfill day is a full ListObjectsV2 walk (~570k objects), so 365 must not
    // become 365 walks either.
    expect(daily).toHaveLength(14);    // SCAN_BACKFILL_HORIZON_DAYS default
    expect(yearly).toHaveLength(14);
  });

  test('honours SCAN_BACKFILL_HORIZON_DAYS', async () => {
    process.env.SCAN_BACKFILL_HORIZON_DAYS = '3';
    stubRows([]);

    const gaps = await scanJobProcessor.findCoverageGaps(job({ schedule: { lookbackDays: 365 } }));

    expect(gaps).toHaveLength(3);
  });
});

describe('enqueueBackfill', () => {
  // A 4-day horizon keeps these assertions readable; the default 14 is exercised above.
  beforeEach(() => {
    process.env.SCAN_BACKFILL_HORIZON_DAYS = '4';
  });

  test('does nothing unless explicitly enabled', async () => {
    process.env.SCAN_BACKFILL_ENABLED = 'false';
    stubRows([]);

    const result = await scanJobProcessor.enqueueBackfill(job());

    expect(result.skipped).toBe('disabled');
    expect(enqueueSpy).not.toHaveBeenCalled();
  });

  test('queues one day per night by default, the oldest gap first', async () => {
    stubRows([row('2026-08-10')]);

    const result = await scanJobProcessor.enqueueBackfill(job(), { maxDays: undefined });

    expect(enqueueSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSpy).toHaveBeenCalledWith('SCAN-1', { targetDate: '2026-08-07' });
    expect(result.enqueued).toEqual(['2026-08-07']);
    expect(result.outstanding).toBeGreaterThan(1);
  });

  test('respects a raised per-night cap', async () => {
    stubRows([row('2026-08-10')]);

    const result = await scanJobProcessor.enqueueBackfill(job(), { maxDays: 3 });

    expect(enqueueSpy).toHaveBeenCalledTimes(3);
    expect(result.enqueued).toEqual(['2026-08-07', '2026-08-08', '2026-08-09']);
  });

  test('skips the day the job is currently resuming, to avoid scanning it twice', async () => {
    stubRows([row('2026-08-10')]);
    const resuming = job({
      checkpoint: { isResuming: true, scanStartDate: '2026-08-08T00:00:00.000Z' }
    });

    const result = await scanJobProcessor.enqueueBackfill(resuming, { maxDays: 3 });

    expect(result.enqueued).not.toContain('2026-08-08');
    expect(result.enqueued).toEqual(['2026-08-07', '2026-08-09']);
  });

  test('reports no-gaps without touching the queue', async () => {
    stubRows(['2026-08-07', '2026-08-08', '2026-08-09', '2026-08-10'].map(d => row(d)));

    const result = await scanJobProcessor.enqueueBackfill(job());

    expect(result.skipped).toBe('no-gaps');
    expect(enqueueSpy).not.toHaveBeenCalled();
  });

  test('a failure is swallowed so it cannot take down the nightly run', async () => {
    jest.spyOn(ScanJobDailyResult, 'find').mockImplementation(() => { throw new Error('mongo down'); });

    const result = await scanJobProcessor.enqueueBackfill(job());

    expect(result.skipped).toBe('error');
    expect(enqueueSpy).not.toHaveBeenCalled();
  });
});

describe('buildDeliveryWindowFilter', () => {
  const anchor = new Date('2026-08-10T00:00:00.000Z');
  // Day keys are read with the same local-parts helper the production code uses -
  // scanDate is normalised with setHours(0,0,0,0), so toISOString() would shift the
  // key by a day on any host that is not UTC.
  const key = (d) => scanJobProcessor.toLocalDateKey(d);

  test('covers the normal lookback window', async () => {
    const { filter, windowStart, windowEnd } = scanJobProcessor.buildDeliveryWindowFilter(
      job({ schedule: { lookbackDays: 3 } }), anchor
    );

    expect(filter.jobId).toBe('SCAN-1');
    expect(key(windowStart)).toBe('2026-08-08');
    expect(key(windowEnd)).toBe('2026-08-10');
    expect(filter.$or[0].scanDate).toEqual({ $gte: windowStart, $lte: windowEnd });
  });

  test('also picks up older days that were never delivered', async () => {
    // A backfilled day falls outside the lookback window, so without this clause it
    // would be scanned and then never sent to anyone.
    const { filter, backfillFloor, windowStart } = scanJobProcessor.buildDeliveryWindowFilter(job(), anchor);

    expect(filter.$or[1]).toEqual({
      scanDate: { $gte: backfillFloor, $lt: windowStart },
      delivered: false
    });
  });

  test('the older clause requires delivered:false, so a re-delivery cannot resend weeks of leads', () => {
    const { filter } = scanJobProcessor.buildDeliveryWindowFilter(job(), anchor);

    expect(filter.$or[1].delivered).toBe(false);
  });

  test('the backfill floor is bounded by the horizon, not unlimited', () => {
    const { backfillFloor } = scanJobProcessor.buildDeliveryWindowFilter(job(), anchor);

    // 14 days before the anchor day (SCAN_BACKFILL_HORIZON_DAYS default).
    expect(key(backfillFloor)).toBe('2026-07-27');
  });
});
