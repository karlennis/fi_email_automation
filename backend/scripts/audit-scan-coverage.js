/**
 * Read-only day-by-day scan coverage report per job.
 *
 * The scan window is hardcoded to one day and, before the backfill work, there was no
 * gap detection: a scan that overran 24h meant the following day was never enqueued and
 * those documents were never examined. Production covered 130 of 132 days plus 5 days
 * that processed zero documents (a resume that never re-found its checkpoint marker
 * skips everything and still writes a result).
 *
 * Run this BEFORE setting SCAN_BACKFILL_ENABLED=true to see how much work backfill will
 * pick up, and to check how many undelivered rows the widened delivery window would
 * sweep into the first send.
 *
 * Usage:
 *   node scripts/audit-scan-coverage.js                 # last 30 days, all jobs
 *   node scripts/audit-scan-coverage.js --days 90
 *   node scripts/audit-scan-coverage.js --job SCAN-ACOUSTIC-1775066009779
 */

require('dotenv').config();
const mongoose = require('mongoose');
const ScanJob = require('../models/ScanJob');
const ScanJobDailyResult = require('../models/ScanJobDailyResult');

const daysArg = process.argv.indexOf('--days');
const DAYS = daysArg !== -1 ? parseInt(process.argv[daysArg + 1], 10) : 30;
const jobArg = process.argv.indexOf('--job');
const ONLY_JOB = jobArg !== -1 ? process.argv[jobArg + 1] : null;

const HORIZON = parseInt(process.env.SCAN_BACKFILL_HORIZON_DAYS || '14', 10);
const MAX_EMPTY_ATTEMPTS = 2;

/** Local-parts day key, matching how saveDailyScanResult normalises scanDate. */
function dateKey(date) {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log(`✅ Connected to MongoDB — last ${DAYS} days\n`);

  const jobFilter = ONLY_JOB ? { jobId: ONLY_JOB } : {};
  const jobs = await ScanJob.find(jobFilter).select('jobId name status schedule').lean();

  if (jobs.length === 0) {
    console.log('No scan jobs found.');
    await mongoose.disconnect();
    return;
  }

  const windowEnd = new Date();
  windowEnd.setDate(windowEnd.getDate() - 1);   // today is still accumulating
  windowEnd.setHours(0, 0, 0, 0);
  const windowStart = new Date(windowEnd);
  windowStart.setDate(windowStart.getDate() - DAYS + 1);
  windowStart.setHours(0, 0, 0, 0);

  for (const job of jobs) {
    const rows = await ScanJobDailyResult.find({
      jobId: job.jobId,
      scanDate: { $gte: windowStart, $lte: windowEnd }
    }).select('scanDate processedCount matches delivered scanAttempts').lean();

    const byDate = new Map(rows.map(r => [dateKey(r.scanDate), r]));

    console.log('='.repeat(78));
    console.log(`${job.jobId}  (${job.name || 'unnamed'})  status=${job.status}`);
    console.log('='.repeat(78));

    let ok = 0, zero = 0, missing = 0, matchTotal = 0;
    const gaps = [];

    for (let day = new Date(windowStart); day <= windowEnd; day.setDate(day.getDate() + 1)) {
      const key = dateKey(day);
      const row = byDate.get(key);

      if (!row) {
        missing++;
        gaps.push(key);
        console.log(`  ${key}  GAP      (no result row)`);
      } else if ((row.processedCount || 0) === 0) {
        zero++;
        const abandoned = (row.scanAttempts || 0) >= MAX_EMPTY_ATTEMPTS;
        if (!abandoned) gaps.push(key);
        console.log(`  ${key}  ZERO     0 processed, ${row.scanAttempts || 0} attempt(s)${abandoned ? ' — accepted as empty' : ' — will backfill'}`);
      } else {
        ok++;
        matchTotal += (row.matches || []).length;
        console.log(
          `  ${key}  OK       ${String(row.processedCount).padStart(7)} processed, ` +
          `${String((row.matches || []).length).padStart(3)} match(es)` +
          `${row.delivered ? '' : '  [UNDELIVERED]'}`
        );
      }
    }

    // Only gaps inside the backfill horizon can actually be picked up.
    const horizonFloor = new Date(windowEnd);
    horizonFloor.setDate(horizonFloor.getDate() - HORIZON + 1);
    const actionable = gaps.filter(key => new Date(key) >= horizonFloor);

    const undelivered = rows.filter(r => !r.delivered && (r.matches || []).length > 0);

    console.log(`\n  ${ok} covered, ${zero} zero-processed, ${missing} missing — ${matchTotal} matches total`);
    console.log(`  ${gaps.length} gap(s) in this report; ${actionable.length} inside the ${HORIZON}-day backfill horizon`);
    if (actionable.length) {
      console.log(`  backfill order (oldest first): ${actionable.slice(0, 10).join(', ')}${actionable.length > 10 ? ` … +${actionable.length - 10}` : ''}`);
      console.log(`  at 1/night that is ${actionable.length} night(s) — raise SCAN_BACKFILL_MAX_DAYS_PER_NIGHT to go faster`);
    }

    // The widened delivery window sweeps up undelivered days below the normal lookback.
    // If this number is large, backdate delivered:true on the old ones before enabling,
    // or the first send dumps weeks of stale leads on customers.
    console.log(`  ⚠️ ${undelivered.length} row(s) with matches are NOT delivered — these would be swept into the next send`);
    if (undelivered.length) {
      console.log(`     oldest: ${dateKey(undelivered[0].scanDate)}, total matches: ${undelivered.reduce((n, r) => n + (r.matches || []).length, 0)}`);
    }
    console.log();
  }

  await mongoose.disconnect();
}

main().catch(error => {
  console.error('❌ Error:', error);
  process.exit(1);
});
