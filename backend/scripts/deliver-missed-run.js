/**
 * Deliver a scan job's accumulated results immediately (catch-up for a missed delivery day).
 *
 * Usage (run with PRODUCTION env: MONGODB_URI, SMTP_*, BUILDING_INFO_API_*, AWS_*):
 *   node scripts/deliver-missed-run.js [jobId] [--lookback N] [--anchor YYYY-MM-DD] [--send]
 *
 * Defaults:
 *   jobId    = SCAN-ACOUSTIC-1775066009779
 *   anchor   = most recent stored daily-result date for the job
 *   lookback = the job's configured schedule.lookbackDays
 *   (omit --send for a DRY RUN that only reports what would be delivered)
 */
require('dotenv').config();
const mongoose = require('mongoose');
const ScanJob = require('../models/ScanJob');
const ScanJobDailyResult = require('../models/ScanJobDailyResult');
require('../models/Customer'); // register for populate
const scanJobProcessor = require('../services/scanJobProcessor');

function getArg(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : null;
}

const JOB_ID = process.argv[2] && !process.argv[2].startsWith('--')
  ? process.argv[2]
  : 'SCAN-ACOUSTIC-1775066009779';
const SEND = process.argv.includes('--send');
const lookbackArg = getArg('--lookback');
const anchorArg = getArg('--anchor');

async function run() {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/fi-email-automation');

  const job = await ScanJob.findOne({ jobId: JOB_ID })
    .populate('customers.customerId', 'email company name projectId filters');
  if (!job) {
    console.error('❌ Job not found:', JOB_ID);
    process.exit(1);
  }

  // Anchor = most recent stored daily-result day (the latest fully scanned day)
  let anchor;
  if (anchorArg) {
    anchor = new Date(anchorArg);
  } else {
    const latest = await ScanJobDailyResult.findOne({ jobId: JOB_ID }).sort({ scanDate: -1 });
    if (!latest) {
      console.error('❌ No stored daily results for', JOB_ID, '- nothing to deliver.');
      process.exit(1);
    }
    anchor = new Date(latest.scanDate);
  }
  anchor.setHours(0, 0, 0, 0);

  const lookback = lookbackArg ? parseInt(lookbackArg, 10) : (job.schedule?.lookbackDays || 1);

  // Compute the same window deliverResultsForJob will use
  const windowEnd = new Date(anchor); windowEnd.setHours(23, 59, 59, 999);
  const windowStart = new Date(anchor); windowStart.setDate(windowStart.getDate() - lookback + 1); windowStart.setHours(0, 0, 0, 0);

  const dailyResults = await ScanJobDailyResult.find({
    jobId: JOB_ID,
    scanDate: { $gte: windowStart, $lte: windowEnd }
  });

  const seen = new Set();
  let totalMatches = 0;
  for (const d of dailyResults) {
    for (const m of (d.matches || [])) {
      const key = `${m.projectId}::${m.fileName}`;
      if (!seen.has(key)) { seen.add(key); totalMatches++; }
    }
  }

  const recipients = (job.customers || [])
    .map(c => c.customerId?.email)
    .filter(Boolean);

  console.log('────────────────────────────────────────────');
  console.log(`Job:        ${job.name} (${JOB_ID})`);
  console.log(`Schedule:   ${job.schedule?.type || 'DAILY'}, lookback ${lookback}d`);
  console.log(`Window:     ${windowStart.toISOString().split('T')[0]} → ${windowEnd.toISOString().split('T')[0]}`);
  console.log(`Daily recs: ${dailyResults.length}`);
  console.log(`Matches:    ${totalMatches} (deduped)`);
  console.log(`Recipients: ${recipients.length} → ${recipients.join(', ') || '(none)'}`);
  console.log(`Last sent:  ${job.deliveryState?.sentForDate || 'never'}`);
  console.log('────────────────────────────────────────────');

  if (!SEND) {
    console.log('🟡 DRY RUN — no emails sent. Re-run with --send to deliver.');
    await mongoose.disconnect();
    process.exit(0);
  }

  // Apply the chosen lookback in-memory only (do NOT persist a schedule change)
  if (job.schedule) job.schedule.lookbackDays = lookback;

  console.log('📮 Delivering now…');
  await scanJobProcessor.deliverResultsForJob(job, anchor);

  // Mark delivered so the catch-up logic / scheduler won't re-send this period
  const today = new Date().toISOString().split('T')[0];
  await ScanJob.updateOne(
    { jobId: JOB_ID },
    {
      $set: {
        'deliveryState.pendingForDate': null,
        'deliveryState.pendingAnchorDate': null,
        'deliveryState.sentForDate': today,
        'deliveryState.sentAt': new Date(),
        'deliveryState.lastAttemptAt': new Date()
      }
    }
  );

  console.log(`✅ Delivery complete. deliveryState.sentForDate set to ${today}.`);
  await mongoose.disconnect();
  process.exit(0);
}

run().catch(err => {
  console.error('❌ Delivery failed:', err);
  process.exit(1);
});
