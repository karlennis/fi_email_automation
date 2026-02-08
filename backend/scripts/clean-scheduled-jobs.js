require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const mongoose = require('mongoose');
const ScheduledJob = require('../models/ScheduledJob');

async function cleanScheduledJobs() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB');

    const result = await ScheduledJob.deleteMany({});
    console.log(`🗑️  Deleted ${result.deletedCount} scheduled jobs`);

    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

cleanScheduledJobs();
