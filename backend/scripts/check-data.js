const mongoose = require('mongoose');
const ScheduledJob = require('../models/ScheduledJob');

async function checkData() {
  try {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/fi-email-automation');

    console.log('=== SCHEDULED JOBS DATABASE CHECK ===\n');

    const totalJobs = await ScheduledJob.countDocuments();
    console.log(`Total jobs in database: ${totalJobs}`);

    if (totalJobs === 0) {
      console.log('No jobs found in database. Dashboard will show 0 for all stats.');
      await mongoose.disconnect();
      return;
    }

    // Check email stats structure
    const jobsWithEmailStats = await ScheduledJob.countDocuments({ 'emailStats.totalEmails': { $exists: true } });
    const jobsWithZeroTotalEmails = await ScheduledJob.countDocuments({ 'emailStats.totalEmails': 0 });

    console.log(`Jobs with emailStats.totalEmails field: ${jobsWithEmailStats}`);
    console.log(`Jobs with totalEmails = 0: ${jobsWithZeroTotalEmails}`);

    // Check cache structure
    const jobsWithCache = await ScheduledJob.countDocuments({ 'cache.reportData.totalMatches': { $exists: true } });
    console.log(`Jobs with cache.reportData.totalMatches: ${jobsWithCache}`);

    // Get a sample job for inspection
    const sampleJob = await ScheduledJob.findOne().lean();
    if (sampleJob) {
      console.log('\n=== SAMPLE JOB DATA ===');
      console.log('Job ID:', sampleJob.jobId);
      console.log('Email Stats:', JSON.stringify(sampleJob.emailStats, null, 2));
      console.log('Customers Count:', sampleJob.customers?.length || 0);
      console.log('Cache exists:', !!sampleJob.cache);
      if (sampleJob.cache?.reportData) {
        console.log('Cache totalMatches:', sampleJob.cache.reportData.totalMatches);
        console.log('Cache processedProjects:', sampleJob.cache.reportData.processedProjects);
      }
    }

    // Test the aggregation
    console.log('\n=== TESTING AGGREGATION ===');

    const emailAggResult = await ScheduledJob.aggregate([
      {
        $group: {
          _id: null,
          totalEmailsSent: { $sum: '$emailStats.sentEmails' },
          totalEmailsFailed: { $sum: '$emailStats.failedEmails' },
          totalEmails: { $sum: '$emailStats.totalEmails' }
        }
      }
    ]);

    const fiAggResult = await ScheduledJob.aggregate([
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

    console.log('Email aggregation result:', emailAggResult[0] || 'No results');
    console.log('FI Match aggregation result:', fiAggResult[0] || 'No results');

    await mongoose.disconnect();

  } catch (error) {
    console.error('Error:', error);
  }
}

checkData();