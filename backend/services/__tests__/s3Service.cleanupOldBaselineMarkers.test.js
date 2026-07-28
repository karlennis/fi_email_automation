/**
 * Tests for s3Service.cleanupOldBaselineMarkers()
 *
 * Regression cover for the failure that left 13,239 stale markers in planning-docs:
 * the old implementation collected every key across a multi-million-object listing
 * and deleted once at the very end, so any crash or restart part-way through the
 * scan deleted nothing at all — silently, every night.
 */

const s3Service = require('../s3Service');

// Freeze "now" so cutoff dates are deterministic
const NOW = new Date('2026-07-28T00:05:00.000Z');

/**
 * Build a fake listObjectsV2 that pages `keys` out 1000 at a time,
 * optionally throwing once it has served `failAfterPages` pages.
 */
function fakeListing(keys, { failAfterPages = null } = {}) {
  let page = 0;
  return jest.fn(() => {
    if (failAfterPages !== null && page >= failAfterPages) {
      return { promise: () => Promise.reject(new Error('simulated mid-scan S3 failure')) };
    }
    const start = page * 1000;
    const slice = keys.slice(start, start + 1000);
    page++;
    const isTruncated = start + 1000 < keys.length;
    return {
      promise: () => Promise.resolve({
        Contents: slice.map(Key => ({ Key })),
        IsTruncated: isTruncated,
        NextContinuationToken: isTruncated ? `token-${page}` : undefined
      })
    };
  });
}

function markerKey(projectId, date) {
  return `planning-docs/${projectId}/_baseline_${date}`;
}

describe('cleanupOldBaselineMarkers', () => {
  let deleteSpy;
  let deletedBatchSizes;

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW);
    deletedBatchSizes = [];
    deleteSpy = jest.spyOn(s3Service, 'deleteDocuments').mockImplementation(async (keys) => {
      deletedBatchSizes.push(keys.length);
      return { deleted: keys.length };
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  test('deletes only markers older than the cutoff, leaving recent markers and real documents', async () => {
    const keys = [
      markerKey('100', '2026-06-20'),          // stale
      markerKey('101', '2026-07-17'),          // stale
      markerKey('102', '2026-07-25'),          // stale (cutoff is 2026-07-26)
      markerKey('103', '2026-07-26'),          // within retention - keep
      markerKey('104', '2026-07-27'),          // within retention - keep
      'planning-docs/105/report.pdf',          // real document - never touch
      'planning-docs/106/docfiles.txt'         // metadata - never touch
    ];

    s3Service.s3.listObjectsV2 = fakeListing(keys);

    const result = await s3Service.cleanupOldBaselineMarkers(2);

    expect(result.cutoffDate).toBe('2026-07-26');
    expect(result.deleted).toBe(3);
    expect(result.failed).toBe(0);
    expect(result.objectsScanned).toBe(7);

    const deletedKeys = deleteSpy.mock.calls.flatMap(call => call[0]);
    expect(deletedKeys.sort()).toEqual([
      markerKey('100', '2026-06-20'),
      markerKey('101', '2026-07-17'),
      markerKey('102', '2026-07-25')
    ].sort());
  });

  test('flushes in batches of at most 1000 while paging, never accumulating everything', async () => {
    // 2,500 stale markers spread across 3 listing pages
    const keys = Array.from({ length: 2500 }, (_, i) => markerKey(1000 + i, '2026-06-20'));
    s3Service.s3.listObjectsV2 = fakeListing(keys);

    const result = await s3Service.cleanupOldBaselineMarkers(2);

    expect(result.deleted).toBe(2500);
    // S3 DeleteObjects hard limit - no batch may exceed it
    expect(Math.max(...deletedBatchSizes)).toBeLessThanOrEqual(1000);
    // Full batches flushed during paging, remainder flushed at the end
    expect(deletedBatchSizes).toEqual([1000, 1000, 500]);
  });

  test('keeps deletions already flushed when the listing fails mid-scan', async () => {
    // 3,000 stale markers, but S3 dies after serving 2 pages
    const keys = Array.from({ length: 3000 }, (_, i) => markerKey(2000 + i, '2026-06-20'));
    s3Service.s3.listObjectsV2 = fakeListing(keys, { failAfterPages: 2 });

    await expect(s3Service.cleanupOldBaselineMarkers(2)).rejects.toThrow('simulated mid-scan S3 failure');

    // The old implementation would have deleted 0 here. Work already done must survive.
    const deletedKeys = deleteSpy.mock.calls.flatMap(call => call[0]);
    expect(deletedKeys.length).toBe(2000);
    expect(deletedBatchSizes).toEqual([1000, 1000]);
  });

  test('continues past a failing delete batch instead of abandoning the run', async () => {
    const keys = Array.from({ length: 2000 }, (_, i) => markerKey(3000 + i, '2026-06-20'));
    s3Service.s3.listObjectsV2 = fakeListing(keys);

    deleteSpy.mockReset();
    let call = 0;
    deleteSpy.mockImplementation(async (batch) => {
      call++;
      if (call === 1) throw new Error('AccessDenied on first batch');
      return { deleted: batch.length };
    });

    const result = await s3Service.cleanupOldBaselineMarkers(2);

    expect(result.failed).toBe(1000);   // first batch failed
    expect(result.deleted).toBe(1000);  // second batch still went through
    expect(deleteSpy).toHaveBeenCalledTimes(2);
  });

  test('reports nothing to do when no markers are stale', async () => {
    const keys = [
      markerKey('200', '2026-07-27'),
      'planning-docs/201/report.pdf'
    ];
    s3Service.s3.listObjectsV2 = fakeListing(keys);

    const result = await s3Service.cleanupOldBaselineMarkers(2);

    expect(result.deleted).toBe(0);
    expect(result.failed).toBe(0);
    expect(deleteSpy).not.toHaveBeenCalled();
  });
});
