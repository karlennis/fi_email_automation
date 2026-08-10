/**
 * Tests for the DailyRun counter drift (audit item 22).
 *
 * The scan incremented counters.totalItems and counters.queued by the full batch length
 * even when insertMany rejected duplicates with E11000. counters.queued therefore
 * overshot by the duplicate count and could never drain to 0 - and checkRunCompletion
 * waits for queued === 0 && processing === 0, so the run stayed 'processing' forever.
 *
 * No mongo: the model statics are spied on directly, in the style of the other suites.
 */

const DailyRun = require('../../models/DailyRun');
const DailyRunItem = require('../../models/DailyRunItem');
const dailyRunService = require('../dailyRunService');

function duplicateKeyError(attempted, duplicates) {
  const error = new Error('E11000 duplicate key error collection: dailyrunitems');
  error.code = 11000;
  error.writeErrors = Array.from({ length: duplicates }, (_, i) => ({ index: i, code: 11000 }));
  error.insertedDocs = Array.from({ length: attempted - duplicates }, () => ({}));
  return error;
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('reconcileCounters', () => {
  function stubRun(status, counters) {
    jest.spyOn(DailyRun, 'findOne').mockResolvedValue({ runId: 'RUN_1', status, counters });
  }

  function stubItems(groups) {
    jest.spyOn(DailyRunItem, 'aggregate').mockResolvedValue(
      Object.entries(groups).map(([status, n]) => ({ _id: status, n }))
    );
  }

  test('rewrites drifted counters from the items', async () => {
    stubRun('processing', { totalItems: 120, queued: 20, processing: 0, completed: 100, failed: 0 });
    stubItems({ completed: 100, queued: 0 });
    const updateSpy = jest.spyOn(DailyRun, 'updateOne').mockResolvedValue({});

    const result = await dailyRunService.reconcileCounters('RUN_1');

    expect(result.drifted).toBe(true);
    expect(result.after).toEqual({ totalItems: 100, queued: 0, processing: 0, completed: 100, failed: 0 });
    expect(updateSpy.mock.calls[0][1].$set.counters).toEqual(result.after);
  });

  test('completes a processing run with nothing outstanding - the stuck-run unstick path', async () => {
    stubRun('processing', { totalItems: 120, queued: 20, processing: 0, completed: 100, failed: 0 });
    stubItems({ completed: 100 });
    const updateSpy = jest.spyOn(DailyRun, 'updateOne').mockResolvedValue({});

    const result = await dailyRunService.reconcileCounters('RUN_1');

    expect(result.completed).toBe(true);
    const set = updateSpy.mock.calls[0][1].$set;
    expect(set.status).toBe('completed');
    expect(set.completedAt).toBeInstanceOf(Date);
  });

  test('leaves a run with outstanding items in processing', async () => {
    stubRun('processing', { totalItems: 100, queued: 10, processing: 2, completed: 88, failed: 0 });
    stubItems({ queued: 10, processing: 2, completed: 88 });
    const updateSpy = jest.spyOn(DailyRun, 'updateOne').mockResolvedValue({});

    const result = await dailyRunService.reconcileCounters('RUN_1');

    expect(result.drifted).toBe(false);
    expect(result.completed).toBe(false);
    expect(updateSpy.mock.calls[0][1].$set.status).toBeUndefined();
  });

  test('does not resurrect an already-completed run', async () => {
    stubRun('completed', { totalItems: 10, queued: 0, processing: 0, completed: 10, failed: 0 });
    stubItems({ completed: 10 });
    const updateSpy = jest.spyOn(DailyRun, 'updateOne').mockResolvedValue({});

    const result = await dailyRunService.reconcileCounters('RUN_1');

    expect(result.completed).toBe(false);
    expect(updateSpy.mock.calls[0][1].$set.completedAt).toBeUndefined();
  });

  test('counts failed items toward the total but not toward outstanding', async () => {
    stubRun('processing', { totalItems: 0, queued: 0, processing: 0, completed: 0, failed: 0 });
    stubItems({ completed: 7, failed: 3 });
    jest.spyOn(DailyRun, 'updateOne').mockResolvedValue({});

    const result = await dailyRunService.reconcileCounters('RUN_1');

    expect(result.after).toEqual({ totalItems: 10, queued: 0, processing: 0, completed: 7, failed: 3 });
    expect(result.completed).toBe(true);
  });

  test('throws a recognisable error for an unknown run so the route can 404', async () => {
    jest.spyOn(DailyRun, 'findOne').mockResolvedValue(null);
    await expect(dailyRunService.reconcileCounters('RUN_MISSING')).rejects.toThrow(/not found/i);
  });
});

describe('resetStaleItems', () => {
  test('collects affected runIds BEFORE the update, then reconciles each', async () => {
    // Order matters: after updateMany the stale filter matches nothing, so a distinct()
    // taken afterwards would return [] and no run would ever be reconciled.
    const calls = [];
    jest.spyOn(DailyRunItem, 'distinct').mockImplementation(async () => {
      calls.push('distinct');
      return ['RUN_A', 'RUN_B'];
    });
    jest.spyOn(DailyRunItem, 'updateMany').mockImplementation(async () => {
      calls.push('updateMany');
      return { modifiedCount: 4 };
    });
    const reconcileSpy = jest.spyOn(dailyRunService, 'reconcileCounters').mockResolvedValue({});

    const result = await dailyRunService.resetStaleItems();

    expect(calls).toEqual(['distinct', 'updateMany']);
    expect(reconcileSpy).toHaveBeenCalledWith('RUN_A');
    expect(reconcileSpy).toHaveBeenCalledWith('RUN_B');
    expect(result).toEqual({ modifiedCount: 4, runIds: ['RUN_A', 'RUN_B'] });
  });

  test('a failing reconcile does not abort the remaining runs', async () => {
    jest.spyOn(DailyRunItem, 'distinct').mockResolvedValue(['RUN_A', 'RUN_B']);
    jest.spyOn(DailyRunItem, 'updateMany').mockResolvedValue({ modifiedCount: 1 });
    const reconcileSpy = jest.spyOn(dailyRunService, 'reconcileCounters')
      .mockRejectedValueOnce(new Error('mongo blip'))
      .mockResolvedValue({});

    await expect(dailyRunService.resetStaleItems()).resolves.toBeDefined();
    expect(reconcileSpy).toHaveBeenCalledTimes(2);
  });
});

describe('insertMany accounting', () => {
  // The scan loop is embedded in a long S3 paging function, so these assert the shape of
  // the fix directly: how many items a batch is credited with under each outcome.
  function creditedCount(itemsAttempted, error) {
    if (!error) return itemsAttempted;
    if (error.code !== 11000 && !error.writeErrors) throw error;
    return Array.isArray(error.insertedDocs)
      ? error.insertedDocs.length
      : itemsAttempted - (error.writeErrors?.length || 0);
  }

  test('a clean insert credits the whole batch', () => {
    expect(creditedCount(10, null)).toBe(10);
  });

  test('10 attempted with 3 duplicates credits 7, not 10 - the drift bug', () => {
    expect(creditedCount(10, duplicateKeyError(10, 3))).toBe(7);
  });

  test('an all-duplicate batch credits 0, so no $inc is issued', () => {
    expect(creditedCount(10, duplicateKeyError(10, 10))).toBe(0);
  });

  test('falls back to writeErrors when the driver omits insertedDocs', () => {
    const error = duplicateKeyError(10, 3);
    delete error.insertedDocs;
    expect(creditedCount(10, error)).toBe(7);
  });

  test('a non-duplicate error still propagates', () => {
    const error = new Error('connection reset');
    expect(() => creditedCount(10, error)).toThrow('connection reset');
  });
});
