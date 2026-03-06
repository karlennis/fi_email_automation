const mongoose = require('mongoose');
const ScheduledJob = require('../models/ScheduledJob');
const FIReport = require('../models/FIReport');
require('dotenv').config();

function parseArgs(argv) {
  const args = {
    projectId: null,
    apply: false,
    includeArchived: false,
    help: false
  };

  for (let i = 0; i < argv.length; i++) {
    const current = argv[i];

    if (current === '--project' || current === '-p') {
      args.projectId = argv[i + 1];
      i++;
    } else if (current === '--apply') {
      args.apply = true;
    } else if (current === '--include-archived') {
      args.includeArchived = true;
    } else if (current === '--help' || current === '-h') {
      args.help = true;
    } else if (!current.startsWith('-') && !args.projectId) {
      args.projectId = current;
    }
  }

  return args;
}

function printHelp() {
  console.log(`
Cleanup stale project data from cached report output and FI reports.

Usage:
  node scripts/cleanup-stale-project-data.js --project <PROJECT_ID> [--apply] [--include-archived]

Options:
  --project, -p         Required project ID to remove (e.g. 375099)
  --apply               Persist changes to MongoDB (default is dry-run)
  --include-archived    Also clean archived FI reports
  --help, -h            Show this help text

Examples:
  node scripts/cleanup-stale-project-data.js --project 375099
  node scripts/cleanup-stale-project-data.js --project 375099 --apply
  node scripts/cleanup-stale-project-data.js --project 375099 --apply --include-archived
`);
}

function projectIdEquals(value, projectId) {
  if (value === null || value === undefined) return false;
  return String(value).trim() === String(projectId).trim();
}

function countProjectMatchesInCustomerMatches(customerMatches, projectId) {
  if (!Array.isArray(customerMatches)) return 0;

  let count = 0;
  for (const customerMatch of customerMatches) {
    const matches = Array.isArray(customerMatch?.matches) ? customerMatch.matches : [];
    for (const match of matches) {
      if (projectIdEquals(match?.projectId, projectId)) {
        count++;
      }
    }
  }

  return count;
}

function pruneCustomerMatches(customerMatches, projectId) {
  if (!Array.isArray(customerMatches)) {
    return {
      updatedCustomerMatches: customerMatches,
      removedMatches: 0,
      resultingTotalMatches: 0
    };
  }

  let removedMatches = 0;

  const updatedCustomerMatches = customerMatches.map((customerMatch) => {
    const matches = Array.isArray(customerMatch?.matches) ? customerMatch.matches : [];
    const filteredMatches = matches.filter((match) => {
      const isTarget = projectIdEquals(match?.projectId, projectId);
      if (isTarget) removedMatches++;
      return !isTarget;
    });

    return {
      ...customerMatch,
      matches: filteredMatches
    };
  });

  const resultingTotalMatches = updatedCustomerMatches.reduce((sum, customerMatch) => {
    const count = Array.isArray(customerMatch?.matches) ? customerMatch.matches.length : 0;
    return sum + count;
  }, 0);

  return {
    updatedCustomerMatches,
    removedMatches,
    resultingTotalMatches
  };
}

async function cleanupScheduledJobCache(projectId, applyChanges) {
  const jobs = await ScheduledJob.find({
    'cache.reportData.customerMatches.matches.projectId': String(projectId)
  });

  const result = {
    matchedJobs: jobs.length,
    modifiedJobs: 0,
    removedMatches: 0,
    jobIds: []
  };

  for (const job of jobs) {
    const reportData = job.cache?.reportData;
    const customerMatches = reportData?.customerMatches || [];
    const beforeMatches = countProjectMatchesInCustomerMatches(customerMatches, projectId);

    if (beforeMatches === 0) continue;

    const {
      updatedCustomerMatches,
      removedMatches,
      resultingTotalMatches
    } = pruneCustomerMatches(customerMatches, projectId);

    result.removedMatches += removedMatches;
    result.modifiedJobs++;
    result.jobIds.push(job.jobId || job._id.toString());

    if (applyChanges) {
      job.cache.reportData.customerMatches = updatedCustomerMatches;
      job.cache.reportData.totalMatches = resultingTotalMatches;
      job.markModified('cache.reportData.customerMatches');
      job.markModified('cache.reportData.totalMatches');
      await job.save();
    }
  }

  return result;
}

async function cleanupFIReports(projectId, applyChanges, includeArchived) {
  const reportQuery = {
    'projectsFound.projectId': String(projectId)
  };

  if (!includeArchived) {
    reportQuery.archived = { $ne: true };
  }

  const reports = await FIReport.find(reportQuery);

  const result = {
    matchedReports: reports.length,
    modifiedReports: 0,
    removedProjectEntries: 0,
    reportIds: []
  };

  for (const report of reports) {
    const projectsFound = Array.isArray(report.projectsFound) ? report.projectsFound : [];
    const beforeLength = projectsFound.length;

    const filteredProjects = projectsFound.filter((project) => !projectIdEquals(project?.projectId, projectId));
    const removed = beforeLength - filteredProjects.length;

    if (removed <= 0) continue;

    result.modifiedReports++;
    result.removedProjectEntries += removed;
    result.reportIds.push(report.reportId || report._id.toString());

    if (applyChanges) {
      report.projectsFound = filteredProjects;
      report.totalFIMatches = filteredProjects.length;
      await report.save();
    }
  }

  return result;
}

async function run() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  if (!args.projectId) {
    console.error('❌ Missing required --project <PROJECT_ID> argument.');
    printHelp();
    process.exit(1);
  }

  if (!process.env.MONGODB_URI) {
    console.error('❌ MONGODB_URI is not set in environment.');
    process.exit(1);
  }

  console.log(`\n🧹 Project cleanup started for projectId=${args.projectId}`);
  console.log(`Mode: ${args.apply ? 'APPLY (writes enabled)' : 'DRY-RUN (no changes written)'}`);
  console.log(`Include archived FI reports: ${args.includeArchived ? 'YES' : 'NO'}\n`);

  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB\n');

    const scheduledJobResult = await cleanupScheduledJobCache(args.projectId, args.apply);
    const fiReportResult = await cleanupFIReports(args.projectId, args.apply, args.includeArchived);

    console.log('📦 ScheduledJob cache cleanup');
    console.log(`   Matched jobs: ${scheduledJobResult.matchedJobs}`);
    console.log(`   Jobs to modify: ${scheduledJobResult.modifiedJobs}`);
    console.log(`   Removed cached match entries: ${scheduledJobResult.removedMatches}`);

    console.log('\n📄 FIReport cleanup');
    console.log(`   Matched reports: ${fiReportResult.matchedReports}`);
    console.log(`   Reports to modify: ${fiReportResult.modifiedReports}`);
    console.log(`   Removed project entries: ${fiReportResult.removedProjectEntries}`);

    if (args.apply) {
      console.log('\n✅ Cleanup applied successfully.');
    } else {
      console.log('\nℹ️ Dry-run only. Re-run with --apply to persist changes.');
    }

    if (scheduledJobResult.jobIds.length > 0) {
      console.log(`\nAffected jobs: ${scheduledJobResult.jobIds.join(', ')}`);
    }

    if (fiReportResult.reportIds.length > 0) {
      console.log(`Affected FI reports: ${fiReportResult.reportIds.join(', ')}`);
    }

    await mongoose.disconnect();
    process.exit(0);
  } catch (error) {
    console.error('\n❌ Cleanup failed:', error.message);
    if (error.stack) {
      console.error(error.stack);
    }

    try {
      await mongoose.disconnect();
    } catch (disconnectError) {
      // ignore disconnect errors during failure handling
    }

    process.exit(1);
  }
}

run();
