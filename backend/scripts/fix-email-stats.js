const mongoose = require('mongoose');
const ScheduledJob = require('../models/ScheduledJob');

async function fixEmailStats() {
  try {
    console.log('Connecting to database...');
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/fi-email-automation');

    console.log('Finding jobs with missing or incorrect email stats...');

    // Find all jobs
    const jobs = await ScheduledJob.find({});
    console.log(`Found ${jobs.length} total jobs`);

    let updated = 0;

    for (const job of jobs) {
      let needsUpdate = false;

      // Initialize emailStats if missing
      if (!job.emailStats) {
        job.emailStats = {
          totalEmails: job.customers.length,
          sentEmails: 0,
          failedEmails: 0,
          bouncedEmails: 0
        };
        needsUpdate = true;
      }

      // Fix totalEmails if it's 0 or wrong
      if (!job.emailStats.totalEmails || job.emailStats.totalEmails !== job.customers.length) {
        job.emailStats.totalEmails = job.customers.length;
        needsUpdate = true;
      }

      // Recalculate sent/failed emails based on customer status
      const sentCount = job.customers.filter(c => c.sendStatus === 'SENT').length;
      const failedCount = job.customers.filter(c => c.sendStatus === 'FAILED').length;
      const skippedCount = job.customers.filter(c => c.sendStatus === 'SKIPPED').length;

      if (job.emailStats.sentEmails !== (sentCount + skippedCount)) {
        job.emailStats.sentEmails = sentCount + skippedCount; // Count skipped as sent for progress
        needsUpdate = true;
      }

      if (job.emailStats.failedEmails !== failedCount) {
        job.emailStats.failedEmails = failedCount;
        needsUpdate = true;
      }

      if (needsUpdate) {
        await job.save();
        updated++;
        console.log(`Updated job ${job.jobId}: ${job.emailStats.totalEmails} total, ${job.emailStats.sentEmails} sent, ${job.emailStats.failedEmails} failed`);
      }
    }

    console.log(`\nUpdate complete! ${updated} jobs were updated.`);

    // Test aggregation
    console.log('\nTesting aggregation...');
    const emailStats = await ScheduledJob.aggregate([
      {
        $group: {
          _id: null,
          totalEmailsSent: { $sum: '$emailStats.sentEmails' },
          totalEmailsFailed: { $sum: '$emailStats.failedEmails' },
          totalEmails: { $sum: '$emailStats.totalEmails' }
        }
      }
    ]);

    const fiMatchStats = await ScheduledJob.aggregate([
      {
        $match: {
          'cache.reportData.totalMatches': { $exists: true }
        }
      },
      {
        $group: {
          _id: null,
          totalFIMatches: { $sum: '$cache.reportData.totalMatches' },
          totalProcessedProjects: { $sum: '$cache.reportData.processedProjects' }
        }
      }
    ]);

    console.log('Aggregated Email Stats:', emailStats[0] || { none: 'No data' });
    console.log('Aggregated FI Stats:', fiMatchStats[0] || { none: 'No data' });

    await mongoose.disconnect();
    console.log('Database connection closed.');

  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  fixEmailStats();
}

module.exports = fixEmailStats;