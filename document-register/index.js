#!/usr/bin/env node
/**
 * Document Register CLI
 * Command-line interface for document register and ingestion operations
 */

// Load environment variables
require('dotenv').config({ path: require('path').join(__dirname, '../backend/.env') });

const documentRegisterService = require('../backend/services/documentRegisterService');
const documentIngestionService = require('../backend/services/documentIngestionService');
const s3Service = require('../backend/services/s3Service');
const logger = require('../backend/utils/logger');

const command = process.argv[2];
const arg1 = process.argv[3];

async function main() {
  console.log('📋 Document Register CLI\n');

  switch (command) {
    case 'generate':
    case 'scan':
      await generateRegister();
      break;

    case 'count':
      await showCount();
      break;

    case 'projects':
      await showProjects();
      break;

    case 'status':
      await showStatus();
      break;

    case 'stats':
      await showStats();
      break;

    case 'all-projects':
    case 'export-all':
      await exportAllProjectIds();
      break;

    // === INGESTION COMMANDS ===
    case 'route':
      await routeDocuments(arg1);
      break;

    case 'staged':
    case 'filter-docs':
      await showStagedProjects();
      break;

    case 'baseline-status':
    case 'baselines':
      await showBaselineStatus();
      break;

    case 'cleanup-baselines':
      await cleanupBaselines();
      break;

    case 'check-baseline':
      await checkBaseline(arg1);
      break;

    case 'cleanup-disk':
    case 'clear-temp':
      await cleanupDisk();
      break;

    case 'help':
    default:
      showHelp();
      break;
  }
}

async function generateRegister() {
  try {
    console.log('🚀 Generating document register...\n');

    const result = await documentRegisterService.generateRegister();

    console.log('\n✅ Document Register Generated Successfully!\n');
    console.log(`📊 Statistics:`);
    console.log(`   Total Documents: ${result.totalDocuments}`);
    console.log(`   Total Projects: ${result.totalProjects}`);
    console.log(`   Processing Time: ${(result.processingTime / 1000).toFixed(2)}s`);
    console.log(`\n📁 Output Files:`);
    console.log(`   CSV:  ${result.outputs.csv}`);
    console.log(`   XLSX: ${result.outputs.xlsx}`);
    console.log(`   Meta: ${result.outputs.metadata}`);

    if (result.topProjects && result.topProjects.length > 0) {
      console.log(`\n📈 Top 10 Most Recently Updated Projects:`);
      result.topProjects.forEach((project, index) => {
        const date = new Date(project.lastUpdated).toLocaleDateString();
        console.log(`   ${index + 1}. ${project.projectId} - ${project.documentCount} docs (Updated: ${date})`);
      });
    }

    console.log('\n');
  } catch (error) {
    console.error('❌ Error generating register:', error.message);
    process.exit(1);
  }
}

async function showStatus() {
  try {
    const metadata = documentRegisterService.loadMetadata();

    if (!metadata.lastScanDate) {
      console.log('ℹ️  No document register found. Run "generate" to create one.\n');
      return;
    }

    console.log('📊 Document Register Status:\n');
    console.log(`   Last Scan: ${new Date(metadata.lastScanDate).toLocaleString()}`);
    console.log(`   Total Documents: ${metadata.totalDocuments}`);
    console.log(`   Total Projects: ${metadata.totalProjects}`);
    console.log(`   Processing Time: ${(metadata.processingTimeMs / 1000).toFixed(2)}s`);
    console.log('\n');
  } catch (error) {
    console.error('❌ Error getting status:', error.message);
    process.exit(1);
  }
}

async function showStats() {
  try {
    const metadata = documentRegisterService.loadMetadata();

    if (!metadata.lastScanDate) {
      console.log('ℹ️  No document register found. Run "generate" to create one.\n');
      return;
    }

    console.log('📊 Document Register Statistics:\n');
    console.log(`   Last Scan: ${new Date(metadata.lastScanDate).toLocaleString()}`);
    console.log(`   Total Documents: ${metadata.totalDocuments}`);
    console.log(`   Total Projects: ${metadata.totalProjects}`);

    // Top projects by update
    const topProjects = Object.entries(metadata.documentsByProject || {})
      .map(([projectId, stats]) => ({
        projectId,
        documentCount: stats.documentCount,
        lastUpdated: stats.lastUpdated,
        mostRecentDocument: stats.mostRecentDocument
      }))
      .sort((a, b) => new Date(b.lastUpdated) - new Date(a.lastUpdated))
      .slice(0, 20);

    console.log(`\n📈 Top 20 Most Recently Updated Projects:`);
    topProjects.forEach((project, index) => {
      const date = new Date(project.lastUpdated).toLocaleDateString();
      const time = new Date(project.lastUpdated).toLocaleTimeString();
      console.log(`   ${index + 1}. ${project.projectId}`);
      console.log(`      Documents: ${project.documentCount}`);
      console.log(`      Last Updated: ${date} ${time}`);
      console.log(`      Recent File: ${project.mostRecentDocument}`);
      console.log('');
    });

  } catch (error) {
    console.error('❌ Error getting statistics:', error.message);
    process.exit(1);
  }
}

async function showProjects() {
  try {
    console.log('📁 Listing first 50 projects (most recent first) in planning-docs...\n');

    const projects = await documentRegisterService.getFirst50Projects();

    console.log('✅ Projects Retrieved!\n');
    console.log(`📊 Showing first ${projects.length} projects (sorted by most recent documents):\n`);

    // Create comma-separated list
    const projectIds = projects.map(project => project.projectId);
    console.log('📋 Project IDs (comma-separated):');
    console.log(projectIds.join(', '));
    console.log('\n');

    // Also show detailed list
    console.log('📋 Detailed Project List:\n');
    projects.forEach((project, index) => {
      console.log(`   ${(index + 1).toString().padStart(2, ' ')}. ${project.projectId}`);
      if (project.documentCount !== undefined) {
        console.log(`       📄 ${project.documentCount} documents`);
      }
      if (project.lastUpdated) {
        const date = new Date(project.lastUpdated).toLocaleDateString();
        const time = new Date(project.lastUpdated).toLocaleTimeString();
        console.log(`       📅 Last updated: ${date} ${time}`);
      }
      console.log('');
    });

    console.log(`💡 Total projects found: ${projects.length}`);
    console.log('\n');
  } catch (error) {
    console.error('❌ Error listing projects:', error.message);
    process.exit(1);
  }
}

async function showCount() {
  try {
    console.log('🔢 Counting projects and documents in planning-docs...\n');

    const count = await documentRegisterService.getQuickCount();

    console.log('\n✅ Count Complete!\n');
    console.log(`📊 Totals:`);
    console.log(`   Projects:  ${count.totalProjects.toLocaleString()}`);
    console.log(`   Documents: ${count.totalDocuments.toLocaleString()}`);
    console.log(`   Average:   ${count.averageDocsPerProject} documents per project`);
    console.log('\n');
  } catch (error) {
    console.error('❌ Error counting:', error.message);
    process.exit(1);
  }
}

async function exportAllProjectIds() {
  try {
    console.log('🚀 Exporting ALL project IDs from AWS...\n');
    console.log('⏳ This may take a few minutes (full S3 scan)...\n');

    const result = await documentRegisterService.getAllProjectIdsAndExport();

    console.log('\n✅ Export Complete!\n');
    console.log(`📊 Statistics:`);
    console.log(`   Total Projects:  ${result.totalProjects.toLocaleString()}`);
    console.log(`   Total Documents: ${result.totalDocuments.toLocaleString()}`);
    console.log(`   Pages Scanned:   ${result.scanStats.pagesScanned}`);
    console.log(`   Objects Scanned: ${result.scanStats.objectsScanned.toLocaleString()}`);
    console.log(`\n📁 Output Files:`);
    console.log(`   Simple CSV: ${result.csvFile}`);
    console.log(`   Detailed:   ${result.detailedCsvFile}`);
    console.log('\n✨ Files ready for import into spreadsheet applications!\n');
  } catch (error) {
    console.error('❌ Error exporting projects:', error.message);
    process.exit(1);
  }
}

// ============================================
// INGESTION COMMANDS
// ============================================

async function routeDocuments(projectId) {
  try {
    if (projectId) {
      // Route a specific project
      console.log(`🔄 Routing project ${projectId} from filter-docs to planning-docs...\n`);

      const result = await documentIngestionService.routeToPlanning(projectId);

      console.log('\n✅ Routing Complete!\n');
      console.log(`📊 Results:`);
      console.log(`   Project: ${result.projectId}`);
      console.log(`   Status: ${result.isNewProject ? 'NEW (baselined)' : 'EXISTING (merged)'}`);
      console.log(`   Documents Copied: ${result.documentsCopied}`);
      console.log(`   Documents Skipped: ${result.documentsSkipped}`);
      
      if (result.newDocuments.length > 0) {
        console.log(`\n📄 New Documents:`);
        result.newDocuments.slice(0, 10).forEach(doc => console.log(`   - ${doc}`));
        if (result.newDocuments.length > 10) {
          console.log(`   ... and ${result.newDocuments.length - 10} more`);
        }
      }

      if (result.errors.length > 0) {
        console.log(`\n⚠️ Errors:`);
        result.errors.forEach(err => console.log(`   - ${err.fileName || err.error}`));
      }

      // Cleanup filter-docs for this project
      if (result.errors.length === 0) {
        console.log(`\n🧹 Cleaning up filter-docs/${projectId}...`);
        const cleanup = await documentIngestionService.cleanupFilterDocs(projectId);
        console.log(`   Deleted ${cleanup.deleted} files`);
      }

    } else {
      // Route all projects in filter-docs
      console.log('🔄 Routing ALL projects from filter-docs to planning-docs...\n');

      const stagedProjects = await documentIngestionService.listStagedProjects();

      if (stagedProjects.length === 0) {
        console.log('📭 No projects found in filter-docs staging area');
        return;
      }

      console.log(`📦 Found ${stagedProjects.length} projects to route\n`);

      const results = await documentIngestionService.batchRouteToPlanning(stagedProjects);

      console.log('\n✅ Batch Routing Complete!\n');
      console.log(`📊 Results:`);
      console.log(`   Total Projects: ${results.total}`);
      console.log(`   Successful: ${results.successful}`);
      console.log(`   Failed: ${results.failed}`);
      console.log(`   New Projects (baselined): ${results.newProjects}`);
      console.log(`   Existing Projects (merged): ${results.existingProjects}`);
      console.log(`   Total Documents Routed: ${results.totalDocumentsRouted}`);
      console.log(`\n📈 FI Scan Eligibility:`);
      console.log(`   Skipping FI scan (baselined): ${results.docsSkippingFIScan || 0} docs`);
      console.log(`   Eligible for FI scan (new on existing): ${results.docsEligibleForFIScan || 0} docs`);

      // Cleanup filter-docs for successful projects
      const successfulProjects = results.projectResults
        .filter(r => !r.error && r.errors?.length === 0)
        .map(r => r.projectId);

      if (successfulProjects.length > 0) {
        console.log(`\n🧹 Cleaning up ${successfulProjects.length} projects from filter-docs...`);
        let totalDeleted = 0;
        for (const pid of successfulProjects) {
          try {
            const cleanup = await documentIngestionService.cleanupFilterDocs(pid);
            totalDeleted += cleanup.deleted;
          } catch (err) {
            console.error(`   ⚠️ Failed to cleanup ${pid}: ${err.message}`);
          }
        }
        console.log(`   ✅ Deleted ${totalDeleted} files total`);
      }
    }

    console.log('\n');
  } catch (error) {
    console.error('❌ Error routing documents:', error.message);
    process.exit(1);
  }
}

async function showStagedProjects() {
  try {
    console.log('📦 Listing projects in filter-docs staging area...\n');

    const projects = await documentIngestionService.listStagedProjects();

    if (projects.length === 0) {
      console.log('📭 No projects found in filter-docs');
      return;
    }

    console.log(`✅ Found ${projects.length} staged projects:\n`);
    
    // Show first 50
    const showCount = Math.min(projects.length, 50);
    console.log(projects.slice(0, showCount).join(', '));
    
    if (projects.length > 50) {
      console.log(`\n... and ${projects.length - 50} more`);
    }

    console.log('\n');
  } catch (error) {
    console.error('❌ Error listing staged projects:', error.message);
    process.exit(1);
  }
}

async function showBaselineStatus() {
  try {
    console.log('📌 Checking baseline marker status...\n');

    const summary = await documentIngestionService.getBaselinedProjectsSummary();

    console.log(`📅 Date: ${summary.date}\n`);
    console.log(`📊 Baselined Today: ${summary.baselinedTodayCount} projects`);
    
    if (summary.baselinedTodaySample.length > 0) {
      console.log('\n📋 Sample of baselined projects:');
      summary.baselinedTodaySample.forEach(id => console.log(`   - ${id}`));
    }

    if (summary.note) {
      console.log(`\nℹ️  ${summary.note}`);
    }

    console.log('\n');
  } catch (error) {
    console.error('❌ Error checking baseline status:', error.message);
    process.exit(1);
  }
}

async function cleanupBaselines() {
  try {
    console.log('🧹 Cleaning up old baseline markers...\n');

    const result = await s3Service.cleanupOldBaselineMarkers(1);

    console.log(`✅ Cleanup Complete!\n`);
    console.log(`   Markers Removed: ${result.deleted}`);
    console.log('\n');
  } catch (error) {
    console.error('❌ Error cleaning up baselines:', error.message);
    process.exit(1);
  }
}

async function checkBaseline(projectId) {
  if (!projectId) {
    console.error('❌ Please provide a project ID: node index.js check-baseline <projectId>');
    process.exit(1);
  }

  try {
    console.log(`📌 Checking baseline status for project ${projectId}...\n`);

    const hasBaseline = await s3Service.hasBaselineMarker(projectId);
    const markers = await s3Service.getBaselineMarkers(projectId);

    console.log(`📊 Results:`);
    console.log(`   Has Today's Baseline: ${hasBaseline ? 'YES (will skip FI scan)' : 'NO (eligible for FI scan)'}`);
    
    if (markers.length > 0) {
      console.log(`\n📋 All Baseline Markers:`);
      markers.forEach(m => console.log(`   - ${m.date} (${m.key})`));
    } else {
      console.log('\n   No baseline markers found for this project');
    }

    console.log('\n');
  } catch (error) {
    console.error('❌ Error checking baseline:', error.message);
    process.exit(1);
  }
}

async function cleanupDisk() {
  try {
    console.log('🧹 Running disk cleanup...\n');

    const diskCleanupService = require('../backend/services/diskCleanupService');
    
    // Get stats before
    const beforeStats = await diskCleanupService.getDiskStats();
    console.log(`📊 Before cleanup:`);
    console.log(`   Temp files: ${beforeStats.tempFiles} (${beforeStats.tempSizeMB}MB)`);
    console.log(`   Log files: ${beforeStats.logSizeMB}MB\n`);

    // Force cleanup
    await diskCleanupService.forceCleanup();

    // Get stats after
    const afterStats = await diskCleanupService.getDiskStats();
    console.log(`\n📊 After cleanup:`);
    console.log(`   Temp files: ${afterStats.tempFiles} (${afterStats.tempSizeMB}MB)`);
    console.log(`   Log files: ${afterStats.logSizeMB}MB`);

    console.log('\n✅ Cleanup complete!\n');
  } catch (error) {
    console.error('❌ Error during cleanup:', error.message);
    process.exit(1);
  }
}

function showHelp() {
  console.log('Usage: node index.js [command] [options]\n');
  
  console.log('📋 DOCUMENT REGISTER COMMANDS:');
  console.log('  generate, scan  - Generate document register (scan all projects)');
  console.log('  count           - Quick count of projects and documents');
  console.log('  projects        - List first 50 projects with details');
  console.log('  all-projects    - Export ALL project IDs to CSV (full S3 scan)');
  console.log('  export-all      - Alias for all-projects');
  console.log('  status          - Show current register status');
  console.log('  stats           - Show detailed statistics');
  
  console.log('\n📦 INGESTION COMMANDS:');
  console.log('  route           - Route ALL projects from filter-docs to planning-docs');
  console.log('  route <id>      - Route a specific project');
  console.log('  staged          - List projects in filter-docs staging area');
  console.log('  filter-docs     - Alias for staged');
  console.log('  baseline-status - Show projects with baseline markers (skipped in FI scan)');
  console.log('  baselines       - Alias for baseline-status');
  console.log('  check-baseline <id> - Check baseline status for a specific project');
  console.log('  cleanup-baselines   - Remove old baseline markers');
  
  console.log('\n🧹 MAINTENANCE COMMANDS:');
  console.log('  cleanup-disk    - Clear temp files and truncate large logs');
  console.log('  clear-temp      - Alias for cleanup-disk');
  
  console.log('\n📝 EXAMPLES:');
  console.log('  node index.js count');
  console.log('  node index.js route');
  console.log('  node index.js route 390721');
  console.log('  node index.js staged');
  console.log('  node index.js baseline-status');
  console.log('  node index.js check-baseline 390721');
  console.log('  node index.js cleanup-disk');
  console.log('\n');
}

// Run CLI
main().catch(error => {
  console.error('❌ Fatal error:', error.message);
  process.exit(1);
});
