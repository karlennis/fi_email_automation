// Script to check checkpoint status of scan jobs
require('dotenv').config();
const mongoose = require('mongoose');
const ScanJob = require('../models/ScanJob');

async function checkCheckpoints() {
    try {
        await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/fi-email-automation');
        console.log('✅ Connected to MongoDB');
        
        const jobs = await ScanJob.find({}).select('jobId checkpoint status').lean();
        
        console.log(`\n📊 Found ${jobs.length} scan jobs:\n`);
        
        jobs.forEach(job => {
            console.log(`Job ID: ${job.jobId}`);
            console.log(`Status: ${job.status}`);
            
            if (job.checkpoint) {
                console.log(`Checkpoint:`);
                console.log(`  - Last Processed Index: ${job.checkpoint.lastProcessedIndex || 0}`);
                console.log(`  - Last Processed File: ${job.checkpoint.lastProcessedFile || 'N/A'}`);
                console.log(`  - Total Documents: ${job.checkpoint.totalDocuments || 0}`);
                console.log(`  - Processed Count: ${job.checkpoint.processedCount || 0}`);
                console.log(`  - Matches Found: ${job.checkpoint.matchesFound || 0}`);
                console.log(`  - Is Resuming: ${job.checkpoint.isResuming ? 'YES ⚠️' : 'NO'}`);
                
                if (job.checkpoint.isResuming) {
                    console.log(`  ⚠️  This job needs to resume from document #${job.checkpoint.lastProcessedIndex + 1}`);
                }
            } else {
                console.log(`Checkpoint: Not initialized`);
            }
            console.log('---\n');
        });
        
        await mongoose.disconnect();
        console.log('✅ Disconnected from MongoDB');
        process.exit(0);
    } catch (error) {
        console.error('❌ Error:', error);
        process.exit(1);
    }
}

checkCheckpoints();
