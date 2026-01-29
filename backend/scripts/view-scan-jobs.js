// Script to view all scan jobs and their status
require('dotenv').config();
const mongoose = require('mongoose');
const ScanJob = require('../models/ScanJob');

async function viewScanJobs() {
    try {
        await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/fi-email-automation');
        console.log('✅ Connected to MongoDB\n');
        
        const jobs = await ScanJob.find({}).lean();
        
        console.log(`📊 Found ${jobs.length} scan job(s):\n`);
        
        jobs.forEach(job => {
            console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
            console.log(`Job ID: ${job.jobId}`);
            console.log(`Name: ${job.name}`);
            console.log(`Status: ${job.status}`);
            console.log(`Type: ${job.documentType}`);
            console.log(`Last Scan: ${job.statistics?.lastScanDate || 'Never'}`);
            
            if (job.checkpoint) {
                console.log(`\nCheckpoint:`);
                console.log(`  - Processed: ${job.checkpoint.processedCount || 0} / ${job.checkpoint.totalDocuments || 0}`);
                console.log(`  - Matches: ${job.checkpoint.matchesFound || 0}`);
                console.log(`  - Is Resuming: ${job.checkpoint.isResuming ? 'YES' : 'NO'}`);
                if (job.checkpoint.lastProcessedFile) {
                    console.log(`  - Last File: ${job.checkpoint.lastProcessedFile}`);
                }
            }
            console.log('');
        });
        
        await mongoose.disconnect();
        process.exit(0);
        
    } catch (error) {
        console.error('❌ Error:', error);
        process.exit(1);
    }
}

viewScanJobs();
