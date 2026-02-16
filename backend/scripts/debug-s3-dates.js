/**
 * Debug script to check S3 document dates
 * Run: node backend/scripts/debug-s3-dates.js 2026-02-10
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { S3Client, ListObjectsV2Command } = require('@aws-sdk/client-s3');

const s3Client = new S3Client({
    region: process.env.AWS_REGION || 'eu-west-2',
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    }
});
const bucketName = process.env.S3_BUCKET_NAME || 'planning-documents-2';

async function debugS3Dates(targetDateStr) {
    const targetDate = new Date(targetDateStr);
    const startOfDay = new Date(targetDate);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(targetDate);
    endOfDay.setHours(23, 59, 59, 999);

    console.log(`\n🔍 Debugging S3 dates for: ${targetDateStr}`);
    console.log(`   Start: ${startOfDay.toISOString()}`);
    console.log(`   End:   ${endOfDay.toISOString()}`);
    console.log('');

    let continuationToken = null;
    let totalScanned = 0;
    let matchedInRange = 0;
    const dateCounts = {};
    const sampleDocs = [];

    try {
        // Scan ALL objects to get date distribution
        while (true) {
            const params = {
                Bucket: bucketName,
                Prefix: 'planning-docs/',
                MaxKeys: 1000,
                ContinuationToken: continuationToken
            };

            const command = new ListObjectsV2Command(params);
            const response = await s3Client.send(command);

            if (response.Contents) {
                for (const object of response.Contents) {
                    totalScanned++;

                    if (!object.LastModified) continue;

                    // Get date string for grouping
                    const dateStr = object.LastModified.toISOString().split('T')[0];
                    dateCounts[dateStr] = (dateCounts[dateStr] || 0) + 1;

                    // Check if in target range
                    if (object.LastModified >= startOfDay && object.LastModified <= endOfDay) {
                        const fileName = object.Key.split('/').pop();
                        if (fileName &&
                            !fileName.startsWith('.') &&
                            fileName.includes('.') &&
                            fileName.toLowerCase() !== 'docfiles.txt' &&
                            (fileName.toLowerCase().endsWith('.pdf') || fileName.toLowerCase().endsWith('.docx'))) {
                            matchedInRange++;

                            // Store sample documents
                            if (sampleDocs.length < 10) {
                                sampleDocs.push({
                                    key: object.Key,
                                    lastModified: object.LastModified.toISOString(),
                                    size: object.Size
                                });
                            }
                        }
                    }
                }
            }

            continuationToken = response.NextContinuationToken;
            if (!continuationToken) break;

            if (totalScanned % 10000 === 0) {
                console.log(`   Scanned ${totalScanned} objects...`);
            }
        }

        // Sort dates and show distribution
        const sortedDates = Object.entries(dateCounts)
            .sort((a, b) => b[0].localeCompare(a[0])) // Most recent first
            .slice(0, 30); // Show last 30 days

        console.log(`\n📊 S3 Object Date Distribution (from ${totalScanned} scanned):`);
        console.log('   Date         | Count');
        console.log('   -------------|-------');
        for (const [date, count] of sortedDates) {
            const marker = date === targetDateStr ? ' <<< TARGET' : '';
            console.log(`   ${date} | ${count}${marker}`);
        }

        console.log(`\n🎯 Documents matching ${targetDateStr}: ${matchedInRange}`);

        if (sampleDocs.length > 0) {
            console.log('\n📄 Sample matched documents:');
            for (const doc of sampleDocs) {
                console.log(`   - ${doc.key}`);
                console.log(`     LastModified: ${doc.lastModified}`);
            }
        }

        // Show what the scanner would report
        console.log('\n⚠️ Key Insight:');
        console.log(`   If you're seeing ~18k docs for EVERY date, it means most S3 objects`);
        console.log(`   were uploaded/modified on the SAME DATE (bulk upload day).`);
        console.log(`   The S3 LastModified reflects UPLOAD date, not the document's original date.`);

    } catch (error) {
        console.error('❌ Error:', error.message);
    }
}

// Run with date argument
const targetDate = process.argv[2] || new Date().toISOString().split('T')[0];
debugS3Dates(targetDate);
