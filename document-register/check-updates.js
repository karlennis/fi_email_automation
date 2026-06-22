#!/usr/bin/env node
/**
 * Planning ID Update Checker
 *
 * Reads planning IDs from an input CSV, checks S3 for the most recent document
 * upload date per ID, and outputs a CSV with update status (yes/no based on
 * 365-day threshold).
 *
 * Usage:
 *   node check-updates.js <input.csv> [--output <output.csv>]
 *
 * Example:
 *   node check-updates.js NI_GRANTED_2026.csv
 *   node check-updates.js NI_GRANTED_2026.csv --output results.csv
 */

// Load environment variables from backend/.env
require('dotenv').config({ path: require('path').join(__dirname, '../backend/.env') });

const fs = require('fs');
const path = require('path');

// Resolve AWS SDK from backend's node_modules
const backendNodeModules = path.join(__dirname, '../backend/node_modules');
const { S3Client, ListObjectsV2Command } = require(path.join(backendNodeModules, '@aws-sdk/client-s3'));

// S3 client setup - directly queries planning-docs/ in planning-documents-2 bucket
const s3Client = new S3Client({
    region: process.env.AWS_REGION || 'eu-west-2',
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    }
});
const BUCKET_NAME = process.env.S3_BUCKET_NAME || 'planning-documents-2';
const PREFIX = 'planning-docs/';

// Parse command-line arguments
function parseArgs() {
    const args = process.argv.slice(2);

    if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
        console.log(`
Planning ID Update Checker

Usage:
  node check-updates.js <input.csv> [--output <output.csv>]

Arguments:
  <input.csv>       Path to CSV file containing planning_id column (required)
  --output, -o      Custom output file path (optional)
                    Default: <input>_update_status.csv

Example:
  node check-updates.js NI_GRANTED_2026.csv
  node check-updates.js NI_GRANTED_2026.csv --output results.csv
`);
        process.exit(0);
    }

    let inputFile = null;
    let outputFile = null;

    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--output' || args[i] === '-o') {
            outputFile = args[i + 1];
            i++; // Skip next arg
        } else if (!args[i].startsWith('-')) {
            inputFile = args[i];
        }
    }

    if (!inputFile) {
        console.error('Error: Input CSV file is required');
        process.exit(1);
    }

    // Default output file: input_update_status.csv
    if (!outputFile) {
        const parsed = path.parse(inputFile);
        outputFile = path.join(parsed.dir, `${parsed.name}_update_status.csv`);
    }

    return { inputFile, outputFile };
}

// Read and parse CSV file
function readInputCSV(filePath) {
    if (!fs.existsSync(filePath)) {
        console.error(`Error: Input file not found: ${filePath}`);
        process.exit(1);
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split(/\r?\n/).filter(line => line.trim());

    if (lines.length === 0) {
        console.error('Error: Input CSV is empty');
        process.exit(1);
    }

    // Check if first line is header
    const firstLine = lines[0].trim().toLowerCase();
    const hasHeader = firstLine.includes('planning_id') || firstLine === 'planning_id';
    const startIndex = hasHeader ? 1 : 0;

    const planningIds = [];
    const skipped = [];

    for (let i = startIndex; i < lines.length; i++) {
        const value = lines[i].trim();

        // Handle CSV with multiple columns - take first column
        const id = value.split(',')[0].trim();

        if (id && /^\d+$/.test(id)) {
            planningIds.push(id);
        } else if (id) {
            skipped.push({ line: i + 1, value: id });
        }
    }

    if (skipped.length > 0) {
        console.warn(`⚠️  Skipped ${skipped.length} invalid rows (non-numeric IDs)`);
        if (skipped.length <= 5) {
            skipped.forEach(s => console.warn(`   Line ${s.line}: "${s.value}"`));
        }
    }

    return planningIds;
}

// Get the most recent document date for a planning ID
// Directly queries planning-docs/{planningId}/ in the S3 bucket
async function getMostRecentDocumentDate(planningId) {
    try {
        const projectPrefix = `${PREFIX}${planningId}/`;
        let mostRecent = null;
        let continuationToken = null;
        let hasMore = true;

        // Paginate through all objects in this project folder
        while (hasMore) {
            const params = {
                Bucket: BUCKET_NAME,
                Prefix: projectPrefix,
                MaxKeys: 1000
            };
            if (continuationToken) {
                params.ContinuationToken = continuationToken;
            }

            const command = new ListObjectsV2Command(params);
            const response = await s3Client.send(command);

            if (response.Contents && response.Contents.length > 0) {
                for (const obj of response.Contents) {
                    const key = obj.Key.toLowerCase();
                    // Only consider PDF and DOCX files
                    if (key.endsWith('.pdf') || key.endsWith('.docx')) {
                        if (obj.LastModified) {
                            const docDate = new Date(obj.LastModified);
                            if (!mostRecent || docDate > mostRecent) {
                                mostRecent = docDate;
                            }
                        }
                    }
                }
            }

            continuationToken = response.NextContinuationToken;
            hasMore = !!continuationToken;
        }

        return mostRecent;
    } catch (error) {
        // Project not found or S3 error - return null
        return null;
    }
}

// Format date as YYYY-MM-DD
function formatDate(date) {
    if (!date) return '';
    return date.toISOString().split('T')[0];
}

// Small delay to avoid S3 throttling
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Main execution
async function main() {
    const { inputFile, outputFile } = parseArgs();

    console.log('📋 Planning ID Update Checker\n');
    console.log(`📄 Input:  ${inputFile}`);
    console.log(`📄 Output: ${outputFile}`);

    // Read planning IDs
    const planningIds = readInputCSV(inputFile);
    console.log(`\n✅ Found ${planningIds.length} planning IDs to check\n`);

    if (planningIds.length === 0) {
        console.error('Error: No valid planning IDs found in input file');
        process.exit(1);
    }

    // Calculate threshold (365 days ago)
    const thresholdDate = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
    console.log(`📅 Threshold date: ${formatDate(thresholdDate)} (365 days ago)\n`);

    // Process each planning ID
    const results = [];
    let updatedCount = 0;
    let notUpdatedCount = 0;
    let notFoundCount = 0;

    const startTime = Date.now();

    for (let i = 0; i < planningIds.length; i++) {
        const planningId = planningIds[i];

        // Progress logging
        if ((i + 1) % 50 === 0 || i === 0) {
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
            const remaining = planningIds.length - (i + 1);
            const rate = (i + 1) / (elapsed || 1);
            const eta = remaining > 0 ? Math.round(remaining / rate) : 0;
            console.log(`⏳ Processing ${i + 1}/${planningIds.length} (${elapsed}s elapsed, ~${eta}s remaining)`);
        }

        // Get most recent document date
        const mostRecentDate = await getMostRecentDocumentDate(planningId);

        // Determine update status
        let updatedWithinYear = 'no';
        if (mostRecentDate) {
            if (mostRecentDate >= thresholdDate) {
                updatedWithinYear = 'yes';
                updatedCount++;
            } else {
                notUpdatedCount++;
            }
        } else {
            notFoundCount++;
        }

        results.push({
            planning_id: planningId,
            last_update_date: formatDate(mostRecentDate),
            updated_within_year: updatedWithinYear
        });

        // Rate limiting - small delay between requests
        if (i < planningIds.length - 1) {
            await delay(50);
        }
    }

    // Write output CSV
    const csvHeader = 'planning_id,last_update_date,updated_within_year';
    const csvRows = results.map(r =>
        `${r.planning_id},${r.last_update_date},${r.updated_within_year}`
    );
    const csvContent = [csvHeader, ...csvRows].join('\n');

    fs.writeFileSync(outputFile, csvContent, 'utf-8');

    // Summary
    const totalTime = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`\n✅ Complete!\n`);
    console.log(`📊 Summary:`);
    console.log(`   Total processed:    ${planningIds.length}`);
    console.log(`   Updated (yes):      ${updatedCount}`);
    console.log(`   Not updated (no):   ${notUpdatedCount}`);
    console.log(`   No documents found: ${notFoundCount}`);
    console.log(`   Processing time:    ${totalTime}s`);
    console.log(`\n📁 Output saved to: ${outputFile}`);
}

main().catch(error => {
    console.error('❌ Error:', error.message);
    process.exit(1);
});
