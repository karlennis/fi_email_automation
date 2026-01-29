// Script to update scan job schedule configuration
require('dotenv').config();
const mongoose = require('mongoose');
const ScanJob = require('../models/ScanJob');

async function updateJobSchedule() {
    try {
        await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/fi-email-automation');
        console.log('✅ Connected to MongoDB\n');
        
        // Find the acoustic scan job
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
        
        console.log(`📋 Current job configuration:`);
        console.log(`   Job ID: ${job.jobId}`);
        console.log(`   Name: ${job.name}`);
        console.log(`   Schedule Type: ${job.schedule?.type || 'DAILY'}`);
        console.log(`   Lookback Days: ${job.schedule?.lookbackDays || 1}\n`);
        
        // Example configurations:
        console.log('📝 Available schedule configurations:\n');
        console.log('1. DAILY (scan yesterday\'s documents)');
        console.log('   - Type: DAILY');
        console.log('   - Lookback: 1 day\n');
        
        console.log('2. WEEKLY (scan last 7 days)');
        console.log('   - Type: WEEKLY');
        console.log('   - Lookback: 7 days\n');
        
        console.log('3. MONTHLY (scan last 30 days)');
        console.log('   - Type: MONTHLY');
        console.log('   - Lookback: 30 days\n');
        
        console.log('4. BI-WEEKLY (scan last 14 days every 2 weeks)');
        console.log('   - Type: WEEKLY');
        console.log('   - Lookback: 14 days\n');
        
        // Update to WEEKLY with 7 day lookback as an example
        // You can modify these values as needed
        const newScheduleType = 'WEEKLY'; // Change this: DAILY, WEEKLY, MONTHLY
        const newLookbackDays = 7; // Change this: 1-365
        
        console.log(`\n🔄 Updating job to:`);
        console.log(`   Schedule Type: ${newScheduleType}`);
        console.log(`   Lookback Days: ${newLookbackDays}\n`);
        
        job.schedule = job.schedule || {};
        job.schedule.type = newScheduleType;
        job.schedule.lookbackDays = newLookbackDays;
        
        await job.save();
        
        console.log('✅ Job schedule updated successfully!');
        console.log('\n📅 Example behavior:');
        
        if (newScheduleType === 'DAILY') {
            console.log(`   - Runs every day`);
            console.log(`   - Scans documents from ${newLookbackDays} day(s) ago`);
        } else if (newScheduleType === 'WEEKLY') {
            console.log(`   - Runs once per week`);
            console.log(`   - Scans documents from the last ${newLookbackDays} days`);
        } else if (newScheduleType === 'MONTHLY') {
            console.log(`   - Runs once per month`);
            console.log(`   - Scans documents from the last ${newLookbackDays} days`);
        }
        
        console.log(`   - Sends match emails every 10,000 documents processed`);
        console.log(`   - Continues scanning until all documents are processed\n`);
        
        await mongoose.disconnect();
        process.exit(0);
        
    } catch (error) {
        console.error('❌ Error:', error);
        process.exit(1);
    }
}

updateJobSchedule();
