/**
 * Guards the removal of the dead scheduled-job paths.
 *
 * REPORT_GENERATION and FI_DETECTION called fiDetectionService.searchProjects and
 * fiDetectionService.detectFIRequests, neither of which exists on that service, so both
 * threw on every run. executeReportGeneration additionally re-required fiDetectionService
 * inside its own body, shadowing the module import - the first reference hit the temporal
 * dead zone and threw a ReferenceError before it could reach the missing method.
 *
 * These tests exist so a bad merge that restores those methods fails loudly rather than
 * quietly reinstating a code path that has never worked.
 */

const scheduledJobManager = require('../scheduledJobManager');
const ScheduledJob = require('../../models/ScheduledJob');

describe('removed job-type handlers', () => {
  test.each(['executeReportGeneration', 'executeFIDetection', 'createPreprocessSchedule'])(
    '%s is gone from the manager',
    (methodName) => {
      expect(scheduledJobManager[methodName]).toBeUndefined();
    }
  );

  test('executeEmailBatch is still present', () => {
    expect(typeof scheduledJobManager.executeEmailBatch).toBe('function');
  });
});

describe('RETIRED_JOB_TYPES', () => {
  test('names every type the executor refuses', () => {
    expect(ScheduledJob.RETIRED_JOB_TYPES)
      .toEqual(['REPORT_GENERATION', 'FI_DETECTION', 'REGISTER_ACOUSTIC_SCAN']);
  });

  test('EMAIL_BATCH is not retired - it is the only working type', () => {
    expect(ScheduledJob.RETIRED_JOB_TYPES).not.toContain('EMAIL_BATCH');
  });

  test('retired values remain in the schema enum so existing rows stay saveable', () => {
    const enumValues = ScheduledJob.schema.path('jobType').enumValues;
    for (const type of ScheduledJob.RETIRED_JOB_TYPES) {
      expect(enumValues).toContain(type);
    }
  });
});

describe('executeJob dispatch', () => {
  let findByIdSpy;

  function fakeJob(jobType) {
    return {
      _id: 'abc123',
      jobId: 'JOB_TEST',
      jobType,
      schedule: { type: 'DAILY' },
      customers: [],
      execution: { runCount: 0, successCount: 0 },
      updateStatus: jest.fn().mockResolvedValue(undefined),
      calculateNextRun: jest.fn().mockResolvedValue(undefined)
    };
  }

  function stubFindById(job) {
    findByIdSpy = jest.spyOn(ScheduledJob, 'findById').mockReturnValue({
      populate: jest.fn().mockResolvedValue(job)
    });
  }

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test.each(ScheduledJob.RETIRED_JOB_TYPES)(
    'a %s job is marked FAILED with an explanatory message, not a ReferenceError',
    async (jobType) => {
      const job = fakeJob(jobType);
      stubFindById(job);

      await scheduledJobManager.executeJob(job._id);

      // executeJob catches and records rather than throwing, so assert on the recorded error.
      const failure = job.updateStatus.mock.calls.find(([status]) => status === 'FAILED');
      expect(failure).toBeDefined();
      expect(failure[1]).toBeInstanceOf(Error);
      expect(failure[1].message).toMatch(/Unsupported job type/);
      expect(failure[1].message).toContain(jobType);
      expect(failure[1]).not.toBeInstanceOf(ReferenceError);
      expect(findByIdSpy).toHaveBeenCalled();
    }
  );

  test('an EMAIL_BATCH job reaches executeEmailBatch', async () => {
    const job = fakeJob('EMAIL_BATCH');
    stubFindById(job);
    const batchSpy = jest.spyOn(scheduledJobManager, 'executeEmailBatch')
      .mockResolvedValue({ success: true, sentCount: 0, failedCount: 0 });

    await scheduledJobManager.executeJob(job._id);

    expect(batchSpy).toHaveBeenCalledWith(job);
    const failure = job.updateStatus.mock.calls.find(([status]) => status === 'FAILED');
    expect(failure).toBeUndefined();
  });
});
