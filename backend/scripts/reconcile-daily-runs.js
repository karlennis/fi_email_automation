/**
 * Rebuild DailyRun counters from DailyRunItem, and complete runs that are done.
 *
 * The scan used to increment counters.totalItems and counters.queued by the full batch
 * length even when insertMany rejected duplicates, so counters.queued overshot by the
 * duplicate count and could never drain to 0. checkRunCompletion waits for
 * queued === 0 && processing === 0, so those runs sit in 'processing' forever.
 *
 * The insert path is fixed going forward; this repairs the runs already drifted.
 *
 * Usage:
 *   node scripts/reconcile-daily-runs.js               # dry run, all non-terminal runs
 *   node scripts/reconcile-daily-runs.js --apply       # write
 *   node scripts/reconcile-daily-runs.js --all         # include completed/error runs
 *   node scripts/reconcile-daily-runs.js --run RUN_x   # one run
 */

require('dotenv').config();
const mongoose = require('mongoose');
const DailyRun = require('../models/DailyRun');
const DailyRunItem = require('../models/DailyRunItem');
const dailyRunService = require('../services/dailyRunService');

const APPLY = process.argv.includes('--apply');
const ALL = process.argv.includes('--all');
const runArgIndex = process.argv.indexOf('--run');
const SINGLE_RUN = runArgIndex !== -1 ? process.argv[runArgIndex + 1] : null;

async function actualCounters(runId) {
  const grouped = await DailyRunItem.aggregate([
    { $match: { runId } },
    { $group: { _id: '$status', n: { $sum: 1 } } }
  ]);

  const actual = { totalItems: 0, queued: 0, processing: 0, completed: 0, failed: 0 };
  for (const row of grouped) {
    actual.totalItems += row.n;
    if (Object.prototype.hasOwnProperty.call(actual, row._id)) actual[row._id] = row.n;
  }
  return actual;
}

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log(`✅ Connected to MongoDB (${APPLY ? 'APPLY' : 'DRY RUN'})\n`);

  const filter = SINGLE_RUN
    ? { runId: SINGLE_RUN }
    : (ALL ? {} : { status: { $in: ['queued', 'scanning', 'processing'] } });

  const runs = await DailyRun.find(filter).sort({ createdAt: -1 }).lean();
  console.log(`Examining ${runs.length} run(s)\n`);

  let drifted = 0;
  let completable = 0;

  for (const run of runs) {
    const actual = await actualCounters(run.runId);
    const stored = {
      totalItems: run.counters?.totalItems || 0,
      queued: run.counters?.queued || 0,
      processing: run.counters?.processing || 0,
      completed: run.counters?.completed || 0,
      failed: run.counters?.failed || 0
    };

    const keys = Object.keys(actual);
    const isDrifted = keys.some(key => actual[key] !== stored[key]);
    const outstanding = actual.queued + actual.processing;
    const wouldComplete = outstanding === 0 && ['scanning', 'processing'].includes(run.status);

    if (!isDrifted && !wouldComplete) continue;

    if (isDrifted) drifted++;
    if (wouldComplete) completable++;

    console.log(`${run.runId}  status=${run.status}  target=${new Date(run.targetDate).toISOString().slice(0, 10)}`);
    for (const key of keys) {
      if (actual[key] !== stored[key]) {
        console.log(`    ${key.padEnd(11)} stored ${String(stored[key]).padStart(7)} -> actual ${String(actual[key]).padStart(7)}`);
      }
    }
    if (wouldComplete) console.log('    -> would be marked completed (no outstanding items)');

    if (APPLY) {
      await dailyRunService.reconcileCounters(run.runId);
    }
  }

  console.log(`\n${drifted} run(s) with drifted counters, ${completable} that can be completed.`);
  if (!APPLY && (drifted || completable)) {
    console.log('Dry run - nothing written. Re-run with --apply.');
  }

  await mongoose.disconnect();
}

main().catch(error => {
  console.error('❌ Error:', error);
  process.exit(1);
});
