const mongoose = require('mongoose');
const ScanJob = require('../models/ScanJob');

// Use production MongoDB URI (same one the server uses)
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://your-production-uri';

async function setTargetDate() {
    try {
        console.log('🔌 Connecting to MongoDB...');
        await mongoose.connect(MONGODB_URI);
        console.log('✅ Connected to MongoDB');

        // Find the specific job
        const job = await ScanJob.findOne({ jobId: 'SCAN-ACOUSTIC-1769734377853' });

        if (!job) {
            console.log('❌ Job not found');
            process.exit(1);
        }

        console.log('📋 Found job:', job.name);
        console.log('📅 Current schedule:', JSON.stringify(job.schedule, null, 2));

        // Initialize schedule if it doesn't exist
        if (!job.schedule) {
            job.schedule = {};
        }

        // Set target date to January 7th, 2026
        job.schedule.targetDate = '2026-01-07';

        await job.save();
        console.log('✅ Updated job with targetDate: 2026-01-07');
        console.log('📅 New schedule:', JSON.stringify(job.schedule, null, 2));

        console.log('🎉 Success! Job will now scan documents from January 7th, 2026');
        process.exit(0);

    } catch (error) {
        console.error('❌ Error:', error.message);
        process.exit(1);
    }
}

setTargetDate();