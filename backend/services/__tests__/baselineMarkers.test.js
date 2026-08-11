/**
 * Tests for baseline marker safety (audit item 16).
 *
 * Baseline markers exclude a newly-ingested project from FI scanning so its historical
 * back-catalogue is not sold as fresh leads. They gate 60% of all documents encountered,
 * so both directions of failure are expensive:
 *
 *   - a missing marker means a brand-new project's entire back-catalogue is emailed to
 *     customers as new FI requests;
 *   - a marker that outlives its purpose keeps a project excluded indefinitely (13,239
 *     stale markers accumulated before anyone noticed).
 *
 * The existing cleanup suite covers deletion. This covers the check, the retention
 * window, and the ingestion ordering.
 */

const s3Service = require('../s3Service');
const documentIngestionService = require('../documentIngestionService');

const NOW = new Date('2026-08-11T09:00:00.000Z');

function notFoundError() {
  const error = new Error('Not Found');
  error.code = 'NotFound';
  error.statusCode = 404;
  return error;
}

beforeEach(() => {
  jest.useFakeTimers().setSystemTime(NOW);
  s3Service.resetBaselineCheckErrorCount();
  delete process.env.BASELINE_MARKER_RETENTION_DAYS;
});

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
  delete process.env.BASELINE_MARKER_RETENTION_DAYS;
});

describe('objectExists', () => {
  test('treats a bare 404 statusCode as not-found', async () => {
    // headObject has no response body, so the SDK cannot always map the status to a
    // code. Treating a statusCode-only 404 as an error made every missing object look
    // like an S3 outage to the caller.
    const error = new Error('Not Found');
    error.statusCode = 404;
    jest.spyOn(s3Service.s3, 'headObject').mockReturnValue({ promise: () => Promise.reject(error) });

    await expect(s3Service.objectExists('planning-docs/1/x')).resolves.toBe(false);
  });

  test('still throws on a genuine failure', async () => {
    const error = new Error('Access Denied');
    error.statusCode = 403;
    jest.spyOn(s3Service.s3, 'headObject').mockReturnValue({ promise: () => Promise.reject(error) });

    await expect(s3Service.objectExists('planning-docs/1/x')).rejects.toThrow('Access Denied');
  });
});

describe('hasBaselineMarker', () => {
  test('finds a marker written today', async () => {
    const spy = jest.spyOn(s3Service, 'objectExists').mockResolvedValue(true);

    await expect(s3Service.hasBaselineMarker('123')).resolves.toBe(true);
    expect(spy.mock.calls[0][0]).toBe('planning-docs/123/_baseline_2026-08-11');
  });

  test('finds yesterday\'s marker - routing runs at 11PM, the scan at 12:10AM', async () => {
    jest.spyOn(s3Service, 'objectExists').mockImplementation(async (key) =>
      key.endsWith('_baseline_2026-08-10')
    );

    await expect(s3Service.hasBaselineMarker('123')).resolves.toBe(true);
  });

  test('returns false when no marker exists in the window', async () => {
    jest.spyOn(s3Service, 'objectExists').mockResolvedValue(false);

    await expect(s3Service.hasBaselineMarker('123')).resolves.toBe(false);
  });

  test('FAILS CLOSED - an S3 error reports baselined, not un-baselined', async () => {
    // Returning false here reads as "scan this project", which for a brand-new project
    // means emailing customers its entire historical back-catalogue. Being wrong the
    // other way costs one project one day of leads.
    jest.spyOn(s3Service, 'objectExists').mockRejectedValue(new Error('S3 unavailable'));

    await expect(s3Service.hasBaselineMarker('123')).resolves.toBe(true);
  });

  test('counts failed checks so a bulk failure is visible', async () => {
    // Failing closed per-project is right, but a 403 on the whole prefix would make
    // every project look baselined and the night would scan nothing, silently.
    jest.spyOn(s3Service, 'objectExists').mockRejectedValue(new Error('S3 unavailable'));

    await s3Service.hasBaselineMarker('1');
    await s3Service.hasBaselineMarker('2');

    expect(s3Service.getBaselineCheckErrorCount()).toBe(2);
    s3Service.resetBaselineCheckErrorCount();
    expect(s3Service.getBaselineCheckErrorCount()).toBe(0);
  });

  test('a clean not-found does not count as an error', async () => {
    jest.spyOn(s3Service.s3, 'headObject').mockReturnValue({ promise: () => Promise.reject(notFoundError()) });

    await expect(s3Service.hasBaselineMarker('123')).resolves.toBe(false);
    expect(s3Service.getBaselineCheckErrorCount()).toBe(0);
  });

  test('looks back over the configured retention window', async () => {
    process.env.BASELINE_MARKER_RETENTION_DAYS = '4';
    const spy = jest.spyOn(s3Service, 'objectExists').mockResolvedValue(false);

    await s3Service.hasBaselineMarker('123');

    expect(spy).toHaveBeenCalledTimes(4);
    expect(spy.mock.calls.map(c => c[0].split('_baseline_')[1]))
      .toEqual(['2026-08-11', '2026-08-10', '2026-08-09', '2026-08-08']);
  });

  test('never looks back less than two days, whatever the env says', async () => {
    // The 11PM routing → 12:10AM scan edge means today alone is not enough: a marker
    // written before midnight must still be found after it.
    process.env.BASELINE_MARKER_RETENTION_DAYS = '1';
    const spy = jest.spyOn(s3Service, 'objectExists').mockResolvedValue(false);

    await s3Service.hasBaselineMarker('123');

    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe('cleanup retention agrees with the check', () => {
  test('cleanupOldBaselineMarkers defaults to the same window hasBaselineMarker reads', async () => {
    // These were expressed independently - the function defaulted to 1 day while the
    // check read today+yesterday, so a marker could be deleted while still load-bearing.
    const deleted = [];
    jest.spyOn(s3Service, 'deleteDocuments').mockImplementation(async (keys) => {
      deleted.push(...keys);
      return { deleted: keys.length };
    });
    jest.spyOn(s3Service.s3, 'listObjectsV2').mockReturnValue({
      promise: () => Promise.resolve({
        Contents: [
          { Key: 'planning-docs/1/_baseline_2026-08-11' },  // today
          { Key: 'planning-docs/2/_baseline_2026-08-10' },  // yesterday - still needed
          { Key: 'planning-docs/3/_baseline_2026-08-05' }   // stale
        ],
        IsTruncated: false
      })
    });

    const result = await s3Service.cleanupOldBaselineMarkers();

    expect(deleted).toEqual(['planning-docs/3/_baseline_2026-08-05']);
    expect(result.deleted).toBe(1);
  });
});

describe('routeToPlanning ordering for a new project', () => {
  const calls = [];

  function stubIngestion({ markerThrows = false } = {}) {
    calls.length = 0;

    jest.spyOn(s3Service, 'createBaselineMarker').mockImplementation(async () => {
      calls.push('marker');
      if (markerThrows) throw new Error('putObject denied');
      return {};
    });
    jest.spyOn(s3Service, 'copyDocument').mockImplementation(async () => {
      calls.push('copy');
    });
    jest.spyOn(s3Service, 'listPlanningDocsProject').mockResolvedValue([]);
    jest.spyOn(s3Service, 'listFilterDocsProject').mockResolvedValue([
      { key: 'filter-docs/500/a.pdf', fileName: 'a.pdf', size: 10, etag: 'aaa' },
      { key: 'filter-docs/500/b.pdf', fileName: 'b.pdf', size: 20, etag: 'bbb' }
    ]);
  }

  test('creates the baseline marker BEFORE copying any document', async () => {
    // The other order left a window - the whole parallel copy - in which a crash left a
    // fully populated new project with no marker. The next scan then treated its entire
    // back-catalogue as fresh uploads and emailed every FI request in it.
    stubIngestion();

    const result = await documentIngestionService.routeToPlanning('500');

    expect(result.isNewProject).toBe(true);
    expect(result.isBaselined).toBe(true);
    expect(calls[0]).toBe('marker');
    expect(calls.filter(c => c === 'copy')).toHaveLength(2);
  });

  test('copies nothing when the marker cannot be written', async () => {
    // Copying unbaselined is precisely the failure the ordering exists to prevent, so
    // the project is abandoned for this run instead.
    stubIngestion({ markerThrows: true });

    const result = await documentIngestionService.routeToPlanning('500');

    expect(calls).toEqual(['marker']);
    expect(result.isBaselined).toBe(false);
    expect(result.documentsCopied).toBe(0);
    expect(result.errors.some(e => e.fileName === '_baseline_')).toBe(true);
  });
});
