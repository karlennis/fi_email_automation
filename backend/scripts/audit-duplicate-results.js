/**
 * Replay the FI-response veto and per-project selection over stored results.
 *
 * READ-ONLY by design: performs only find/aggregate, and applies the new logic in
 * memory. Nothing is written, so it is safe to point at production.
 *
 * Reports what would change and, importantly, how many genuine-looking leads the veto
 * would suppress - so its aggressiveness is a measured number rather than an assumption.
 *
 *   node scripts/audit-duplicate-results.js            # summary
 *   node scripts/audit-duplicate-results.js --verbose  # list every affected project
 */

require('dotenv').config();
const mongoose = require('mongoose');

const fiDetectionService = require('../services/fiDetectionService');
const scanJobProcessor = require('../services/scanJobProcessor');
const { normalizeReportType, getQuoteTerms } = require('../services/reportTypes');

const VERBOSE = process.argv.includes('--verbose');
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/fi-email-automation';

const clean = (s, n = 140) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

// Does this quote look like a real request? Used to size the risk of over-vetoing.
const REQUEST_EVIDENCE = /\b(is |are |be )?(requested|required) to\b|\bshall (submit|provide|carry out)\b|\bshould (submit|provide|be submitted)\b|\brecommend(s|ed)? (that |the )?(the )?applicant\b|\bmust (submit|provide)\b/i;

async function main() {
  await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 20000 });
  const db = mongoose.connection.db;
  console.log(`Connected (read-only) to ${db.databaseName}\n`);

  const rows = await db.collection('scanjobdailyresults').aggregate([
    { $unwind: '$matches' },
    {
      $project: {
        _id: 0,
        jobId: 1,
        scanDate: 1,
        projectId: '$matches.projectId',
        fileName: '$matches.fileName',
        filePath: '$matches.filePath',
        fiType: '$matches.fiType',
        validationQuote: '$matches.validationQuote',
        confidence: '$matches.confidence',
        timestamp: '$matches.timestamp'
      }
    }
  ], { allowDiskUse: true }).toArray();

  const distinctProjects = new Set(rows.map(r => r.projectId));
  console.log(`Stored matches: ${rows.length} across ${distinctProjects.size} distinct projects\n`);

  // ---- 1. Apply the response veto -------------------------------------------------
  // Uses the filename plus the stored validationQuote as the document text. That is
  // less than a live scan sees, so this is a lower bound on what the veto catches.
  const vetoed = [];
  const kept = [];

  for (const row of rows) {
    const reportType = normalizeReportType(row.fiType || 'acoustic');
    const verdict = await fiDetectionService.classifyFIResponse(
      row.validationQuote,
      row.fileName,
      reportType
    );
    if (verdict.isResponse) {
      vetoed.push({ ...row, verdict });
    } else {
      kept.push(row);
    }
  }

  // A veto is project-wide, so anything else in a vetoed project goes too.
  const vetoedProjectKeys = new Set(
    vetoed.map(v => `${v.projectId}::${normalizeReportType(v.fiType || 'acoustic')}`)
  );
  const collateral = kept.filter(r =>
    vetoedProjectKeys.has(`${r.projectId}::${normalizeReportType(r.fiType || 'acoustic')}`)
  );
  const surviving = kept.filter(r =>
    !vetoedProjectKeys.has(`${r.projectId}::${normalizeReportType(r.fiType || 'acoustic')}`)
  );

  console.log('=== 1. FI-RESPONSE VETO ===');
  console.log(`  Matches vetoed directly      : ${vetoed.length}`);
  console.log(`  Also dropped (same project)  : ${collateral.length}`);
  console.log(`  Projects fully suppressed    : ${vetoedProjectKeys.size}`);
  console.log(`  Matches surviving            : ${surviving.length}`);

  const bySource = vetoed.reduce((acc, v) => {
    acc[v.verdict.source] = (acc[v.verdict.source] || 0) + 1;
    return acc;
  }, {});
  console.log(`  By layer                     : ${JSON.stringify(bySource)}`);

  // ---- 2. Over-veto risk ----------------------------------------------------------
  // Collateral rows whose own quote reads like a genuine request are the cost of the
  // project-wide rule. Worth eyeballing before trusting the number above.
  const riskyCollateral = collateral.filter(r => REQUEST_EVIDENCE.test(r.validationQuote || ''));
  console.log('\n=== 2. OVER-VETO RISK ===');
  console.log(`  Dropped rows that still read as a genuine request: ${riskyCollateral.length}`);
  if (riskyCollateral.length > 0) {
    for (const r of riskyCollateral.slice(0, VERBOSE ? 1000 : 10)) {
      console.log(`    [${r.projectId}] ${r.fileName}`);
      console.log(`        "${clean(r.validationQuote)}"`);
    }
    if (!VERBOSE && riskyCollateral.length > 10) {
      console.log(`    ... ${riskyCollateral.length - 10} more (use --verbose)`);
    }
  }

  // ---- 3. Collapse to one row per project ------------------------------------------
  const before = surviving.length;
  const selected = scanJobProcessor.selectBestMatchPerProject(surviving, 'acoustic');
  console.log('\n=== 3. PER-PROJECT COLLAPSE ===');
  console.log(`  Surviving matches            : ${before}`);
  console.log(`  After one-row-per-project    : ${selected.length}`);
  console.log(`  Duplicate rows removed       : ${before - selected.length}`);

  // ---- 4. Multi-document projects, before and after --------------------------------
  const groupCount = (list) => {
    const m = new Map();
    for (const r of list) {
      const key = `${r.projectId}::${normalizeReportType(r.fiType || 'acoustic')}`;
      m.set(key, (m.get(key) || 0) + 1);
    }
    return [...m.values()].filter(n => n > 1).length;
  };
  console.log('\n=== 4. PROJECTS WITH >1 MATCHED FILE ===');
  console.log(`  Before : ${groupCount(rows)}`);
  console.log(`  After  : ${groupCount(selected)}   (target: 0)`);

  // ---- 5. Delivered reports that would change --------------------------------------
  const reports = await db.collection('fi_reports').aggregate([
    { $unwind: '$projectsFound' },
    {
      $group: {
        _id: { reportId: '$reportId', projectId: '$projectsFound.projectId' },
        customerEmail: { $first: '$customerEmail' },
        generatedAt: { $first: '$generatedAt' },
        docs: { $addToSet: '$projectsFound.metadata.documentName' }
      }
    },
    { $addFields: { n: { $size: '$docs' } } },
    { $match: { n: { $gt: 1 } } }
  ], { allowDiskUse: true }).toArray();

  console.log('\n=== 5. DELIVERED REPORTS AFFECTED ===');
  console.log(`  Report/project pairs that showed >1 document: ${reports.length}`);
  const affectedCustomers = new Set(reports.map(r => r.customerEmail));
  console.log(`  Distinct customer recipients affected       : ${affectedCustomers.size}`);

  if (VERBOSE) {
    console.log('\n=== VETOED PROJECTS (detail) ===');
    for (const v of vetoed) {
      console.log(`  [${v.projectId}/${v.fiType}] ${v.fileName}`);
      console.log(`      layer : ${v.verdict.source}`);
      console.log(`      reason: ${v.verdict.reason}`);
      console.log(`      quote : "${clean(v.validationQuote)}"`);
    }
  }

  await mongoose.disconnect();
  console.log('\nDone. No data was modified.');
}

main().catch(async (error) => {
  console.error('FATAL:', error);
  try { await mongoose.disconnect(); } catch { /* already closed */ }
  process.exit(1);
});
