const mongoose = require('mongoose');
const ScanJob = require('../models/ScanJob');
require('dotenv').config();

async function checkStuckJobs() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB');

    const runningJobs = await ScanJob.find({ status: 'RUNNING' });
    console.log(`\n🔍 Found ${runningJobs.length} jobs in RUNNING state:`);
    
    runningJobs.forEach(job => {
      console.log(`  - ${job.jobId} (${job.jobName})`);
      console.log(`    Last updated: ${job.updatedAt}`);
      console.log(`    Checkpoint: ${job.checkpoint?.processedCount || 0}/${job.checkpoint?.totalCount || 0}`);
    });

    if (runningJobs.length > 0) {
      console.log('\n⚠️ These jobs are stuck! Reset them with:');
      console.log('   ScanJob.updateMany({ status: "RUNNING" }, { status: "PAUSED" })');
    }

    await mongoose.disconnect();
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

checkStuckJobs();
