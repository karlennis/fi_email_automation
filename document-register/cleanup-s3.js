#!/usr/bin/env node
/**
 * S3 Cleanup Tool
 * Removes projects from S3 that are not in the approved ID list
 *
 * Usage:
 *   node cleanup-s3.js --dry-run          # Preview what would be deleted
 *   node cleanup-s3.js --execute          # Actually delete the projects
 *   node cleanup-s3.js --stats            # Show statistics only
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const AWS = require('aws-sdk');
const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const readline = require('readline');

class S3CleanupService {
  constructor() {
    this.s3 = new AWS.S3({
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      region: process.env.AWS_REGION || 'eu-north-1',
      httpOptions: { timeout: 120000, connectTimeout: 10000 },
      maxRetries: 3
    });
    this.bucket = process.env.S3_BUCKET || 'planning-documents-2';
    this.approvedIds = new Set();
    this.csvPath = path.join(__dirname, '2025_ids.csv');
  }

  async loadApprovedIds() {
    console.log('📋 Loading approved project IDs...');
    console.log(`   Reading: ${this.csvPath}`);

    if (!fs.existsSync(this.csvPath)) {
      throw new Error(`CSV file not found: ${this.csvPath}`);
    }

    return new Promise((resolve, reject) => {
      const ids = new Set();
      let count = 0;

      fs.createReadStream(this.csvPath)
        .pipe(csv())
        .on('data', (row) => {
          // Try common column names
          const id = row.planning_id || row.planning_ids || row.project_id ||
                     row.id || row.ID || row['planning_id'] || row['Planning ID'];

          if (id) {
            const cleanId = String(id).trim();
            if (cleanId && cleanId !== '' && cleanId !== 'planning_id') {
              ids.add(cleanId);
              count++;
            }
          }
        })
        .on('end', () => {
          console.log(`✅ Loaded ${count.toLocaleString()} approved project IDs`);
          this.approvedIds = ids;
          resolve(ids);
        })
        .on('error', reject);
    });
  }

  async scanS3Projects() {
    console.log('\n🔍 Scanning S3 for all projects...');
    console.log(`   Bucket: ${this.bucket}`);
    console.log(`   Prefix: planning-docs/`);

    const allProjects = new Set();
    let continuationToken = null;
    let objectCount = 0;

    do {
      const params = {
        Bucket: this.bucket,
        Prefix: 'planning-docs/',
        Delimiter: '/',
        MaxKeys: 1000
      };

      if (continuationToken) {
        params.ContinuationToken = continuationToken;
      }

      try {
        const response = await this.s3.listObjectsV2(params).promise();

        // Process common prefixes (folders)
        if (response.CommonPrefixes) {
          response.CommonPrefixes.forEach(prefix => {
            const match = prefix.Prefix.match(/^planning-docs\/([^\/]+)\//);
            if (match) {
              allProjects.add(match[1]);
            }
          });
        }

        objectCount += (response.CommonPrefixes || []).length;
        continuationToken = response.IsTruncated ? response.NextContinuationToken : null;

        if (objectCount % 10000 === 0 && objectCount > 0) {
          console.log(`   Scanned ${objectCount.toLocaleString()} folders... Found ${allProjects.size.toLocaleString()} projects`);
        }
      } catch (error) {
        console.error('❌ S3 API error:', error.message);
        throw error;
      }
    } while (continuationToken);

    console.log(`✅ Found ${allProjects.size.toLocaleString()} total projects in S3`);
    return allProjects;
  }

  async analyzeProjects() {
    console.log('\n📊 Analyzing projects...');

    const s3Projects = await this.scanS3Projects();
    const toDelete = new Set();
    const toKeep = new Set();

    for (const projectId of s3Projects) {
      if (this.approvedIds.has(projectId)) {
        toKeep.add(projectId);
      } else {
        toDelete.add(projectId);
      }
    }

    // Check for approved IDs not in S3
    const notInS3 = new Set();
    for (const approvedId of this.approvedIds) {
      if (!s3Projects.has(approvedId)) {
        notInS3.add(approvedId);
      }
    }

    const stats = {
      totalInS3: s3Projects.size,
      approvedCount: this.approvedIds.size,
      toKeep: toKeep.size,
      toDelete: toDelete.size,
      notInS3: notInS3.size,
      toDeleteList: Array.from(toDelete).sort(),
      notInS3List: Array.from(notInS3).sort()
    };

    return stats;
  }

  async countDocumentsInProject(projectId) {
    let count = 0;
    let continuationToken = null;

    do {
      const params = {
        Bucket: this.bucket,
        Prefix: `planning-docs/${projectId}/`,
        MaxKeys: 1000
      };

      if (continuationToken) {
        params.ContinuationToken = continuationToken;
      }

      const response = await this.s3.listObjectsV2(params).promise();
      count += (response.Contents || []).length;
      continuationToken = response.IsTruncated ? response.NextContinuationToken : null;
    } while (continuationToken);

    return count;
  }

  async deleteProject(projectId) {
    console.log(`   🗑️  Deleting project: ${projectId}`);

    let deletedCount = 0;
    let continuationToken = null;

    do {
      // List objects in the project folder
      const listParams = {
        Bucket: this.bucket,
        Prefix: `planning-docs/${projectId}/`,
        MaxKeys: 1000
      };

      if (continuationToken) {
        listParams.ContinuationToken = continuationToken;
      }

      const listResponse = await this.s3.listObjectsV2(listParams).promise();

      if (listResponse.Contents && listResponse.Contents.length > 0) {
        // Delete objects in batches
        const deleteParams = {
          Bucket: this.bucket,
          Delete: {
            Objects: listResponse.Contents.map(obj => ({ Key: obj.Key })),
            Quiet: true
          }
        };

        await this.s3.deleteObjects(deleteParams).promise();
        deletedCount += listResponse.Contents.length;
      }

      continuationToken = listResponse.IsTruncated ? listResponse.NextContinuationToken : null;
    } while (continuationToken);

    return deletedCount;
  }

  async executeCleanup(stats, confirmationRequired = true) {
    console.log('\n⚠️  DELETION MODE ACTIVATED');
    console.log('═══════════════════════════════════════════════════');
    console.log(`   Projects to delete: ${stats.toDelete.toLocaleString()}`);
    console.log(`   Projects to keep: ${stats.toKeep.toLocaleString()}`);
    console.log('═══════════════════════════════════════════════════');

    if (stats.toDelete === 0) {
      console.log('\n✅ No projects to delete. S3 is clean!');
      return { deleted: 0, errors: 0 };
    }

    if (confirmationRequired) {
      console.log('\n⚠️  WARNING: This will PERMANENTLY DELETE data from S3!');
      console.log('   This action CANNOT be undone.');
      console.log('\n   Type "DELETE" to confirm, or anything else to cancel:');

      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
      });

      const confirmation = await new Promise(resolve => {
        rl.question('   > ', answer => {
          rl.close();
          resolve(answer);
        });
      });

      if (confirmation !== 'DELETE') {
        console.log('\n❌ Deletion cancelled by user');
        return { deleted: 0, errors: 0, cancelled: true };
      }
    }

    console.log('\n🚀 Starting deletion process...\n');

    let deletedProjects = 0;
    let deletedFiles = 0;
    let errors = 0;
    const startTime = Date.now();

    // Process deletions in parallel batches for speed
    const batchSize = 50; // Delete 50 projects in parallel
    const projectsToDelete = stats.toDeleteList;

    for (let i = 0; i < projectsToDelete.length; i += batchSize) {
      const batch = projectsToDelete.slice(i, i + batchSize);

      // Delete batch in parallel
      const results = await Promise.allSettled(
        batch.map(projectId => this.deleteProject(projectId))
      );

      // Process results
      for (let j = 0; j < results.length; j++) {
        const result = results[j];
        const projectId = batch[j];

        if (result.status === 'fulfilled') {
          deletedProjects++;
          deletedFiles += result.value;
        } else {
          errors++;
          console.error(`   ❌ Error deleting ${projectId}: ${result.reason?.message || result.reason}`);
        }
      }

      // Show progress
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const rate = (deletedProjects / elapsed).toFixed(1);
      console.log(`   Progress: ${deletedProjects.toLocaleString()}/${stats.toDelete.toLocaleString()} projects (${rate} proj/s)`);
    }

    const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log('\n✅ Deletion complete!');
    console.log(`   Projects deleted: ${deletedProjects.toLocaleString()}`);
    console.log(`   Files deleted: ${deletedFiles.toLocaleString()}`);
    console.log(`   Errors: ${errors}`);
    console.log(`   Time: ${totalTime}s`);

    return { deleted: deletedProjects, files: deletedFiles, errors };
  }

  printStats(stats) {
    console.log('\n📊 CLEANUP ANALYSIS');
    console.log('═══════════════════════════════════════════════════');
    console.log(`   Total projects in S3:        ${stats.totalInS3.toLocaleString()}`);
    console.log(`   Approved IDs in CSV:         ${stats.approvedCount.toLocaleString()}`);
    console.log('');
    console.log(`   ✅ Projects to KEEP:         ${stats.toKeep.toLocaleString()}`);
    console.log(`   🗑️  Projects to DELETE:      ${stats.toDelete.toLocaleString()}`);
    console.log('');
    console.log(`   ⚠️  Approved IDs not in S3:  ${stats.notInS3.toLocaleString()}`);
    console.log('═══════════════════════════════════════════════════');

    if (stats.toDelete > 0) {
      console.log('\n🗑️  Projects marked for deletion (first 20):');
      stats.toDeleteList.slice(0, 20).forEach((id, idx) => {
        console.log(`   ${idx + 1}. ${id}`);
      });
      if (stats.toDelete > 20) {
        console.log(`   ... and ${stats.toDelete - 20} more`);
      }
    }

    if (stats.notInS3.size > 0 && stats.notInS3.size <= 50) {
      console.log('\n⚠️  Approved IDs not found in S3:');
      stats.notInS3List.forEach((id, idx) => {
        console.log(`   ${idx + 1}. ${id}`);
      });
    } else if (stats.notInS3.size > 50) {
      console.log(`\n⚠️  ${stats.notInS3.size} approved IDs not found in S3 (list too long to display)`);
    }
  }

  async exportDeletionList(stats) {
    const outputPath = path.join(__dirname, 'deletion-list.txt');
    const content = [
      'S3 Cleanup - Projects to be Deleted',
      `Generated: ${new Date().toISOString()}`,
      `Total: ${stats.toDelete.toLocaleString()} projects`,
      '',
      'Project IDs:',
      ...stats.toDeleteList
    ].join('\n');

    fs.writeFileSync(outputPath, content);
    console.log(`\n💾 Deletion list exported: ${outputPath}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const mode = args[0] || '--help';

  console.log('🧹 S3 CLEANUP TOOL');
  console.log('═══════════════════════════════════════════════════\n');

  if (mode === '--help' || mode === '-h') {
    console.log('Usage:');
    console.log('  node cleanup-s3.js --dry-run     Preview what would be deleted');
    console.log('  node cleanup-s3.js --execute     Actually delete the projects');
    console.log('  node cleanup-s3.js --stats       Show statistics only');
    console.log('  node cleanup-s3.js --export      Export deletion list to file');
    console.log('');
    console.log('Required:');
    console.log('  - 2025_ids.csv file in document-register/ folder');
    console.log('  - CSV must have "planning_id" column');
    console.log('  - AWS credentials in .env file');
    return;
  }

  try {
    const cleanup = new S3CleanupService();

    await cleanup.loadApprovedIds();
    const stats = await cleanup.analyzeProjects();

    cleanup.printStats(stats);

    if (mode === '--dry-run') {
      console.log('\n✅ DRY RUN COMPLETE (no changes made)');
      console.log('   Run with --execute to actually delete projects');
      await cleanup.exportDeletionList(stats);
    } else if (mode === '--stats') {
      console.log('\n✅ STATISTICS COMPLETE');
    } else if (mode === '--export') {
      await cleanup.exportDeletionList(stats);
      console.log('✅ EXPORT COMPLETE');
    } else if (mode === '--execute') {
      const result = await cleanup.executeCleanup(stats, true);

      if (!result.cancelled) {
        console.log('\n🎉 CLEANUP COMPLETE');
        console.log('   Your S3 bucket now only contains approved projects.');
      }
    } else {
      console.log(`\n❌ Unknown mode: ${mode}`);
      console.log('   Use --help to see available options');
    }

  } catch (error) {
    console.error('\n❌ ERROR:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  main();
}

module.exports = S3CleanupService;
