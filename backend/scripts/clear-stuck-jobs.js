const mongoose = require('mongoose');
const Bull = require('bull');
const ScanJob = require('../models/ScanJob');
require('dotenv').config();

async function getRedisConfig() {
  if (process.env.REDIS_URL) {
    const redisUrl = process.env.REDIS_URL;
    if (redisUrl.startsWith('redis://') || redisUrl.startsWith('rediss://')) {
      const url = new URL(redisUrl);
      return {
        host: url.hostname,
        port: parseInt(url.port || '6379', 10),
        password: url.password || undefined,
        tls: url.protocol === 'rediss:' ? {} : undefined
      };
    }
    return redisUrl;
  }

  const host = process.env.REDIS_HOST || '127.0.0.1';
  const port = process.env.REDIS_PORT || '6379';
  const password = process.env.REDIS_PASSWORD;

  if (password) {
    return `redis://:${password}@${host}:${port}`;
  }

  return `redis://${host}:${port}`;
}

async function clearStuckJobs() {
  try {
    console.log('🔍 Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB');

    // Get Redis config
    const redisConfig = await getRedisConfig();
    console.log('🔍 Connecting to Redis...');
    const queue = new Bull('scan-jobs', { redis: redisConfig });
    console.log('✅ Connected to Redis');

    // Check stuck jobs in MongoDB
    const runningJobs = await ScanJob.find({ status: 'RUNNING' });
    console.log(`\n📋 Found ${runningJobs.length} jobs in RUNNING state`);

    // Check queue
    const waitingCount = await queue.getWaitingCount();
    const activeCount = await queue.getActiveCount();
    const failedCount = await queue.getFailedCount();
    const completedCount = await queue.getCompletedCount();

    console.log(`\n📊 Queue Status:`);
    console.log(`  - Waiting: ${waitingCount}`);
    console.log(`  - Active: ${activeCount}`);
    console.log(`  - Failed: ${failedCount}`);
    console.log(`  - Completed: ${completedCount}`);

    // Get waiting jobs
    if (waitingCount > 0) {
      const waitingJobs = await queue.getWaiting(0, 100);
      console.log(`\n⏳ Waiting Jobs:`);
      waitingJobs.forEach(job => {
        console.log(`  - ${job.id}: ${JSON.stringify(job.data)}`);
      });
    }

    // Get active jobs
    if (activeCount > 0) {
      const activeJobs = await queue.getActive(0, 100);
      console.log(`\n🚀 Active Jobs:`);
      activeJobs.forEach(job => {
        console.log(`  - ${job.id}: ${JSON.stringify(job.data)}`);
      });
    }

    // Get failed jobs
    if (failedCount > 0) {
      const failedJobs = await queue.getFailed(0, 100);
      console.log(`\n❌ Failed Jobs:`);
      failedJobs.forEach(job => {
        console.log(`  - ${job.id}: ${job.failedReason}`);
      });
    }

    // Option to clear
    if (process.argv.includes('--clear')) {
      console.log('\n🧹 Clearing stuck jobs...');

      // Clear all jobs from queue
      const allJobs = await queue.getCompletedCount() + await queue.getFailedCount() + await queue.getWaitingCount() + await queue.getActiveCount();
      
      if (waitingCount > 0) {
        const waiting = await queue.getWaiting();
        for (const job of waiting) {
          await job.remove();
          console.log(`  ✅ Removed waiting job: ${job.id}`);
        }
      }

      if (failedCount > 0) {
        const failed = await queue.getFailed();
        for (const job of failed) {
          await job.remove();
          console.log(`  ✅ Removed failed job: ${job.id}`);
        }
      }

      // Reset RUNNING jobs to PAUSED in MongoDB
      if (runningJobs.length > 0) {
        await ScanJob.updateMany({ status: 'RUNNING' }, { status: 'PAUSED' });
        console.log(`  ✅ Reset ${runningJobs.length} RUNNING jobs to PAUSED`);
      }

      console.log('\n✅ Cleanup complete! You can now manually trigger jobs again.');
    } else {
      console.log('\n💡 Run with --clear flag to clear stuck jobs:');
      console.log('   node scripts/clear-stuck-jobs.js --clear');
    }

    await queue.close();
    await mongoose.disconnect();

  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

clearStuckJobs();
