/**
 * Which process in a PM2 cluster is allowed to register schedulers.
 *
 * ecosystem.config.js runs fi-email-backend with instances: 2 in cluster mode, and
 * server.js registers documentRegisterScheduler, scheduledJobManager and the daily-run
 * worker at boot - in both forks. Every cron therefore fired twice.
 *
 * This is the cheap first line of defence: only one fork registers the timers at all.
 * The Mongo lock in services/jobLock.js is the correctness mechanism behind it, and
 * covers the cases this cannot - a restart mid-run, two hosts, or a manual trigger
 * arriving on the non-primary fork through the load-balanced HTTP API.
 */

/**
 * True for the fork that should own scheduled work.
 *
 * PM2 sets NODE_APP_INSTANCE per cluster fork ('0' for the first). Processes started in
 * fork mode (worker.js, ingestion-worker.js) leave it unset, and are already instances: 1,
 * so an unset value must count as primary or they would stop scheduling entirely.
 *
 * SCHEDULERS_ENABLED=false opts a whole process out, for a box brought up purely to
 * serve the API.
 */
function isPrimaryInstance(env = process.env) {
  if (String(env.SCHEDULERS_ENABLED).toLowerCase() === 'false') return false;

  const instance = env.NODE_APP_INSTANCE;
  if (instance === undefined || instance === null || String(instance).trim() === '') {
    return true;
  }

  return String(instance).trim() === '0';
}

/**
 * Human-readable identity for log lines - "instance 1" reads better than a bare boolean
 * when you are working out why a scheduler did not start.
 */
function describeInstance(env = process.env) {
  const instance = env.NODE_APP_INSTANCE;
  const label = (instance === undefined || String(instance).trim() === '')
    ? 'single (fork mode)'
    : `cluster instance ${instance}`;
  return `${label}, pid ${process.pid}`;
}

module.exports = { isPrimaryInstance, describeInstance };
