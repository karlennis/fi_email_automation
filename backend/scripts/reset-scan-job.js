// Script to reset a scan job so it can run again today
require('dotenv').config();
const mongoose = require('mongoose');
const ScanJob = require('../models/ScanJob');

async function resetScanJob() {
    try {
        await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/fi-email-automation');
        console.log('✅ Connected to MongoDB\n');
        
        // Find the acoustic scan job (case-insensitive)
        const job = await ScanJob.findOne({ 
            $or: [
                { status: 'active' },
                { status: 'ACTIVE' }
            ]
        });
        
        if (!job) {
            console.log('❌ No active scan job found');
            process.exit(1);
        }
        
        console.log(`📋 Found job: ${job.jobId} (${job.name})`);
        console.log(`   Last scan: ${job.statistics.lastScanDate || 'Never'}\n`);
        
        // Reset the lastScanDate and checkpoint
        job.statistics.lastScanDate = null;
        
        // Clear checkpoint to start fresh
        job.checkpoint = {
            lastProcessedIndex: 0,
            lastProcessedFile: '',
            totalDocuments: 0,
            processedCount: 0,
            matchesFound: 0,
            scanStartTime: null,
            lastCheckpointTime: null,
            isResuming: false
        };
        
        await job.save();
        
        console.log('✅ Job reset successfully!');
        console.log('   - Last scan date cleared');
        console.log('   - Checkpoint cleared');
        console.log('   - Job will run on next scheduled scan (12:10 AM) or restart server\n');
        console.log('💡 To trigger immediately, restart the backend server (npm start)');
        
        await mongoose.disconnect();
        process.exit(0);
        
    } catch (error) {
        console.error('❌ Error:', error);
        process.exit(1);
    }
}

resetScanJob();
