/**
 * Deactivate scheduled jobs whose type was removed from the executor.
 *
 * REPORT_GENERATION and FI_DETECTION threw on every run (they called methods that do
 * not exist on fiDetectionService); REGISTER_ACOUSTIC_SCAN was never dispatched at all.
 * initializeScheduledJobs() now skips these types, so an active row just sits there
 * warning on every boot. This closes them out.
 *
 * Rows are not deleted - their execution history is the record of what happened.
 *
 * Usage:
 *   node scripts/retire-dead-scheduled-jobs.js           # dry run (default)
 *   node scripts/retire-dead-scheduled-jobs.js --apply   # write
 */

require('dotenv').config();
const mongoose = require('mongoose');
const ScheduledJob = require('../models/ScheduledJob');

const APPLY = process.argv.includes('--apply');

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log(`✅ Connected to MongoDB (${APPLY ? 'APPLY' : 'DRY RUN'})\n`);

  const filter = {
    jobType: { $in: ScheduledJob.RETIRED_JOB_TYPES },
    isActive: true
  };

  const targets = await ScheduledJob.find(filter).select('jobId jobType status createdAt').lean();

  if (targets.length === 0) {
    console.log('Nothing to retire - no active jobs of a retired type.');
    await mongoose.disconnect();
    return;
  }

  console.log(`Found ${targets.length} active job(s) of a retired type:`);
  for (const job of targets) {
    console.log(`  ${job.jobId}  ${job.jobType}  status=${job.status}  created=${new Date(job.createdAt).toISOString().slice(0, 10)}`);
  }

  if (!APPLY) {
    console.log('\nDry run - nothing written. Re-run with --apply to deactivate.');
    await mongoose.disconnect();
    return;
  }

  // runValidators is off deliberately: these rows may predate later schema constraints
  // and we only want to flip three fields. cancelJob() uses the same convention.
  const result = await ScheduledJob.updateMany(
    filter,
    {
      $set: {
        isActive: false,
        status: 'CANCELLED',
        notes: `Retired ${new Date().toISOString().slice(0, 10)} - job type removed from the executor.`
      }
    },
    { runValidators: false }
  );

  console.log(`\n✅ Deactivated ${result.modifiedCount} job(s).`);
  await mongoose.disconnect();
}

main().catch(error => {
  console.error('❌ Error:', error);
  process.exit(1);
});
