#!/usr/bin/env node
/**
 * Document Register CLI
 * Command-line interface for document register operations
 */

// Load environment variables
require('dotenv').config({ path: require('path').join(__dirname, '../backend/.env') });

const documentRegisterService = require('../backend/services/documentRegisterService');
const logger = require('../backend/utils/logger');

const command = process.argv[2];

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

function showHelp() {
  console.log('Usage: node index.js [command]\n');
  console.log('Commands:');
  console.log('  generate, scan  - Generate document register (scan all projects)');
  console.log('  count           - Quick count of projects and documents');
  console.log('  projects        - List first 50 projects with details');
  console.log('  all-projects    - Export ALL project IDs to CSV (full S3 scan)');
  console.log('  export-all      - Alias for all-projects');
  console.log('  status          - Show current register status');
  console.log('  stats           - Show detailed statistics');
  console.log('  help            - Show this help message');
  console.log('\nExamples:');
  console.log('  node index.js count');
  console.log('  node index.js projects');
  console.log('  node index.js all-projects');
  console.log('  node index.js generate');
  console.log('  node index.js status');
  console.log('  node index.js stats');
  console.log('\n');
}

// Run CLI
main().catch(error => {
  console.error('❌ Fatal error:', error.message);
  process.exit(1);
});
