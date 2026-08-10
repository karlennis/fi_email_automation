#!/usr/bin/env node
/**
 * Daily Project ID Exporter
 *
 * Exports every project ID that entered the system on a given day.
 *
 * Because of the buffer architecture (see documentIngestionService.js), documents
 * land in filter-docs/ first and are only later routed to planning-docs/. Scanning
 * planning-docs/ alone therefore misses any project still sitting in the staging
 * area, so this tool scans BOTH prefixes and unions the project IDs.
 *
 * Day boundaries are UTC by default. The nightly routing job is cron '0 23 * * *'
 * (ingestionScheduler.js) with no timezone override, so it fires at 23:00 in the
 * server's timezone - and the production EC2 box runs UTC. A day's entire intake
 * therefore lands in a single burst at <date>T23:00Z, and baseline markers are
 * named from date.toISOString(), i.e. the UTC date. Using a non-UTC window would
 * cut straight through that 23:00 burst and split one night's batch across two days.
 *
 * Usage:
 *   node export-daily-project-ids.js --date 2026-07-25
 *   node export-daily-project-ids.js --date 2026-07-25 --local
 *   node export-daily-project-ids.js --date 2026-07-25 --output ./my-export.csv
 */

// Load environment variables from backend/.env
require('dotenv').config({ path: require('path').join(__dirname, '../backend/.env') });

const fs = require('fs');
const path = require('path');

// Resolve AWS SDK from backend's node_modules (same pattern as check-updates.js)
const backendNodeModules = path.join(__dirname, '../backend/node_modules');
const { S3Client, ListObjectsV2Command } = require(path.join(backendNodeModules, '@aws-sdk/client-s3'));
const { getBucket, getRegion } = require('../backend/utils/awsConfig');

const BUCKET_NAME = getBucket();
const REGION = getRegion();

// The two stages of the ingestion pipeline
const PREFIXES = ['filter-docs/', 'planning-docs/'];

const s3Client = new S3Client({
  region: REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  }
});

function parseArgs() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
Daily Project ID Exporter

Scans both filter-docs/ (staging buffer) and planning-docs/ (final) for objects
modified on the target day, and exports the union of project IDs.

Usage:
  node export-daily-project-ids.js --date <YYYY-MM-DD> [options]

Options:
  --date, -d      Target day (default: yesterday)
  --output, -o    Output CSV path (default: outputs/project-ids-<date>.csv)
  --local         Use this machine's local day boundaries instead of UTC.
                  Only correct if the ingestion server shares this timezone -
                  production runs UTC, so the default is UTC.
  --no-documents  Skip writing the per-document detail CSV

Examples:
  node export-daily-project-ids.js --date 2026-07-25
  node export-daily-project-ids.js --date 2026-07-25 --local
  node export-daily-project-id
`);
    process.exit(0);
  }

  let dateStr = null;
  let outputFile = null;
  let useUtc = true;
  let writeDocuments = true;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--date' || arg === '-d') {
      dateStr = args[++i];
    } else if (arg === '--output' || arg === '-o') {
      outputFile = args[++i];
    } else if (arg === '--utc') {
      useUtc = true;
    } else if (arg === '--local') {
      useUtc = false;
    } else if (arg === '--no-documents') {
      writeDocuments = false;
    } else if (!arg.startsWith('-') && !dateStr) {
      dateStr = arg;
    }
  }

  // Default to yesterday
  if (!dateStr) {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    dateStr = useUtc ? yesterday.toISOString().split('T')[0] : formatLocalDate(yesterday);
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    console.error(`Error: invalid date "${dateStr}" - expected YYYY-MM-DD`);
    process.exit(1);
  }

  return { dateStr, outputFile, useUtc, writeDocuments };
}

function formatLocalDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Build the [start, end] window for the target day.
 * UTC is the default: it matches both the server timezone the 23:00 routing cron
 * actually fires in and the UTC date used to name baseline markers.
 */
function buildDayWindow(dateStr, useUtc) {
  const [year, month, day] = dateStr.split('-').map(Number);

  if (useUtc) {
    return {
      dayStart: new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0)),
      dayEnd: new Date(Date.UTC(year, month - 1, day, 23, 59, 59, 999))
    };
  }

  return {
    dayStart: new Date(year, month - 1, day, 0, 0, 0, 0),
    dayEnd: new Date(year, month - 1, day, 23, 59, 59, 999)
  };
}

function isSourceDocument(fileName) {
  const lower = fileName.toLowerCase();
  return lower.endsWith('.pdf') || lower.endsWith('.docx');
}

function isBaselineMarker(fileName) {
  return fileName.startsWith('_baseline_');
}

/**
 * Mirrors s3Service.isSystemOrDocfilesFile()
 */
function isSystemOrDocfilesFile(fileName) {
  const lower = fileName.toLowerCase();
  return (
    lower === 'docfiles.txt' ||
    lower === '.keep' ||
    fileName.startsWith('_baseline_') ||
    fileName.startsWith('.')
  );
}

async function scanPrefix(prefix, onObject) {
  let continuationToken = null;
  let scanned = 0;
  let pages = 0;

  do {
    const params = {
      Bucket: BUCKET_NAME,
      Prefix: prefix,
      MaxKeys: 1000
    };
    if (continuationToken) {
      params.ContinuationToken = continuationToken;
    }

    let response;
    try {
      response = await s3Client.send(new ListObjectsV2Command(params));
    } catch (error) {
      if (error.$retryable || error.name === 'TimeoutError') {
        console.warn(`   ⚠️  Retryable S3 error (${error.name}), retrying in 2s...`);
        await new Promise(resolve => setTimeout(resolve, 2000));
        continue;
      }
      throw error;
    }

    pages++;

    for (const obj of response.Contents || []) {
      scanned++;
      onObject(obj);
    }

    if (scanned && scanned % 25000 < 1000 && pages % 25 === 0) {
      console.log(`   ...scanned ${scanned.toLocaleString()} objects under ${prefix}`);
    }

    continuationToken = response.IsTruncated ? response.NextContinuationToken : null;
  } while (continuationToken);

  return { scanned, pages };
}

function csvEscape(value) {
  const str = value === null || value === undefined ? '' : String(value);
  return `"${str.replace(/"/g, '""')}"`;
}

async function main() {
  const { dateStr, outputFile, useUtc, writeDocuments } = parseArgs();
  const { dayStart, dayEnd } = buildDayWindow(dateStr, useUtc);

  console.log('📋 Daily Project ID Exporter\n');
  console.log(`   Bucket:    ${BUCKET_NAME}`);
  console.log(`   Region:    ${REGION}`);
  console.log(`   Target day: ${dateStr} (${useUtc ? 'UTC' : 'local time, ' + Intl.DateTimeFormat().resolvedOptions().timeZone})`);
  console.log(`   Window:    ${dayStart.toISOString()} → ${dayEnd.toISOString()} (UTC)`);
  console.log(`   Prefixes:  ${PREFIXES.join(', ')}\n`);

  if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
    console.error('❌ AWS credentials not found. Check backend/.env');
    process.exit(1);
  }

  const projects = new Map();
  const documents = [];
  const startTime = Date.now();

  const getProject = (projectId) => {
    if (!projects.has(projectId)) {
      projects.set(projectId, {
        projectId,
        stages: new Set(),
        filterSourceDocs: 0,
        planningSourceDocs: 0,
        otherFiles: 0,
        firstActivity: null,
        lastActivity: null,
        baselineMarkerDates: new Set(),
        baselineMarkerTouchedInWindow: false
      });
    }
    return projects.get(projectId);
  };

  let totalScanned = 0;

  for (const prefix of PREFIXES) {
    const stage = prefix.replace('/', '');
    console.log(`🔍 Scanning ${prefix} ...`);

    const { scanned, pages } = await scanPrefix(prefix, (obj) => {
      const parts = obj.Key.split('/');
      // Expect <stage>/<projectId>/<fileName>
      if (parts.length < 3) return;

      const projectId = parts[1];
      const fileName = parts[parts.length - 1];
      if (!projectId || !fileName) return; // folder marker

      const lastModified = obj.LastModified ? new Date(obj.LastModified) : null;
      const inWindow = lastModified && lastModified >= dayStart && lastModified <= dayEnd;

      // A baseline marker named for the target date identifies a project that was
      // first ingested that day, even if the marker object itself was touched later.
      const markerForTargetDate =
        stage === 'planning-docs' &&
        isBaselineMarker(fileName) &&
        fileName === `_baseline_${dateStr}`;

      if (!inWindow && !markerForTargetDate) return;

      const project = getProject(projectId);

      if (isBaselineMarker(fileName)) {
        const markerDate = fileName.replace('_baseline_', '');
        if (markerDate === dateStr) {
          project.baselineMarkerDates.add(markerDate);
        }
        if (inWindow) {
          project.baselineMarkerTouchedInWindow = true;
        }
      }

      if (!inWindow) return; // marker-for-date only, no in-window activity to record

      project.stages.add(stage);

      if (isSourceDocument(fileName)) {
        if (stage === 'filter-docs') {
          project.filterSourceDocs++;
        } else {
          project.planningSourceDocs++;
        }
      } else if (isSystemOrDocfilesFile(fileName)) {
        project.otherFiles++;
      } else {
        project.otherFiles++;
      }

      if (!project.firstActivity || lastModified < project.firstActivity) {
        project.firstActivity = lastModified;
      }
      if (!project.lastActivity || lastModified > project.lastActivity) {
        project.lastActivity = lastModified;
      }

      if (writeDocuments) {
        documents.push({
          projectId,
          stage,
          fileName,
          key: obj.Key,
          lastModified: lastModified.toISOString(),
          size: obj.Size || 0,
          isSourceDocument: isSourceDocument(fileName)
        });
      }
    });

    totalScanned += scanned;
    console.log(`   ✅ ${scanned.toLocaleString()} objects scanned across ${pages} page(s)\n`);
  }

  // Classify each project
  const rows = Array.from(projects.values()).map(p => {
    const totalSourceDocs = p.filterSourceDocs + p.planningSourceDocs;
    const isNew = p.baselineMarkerDates.size > 0;
    const stages = Array.from(p.stages).sort();

    let entryType;
    if (totalSourceDocs === 0) {
      entryType = isNew ? 'new_project_marker_only' : 'metadata_only';
    } else if (isNew) {
      entryType = 'new_project';
    } else if (p.planningSourceDocs > 0) {
      entryType = 'existing_project_update';
    } else {
      entryType = 'staged_only';
    }

    // Map onto the FI scan run's own terminology. A baselined project is excluded
    // from FI scanning (scanJobProcessor.js checks hasBaselineMarker per project),
    // so its documents count towards "skipped", everything else towards "eligible".
    let scanStatus;
    if (isNew) {
      scanStatus = 'skipped_baselined';
    } else if (totalSourceDocs > 0) {
      scanStatus = 'scanned_eligible';
    } else {
      scanStatus = 'no_documents';
    }

    return {
      project_id: p.projectId,
      entry_type: entryType,
      scan_status: scanStatus,
      stage: stages.length ? stages.join('+') : 'baseline-marker-only',
      source_docs_total: totalSourceDocs,
      source_docs_planning: p.planningSourceDocs,
      source_docs_filter: p.filterSourceDocs,
      other_files: p.otherFiles,
      first_activity_utc: p.firstActivity ? p.firstActivity.toISOString() : '',
      last_activity_utc: p.lastActivity ? p.lastActivity.toISOString() : '',
      baseline_marker: isNew ? `_baseline_${dateStr}` : ''
    };
  });

  // Sort numerically where possible, then lexically
  rows.sort((a, b) => {
    const na = Number(a.project_id);
    const nb = Number(b.project_id);
    if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
    return a.project_id.localeCompare(b.project_id);
  });

  // Write outputs
  const outputDir = path.join(__dirname, 'outputs');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const csvPath = outputFile || path.join(outputDir, `project-ids-${dateStr}.csv`);
  const headers = [
    'project_id',
    'entry_type',
    'scan_status',
    'stage',
    'source_docs_total',
    'source_docs_planning',
    'source_docs_filter',
    'other_files',
    'first_activity_utc',
    'last_activity_utc',
    'baseline_marker'
  ];

  const csvContent = [
    headers.join(','),
    ...rows.map(r => headers.map(h => csvEscape(r[h])).join(','))
  ].join('\n');

  fs.writeFileSync(csvPath, csvContent + '\n', 'utf-8');

  let documentsPath = null;
  if (writeDocuments) {
    documentsPath = path.join(outputDir, `project-documents-${dateStr}.csv`);
    documents.sort((a, b) => a.lastModified.localeCompare(b.lastModified));

    const docHeaders = ['project_id', 'stage', 'file_name', 's3_key', 'last_modified_utc', 'size_bytes', 'is_source_document'];
    const docContent = [
      docHeaders.join(','),
      ...documents.map(d => [
        csvEscape(d.projectId),
        csvEscape(d.stage),
        csvEscape(d.fileName),
        csvEscape(d.key),
        csvEscape(d.lastModified),
        d.size,
        d.isSourceDocument ? 'yes' : 'no'
      ].join(','))
    ].join('\n');

    fs.writeFileSync(documentsPath, docContent + '\n', 'utf-8');
  }

  // Summary
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const counts = rows.reduce((acc, r) => {
    acc[r.entry_type] = (acc[r.entry_type] || 0) + 1;
    return acc;
  }, {});

  const totalSourceDocs = rows.reduce((sum, r) => sum + r.source_docs_total, 0);

  console.log('═══════════════════════════════════════════════════');
  console.log(`  RESULTS FOR ${dateStr}`);
  console.log('═══════════════════════════════════════════════════\n');
  console.log(`   Objects scanned:       ${totalScanned.toLocaleString()}`);
  console.log(`   Projects with activity: ${rows.length.toLocaleString()}`);
  console.log(`   Source documents:      ${totalSourceDocs.toLocaleString()} (.pdf / .docx)`);
  console.log(`   Other files touched:   ${rows.reduce((s, r) => s + r.other_files, 0).toLocaleString()}\n`);

  console.log('   Breakdown by entry type:');
  Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .forEach(([type, count]) => console.log(`      ${type.padEnd(26)} ${count}`));

  // Run-aligned view: these totals should reconcile against the FI scan summary email
  const skippedDocs = rows.filter(r => r.scan_status === 'skipped_baselined')
    .reduce((s, r) => s + r.source_docs_total, 0);
  const eligibleDocs = rows.filter(r => r.scan_status === 'scanned_eligible')
    .reduce((s, r) => s + r.source_docs_total, 0);
  const projectsWithDocs = rows.filter(r => r.source_docs_total > 0).length;

  console.log('\n   FI scan run reconciliation:');
  console.log(`      Documents in date range        ${totalSourceDocs.toLocaleString()}`);
  console.log(`      Skipped (baselined projects)   ${skippedDocs.toLocaleString()}`);
  console.log(`      Eligible for scanning          ${eligibleDocs.toLocaleString()}`);
  console.log(`      Distinct projects with docs    ${projectsWithDocs.toLocaleString()}  <- email's "baselinedProjects"`);
  console.log(`      Projects actually baselined    ${rows.filter(r => r.scan_status === 'skipped_baselined').length.toLocaleString()}`);

  const stageCounts = rows.reduce((acc, r) => {
    acc[r.stage] = (acc[r.stage] || 0) + 1;
    return acc;
  }, {});
  console.log('\n   Breakdown by pipeline stage:');
  Object.entries(stageCounts)
    .sort((a, b) => b[1] - a[1])
    .forEach(([stage, count]) => console.log(`      ${stage.padEnd(26)} ${count}`));

  console.log(`\n   ⏱️  Completed in ${elapsed}s`);
  console.log(`\n📁 Output files:`);
  console.log(`   Project IDs: ${csvPath}`);
  if (documentsPath) {
    console.log(`   Documents:   ${documentsPath}`);
  }
  console.log('');
}

main().catch(error => {
  console.error('❌ Error:', error.message);
  if (process.env.LOG_LEVEL === 'debug') {
    console.error(error);
  }
  process.exit(1);
});
