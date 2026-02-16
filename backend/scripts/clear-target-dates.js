/**
 * Clear stuck targetDate from all scan jobs
 * Run: node backend/scripts/clear-target-dates.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const mongoose = require('mongoose');

const MONGODB_URI = process.env.MONGODB_URI;

async function clearTargetDates() {
    try {
        console.log('Connecting to MongoDB...');
        await mongoose.connect(MONGODB_URI);
        console.log('Connected!');

        const result = await mongoose.connection.db.collection('scanjobs').updateMany(
            {},
            { $unset: { 'schedule.targetDate': '' } }
        );

        console.log(`✅ Cleared targetDate from ${result.modifiedCount} scan jobs`);

        // Also clear checkpoint dates to force fresh scan
        const checkpointResult = await mongoose.connection.db.collection('scanjobs').updateMany(
            {},
            {
                $set: {
                    'checkpoint.lastProcessedIndex': 0,
                    'checkpoint.processedCount': 0,
                    'checkpoint.matchesFound': 0,
                    'checkpoint.isResuming': false,
                    'checkpoint.totalDocuments': 0
                },
                $unset: {
                    'checkpoint.scanStartDate': '',
                    'checkpoint.scanEndDate': ''
                }
            }
        );

        console.log(`✅ Reset checkpoint for ${checkpointResult.modifiedCount} scan jobs`);

        await mongoose.disconnect();
        console.log('Done!');
    } catch (error) {
        console.error('Error:', error.message);
        process.exit(1);
    }
}

clearTargetDates();
