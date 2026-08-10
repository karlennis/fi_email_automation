/**
 * Read-only audit of the scheduled_jobs collection.
 *
 * REPORT_GENERATION and FI_DETECTION were removed from scheduledJobManager because
 * they called methods that do not exist and threw on every run. This reports how many
 * rows carry a retired type, and - for the EMAIL_BATCH rows that remain - whether they
 * hold the pre-generated cache that executeEmailBatch now strictly requires.
 *
 * Usage: node scripts/audit-scheduled-jobs.js
 */

require('dotenv').config();
const mongoose = require('mongoose');
const ScheduledJob = require('../models/ScheduledJob');

function pad(value, width) {
  return String(value).padEnd(width);
}

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('✅ Connected to MongoDB\n');

  const byType = await ScheduledJob.aggregate([
    {
      $group: {
        _id: { jobType: '$jobType', status: '$status', isActive: '$isActive' },
        count: { $sum: 1 }
      }
    },
    { $sort: { '_id.jobType': 1, '_id.status': 1 } }
  ]);

  console.log('=== Jobs by type / status / isActive ===');
  console.log(`${pad('jobType', 26)}${pad('status', 14)}${pad('active', 8)}count`);
  for (const row of byType) {
    const retired = ScheduledJob.RETIRED_JOB_TYPES.includes(row._id.jobType) ? '  <-- RETIRED' : '';
    console.log(
      pad(row._id.jobType, 26) +
      pad(row._id.status, 14) +
      pad(row._id.isActive, 8) +
      row.count + retired
    );
  }

  const retiredActive = await ScheduledJob.countDocuments({
    jobType: { $in: ScheduledJob.RETIRED_JOB_TYPES },
    isActive: true
  });
  const retiredTotal = await ScheduledJob.countDocuments({
    jobType: { $in: ScheduledJob.RETIRED_JOB_TYPES }
  });

  console.log(`\n=== Retired types (${ScheduledJob.RETIRED_JOB_TYPES.join(', ')}) ===`);
  console.log(`  total rows : ${retiredTotal}`);
  console.log(`  still active: ${retiredActive}`);
  if (retiredActive > 0) {
    console.log('  -> node scripts/retire-dead-scheduled-jobs.js          (dry run)');
    console.log('  -> node scripts/retire-dead-scheduled-jobs.js --apply  (deactivate)');
  }

  // executeEmailBatch no longer falls back to on-demand generation, so a row without a
  // usable cache will now fail loudly where it previously failed with a ReferenceError.
  const emailBatch = await ScheduledJob.find({ jobType: 'EMAIL_BATCH', isActive: true })
    .select('jobId status cache.generatedAt cache.reportData.customerMatches createdAt')
    .lean();

  let withCache = 0;
  const stale = [];
  for (const job of emailBatch) {
    const matches = job.cache?.reportData?.customerMatches;
    const generatedAt = job.cache?.generatedAt;
    if (!Array.isArray(matches) || !generatedAt) continue;
    withCache++;
    const ageHours = (Date.now() - new Date(generatedAt).getTime()) / 36e5;
    const forThisJob = job.createdAt && new Date(generatedAt) >= new Date(job.createdAt);
    if (ageHours >= 24 || !forThisJob) {
      stale.push({ jobId: job.jobId, ageHours: ageHours.toFixed(1), forThisJob });
    }
  }

  console.log('\n=== Active EMAIL_BATCH cache readiness ===');
  console.log(`  active rows      : ${emailBatch.length}`);
  console.log(`  with a cache     : ${withCache}`);
  console.log(`  cache unusable   : ${emailBatch.length - withCache + stale.length}`);
  for (const row of stale) {
    console.log(`    ${row.jobId}: ${row.ageHours}h old, generated for this job: ${row.forThisJob}`);
  }
  console.log('  (unusable caches now raise "No valid pre-generated report cache"');
  console.log('   instead of the old ReferenceError - the outcome is unchanged.)');

  await mongoose.disconnect();
}

main().catch(error => {
  console.error('❌ Error:', error);
  process.exit(1);
});
