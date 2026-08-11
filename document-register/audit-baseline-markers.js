#!/usr/bin/env node
/**
 * Baseline Marker Audit
 *
 * Baseline markers (planning-docs/<projectId>/_baseline_<YYYY-MM-DD>) mark a project
 * as a first-time ingestion so the FI scan skips it. They are meant to be removed by
 * ingestionScheduler's 12:05 AM cleanup job, which keeps the last
 * BASELINE_MARKER_RETENTION_DAYS days (default 2 - the same window hasBaselineMarker
 * looks back over, and never less, or a marker would expire while still load-bearing).
 *
 * This audits what is actually still in the bucket, so a build-up of stale markers
 * (and the date cleanup last succeeded) is visible.
 *
 * Usage:
 *   node audit-baseline-markers.js
 *   node audit-baseline-markers.js --output ./markers.csv
 */

require('dotenv').config({ path: require('path').join(__dirname, '../backend/.env') });

const fs = require('fs');
const path = require('path');
const backendNodeModules = path.join(__dirname, '../backend/node_modules');
const { S3Client, ListObjectsV2Command } = require(path.join(backendNodeModules, '@aws-sdk/client-s3'));
const { getBucket, getRegion } = require('../backend/utils/awsConfig');

const BUCKET_NAME = getBucket();
const REGION = getRegion();

const s3Client = new S3Client({
  region: REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  }
});

async function main() {
  const args = process.argv.slice(2);
  const outIdx = args.findIndex(a => a === '--output' || a === '-o');
  const outputFile = outIdx >= 0 ? args[outIdx + 1] : path.join(__dirname, 'outputs', 'baseline-markers-audit.csv');

  console.log('📌 Baseline Marker Audit\n');
  console.log(`   Bucket: ${BUCKET_NAME}`);
  console.log(`   Region: ${REGION}\n`);

  const markers = [];
  let continuationToken = null;
  let scanned = 0;
  const startTime = Date.now();

  do {
    const params = {
      Bucket: BUCKET_NAME,
      Prefix: 'planning-docs/',
      MaxKeys: 1000
    };
    if (continuationToken) params.ContinuationToken = continuationToken;

    const response = await s3Client.send(new ListObjectsV2Command(params));

    for (const obj of response.Contents || []) {
      scanned++;
      if (obj.Key.includes('/_baseline_')) {
        const parts = obj.Key.split('/');
        markers.push({
          projectId: parts[1],
          markerDate: obj.Key.split('_baseline_')[1] || '',
          key: obj.Key,
          lastModified: obj.LastModified.toISOString()
        });
      }
    }

    if (scanned % 250000 < 1000) {
      console.log(`   ...scanned ${scanned.toLocaleString()} objects, ${markers.length.toLocaleString()} markers so far`);
    }

    continuationToken = response.IsTruncated ? response.NextContinuationToken : null;
  } while (continuationToken);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  // Histogram by marker date
  const byDate = {};
  for (const m of markers) {
    byDate[m.markerDate] = (byDate[m.markerDate] || 0) + 1;
  }

  // Read the same variable s3Service uses, so this report cannot measure a different
  // contract than the code enforces. (It is read directly rather than by requiring
  // s3Service, which builds an S3 client and a winston logger at import time.)
  const RETENTION_DAYS = Math.max(2, parseInt(process.env.BASELINE_MARKER_RETENTION_DAYS || '2', 10));

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - RETENTION_DAYS);
  const cutoffStr = cutoff.toISOString().split('T')[0];
  const stale = markers.filter(m => m.markerDate && m.markerDate < cutoffStr);

  console.log(`\n   Objects scanned:  ${scanned.toLocaleString()}`);
  console.log(`   Baseline markers: ${markers.length.toLocaleString()}`);
  console.log(`   Cleanup cutoff:   ${cutoffStr} (markers older than this should be deleted)`);
  console.log(`   STALE markers:    ${stale.length.toLocaleString()}`);
  console.log(`   Unique projects:  ${new Set(markers.map(m => m.projectId)).size.toLocaleString()}`);

  console.log('\n   Markers by date:');
  Object.entries(byDate).sort().forEach(([date, count]) => {
    const isStale = date < cutoffStr;
    console.log(`      ${date}  ${String(count).padStart(6)}  ${isStale ? 'STALE - should have been deleted' : 'ok (within retention)'}`);
  });

  const outputDir = path.dirname(outputFile);
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const csv = ['project_id,marker_date,is_stale,s3_key,last_modified_utc']
    .concat(markers
      .sort((a, b) => a.markerDate.localeCompare(b.markerDate) || a.projectId.localeCompare(b.projectId))
      .map(m => `"${m.projectId}","${m.markerDate}","${m.markerDate < cutoffStr ? 'yes' : 'no'}","${m.key}","${m.lastModified}"`))
    .join('\n');

  fs.writeFileSync(outputFile, csv + '\n', 'utf-8');

  console.log(`\n   ⏱️  Completed in ${elapsed}s`);
  console.log(`\n📁 Output: ${outputFile}\n`);
}

main().catch(error => {
  console.error('❌ Error:', error.message);
  process.exit(1);
});
