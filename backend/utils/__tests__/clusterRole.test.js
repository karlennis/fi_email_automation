/**
 * Tests for backend/utils/clusterRole.js
 *
 * fi-email-backend runs instances: 2 in PM2 cluster mode and server.js registered every
 * scheduler at boot, so each cron fired twice. This decides which fork owns them.
 *
 * The subtle case is the unset value: worker.js and ingestion-worker.js run in fork mode
 * and never see NODE_APP_INSTANCE. If unset did not count as primary they would stop
 * scheduling entirely - the FI scan and the ingestion routing would simply never run.
 */

const { isPrimaryInstance, describeInstance } = require('../clusterRole');

describe('isPrimaryInstance', () => {
  test('cluster instance 0 is primary', () => {
    expect(isPrimaryInstance({ NODE_APP_INSTANCE: '0' })).toBe(true);
  });

  test.each(['1', '2', '15'])('cluster instance %s is not primary', (instance) => {
    expect(isPrimaryInstance({ NODE_APP_INSTANCE: instance })).toBe(false);
  });

  test('unset counts as primary so fork-mode workers still schedule', () => {
    expect(isPrimaryInstance({})).toBe(true);
    expect(isPrimaryInstance({ NODE_APP_INSTANCE: undefined })).toBe(true);
    expect(isPrimaryInstance({ NODE_APP_INSTANCE: '' })).toBe(true);
    expect(isPrimaryInstance({ NODE_APP_INSTANCE: '  ' })).toBe(true);
  });

  test('tolerates a numeric value, which PM2 may supply unquoted', () => {
    expect(isPrimaryInstance({ NODE_APP_INSTANCE: 0 })).toBe(true);
    expect(isPrimaryInstance({ NODE_APP_INSTANCE: 1 })).toBe(false);
  });

  test('SCHEDULERS_ENABLED=false opts the whole process out, even instance 0', () => {
    expect(isPrimaryInstance({ NODE_APP_INSTANCE: '0', SCHEDULERS_ENABLED: 'false' })).toBe(false);
    expect(isPrimaryInstance({ SCHEDULERS_ENABLED: 'false' })).toBe(false);
    expect(isPrimaryInstance({ SCHEDULERS_ENABLED: 'FALSE' })).toBe(false);
  });

  test('SCHEDULERS_ENABLED=true (or absent) leaves the instance check in charge', () => {
    expect(isPrimaryInstance({ NODE_APP_INSTANCE: '0', SCHEDULERS_ENABLED: 'true' })).toBe(true);
    expect(isPrimaryInstance({ NODE_APP_INSTANCE: '1', SCHEDULERS_ENABLED: 'true' })).toBe(false);
  });
});

describe('describeInstance', () => {
  test('names the cluster fork', () => {
    expect(describeInstance({ NODE_APP_INSTANCE: '1' })).toContain('cluster instance 1');
  });

  test('says fork mode when unset', () => {
    expect(describeInstance({})).toContain('single (fork mode)');
  });

  test('includes the pid so two forks are distinguishable in the log', () => {
    expect(describeInstance({})).toContain(String(process.pid));
  });
});
