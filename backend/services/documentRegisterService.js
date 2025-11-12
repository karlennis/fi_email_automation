const path = require('path');
const fs = require('fs');
const logger = require('../utils/logger');

class DocumentRegisterService {
  constructor() {
    this.outputDir = path.join(__dirname, 'outputs');
    this.metadataFile = path.join(this.outputDir, 'register-metadata.json');
    this.csvFile = path.join(this.outputDir, 'document-register.csv');
    this.xlsxFile = path.join(this.outputDir, 'document-register.xlsx');
    this.ensureOutputDir();
  }

  ensureOutputDir() {
    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true });
      logger.info(`📁 Created output directory: ${this.outputDir}`);
    }
  }

  formatFileSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  async getQuickCount() {
    try {
      logger.info('📊 Getting quick count of projects and documents...');
      logger.info('⚡ Using optimized single-scan method');
      logger.info('📄 Counting ALL file types (not just PDFs)');

      const AWS = require('aws-sdk');
      const s3 = new AWS.S3({
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        region: process.env.AWS_REGION || 'eu-north-1',
        httpOptions: { timeout: 120000, connectTimeout: 10000 },
        maxRetries: 3
      });
      const bucket = process.env.S3_BUCKET || 'planning-documents-2';

      let totalDocuments = 0;
      const projectDocs = new Map();
      let continuationToken = null;
      let objectsScanned = 0;

      logger.info('🔍 Scanning all objects in planning-docs/...');

      do {
        const params = {
          Bucket: bucket,
          Prefix: 'planning-docs/',
          MaxKeys: 1000
        };
        if (continuationToken) {
          params.ContinuationToken = continuationToken;
        }

        try {
          const response = await s3.listObjectsV2(params).promise();
          if (response.Contents) {
            response.Contents.forEach(obj => {
              objectsScanned++;
              const match = obj.Key.match(/^planning-docs\/([^\/]+)\/(.+)$/);
              if (match) {
                const projectId = match[1];
                const fileName = match[2];
                if (fileName && !fileName.endsWith('/') && !fileName.startsWith('.')) {
                  totalDocuments++;
                  projectDocs.set(projectId, (projectDocs.get(projectId) || 0) + 1);
                } else if (!projectDocs.has(projectId)) {
                  projectDocs.set(projectId, 0);
                }
              }
            });
          }
          continuationToken = response.IsTruncated ? response.NextContinuationToken : null;
          if (objectsScanned % 10000 === 0) {
            logger.info(`   Scanned ${objectsScanned.toLocaleString()} objects... (${totalDocuments.toLocaleString()} documents across ${projectDocs.size.toLocaleString()} projects)`);
          }
        } catch (error) {
          logger.error('S3 API error:', error.message);
          if (error.retryable || error.code === 'TimeoutError') {
            logger.warn('Timeout detected, retrying...');
            await new Promise(resolve => setTimeout(resolve, 2000));
            continue;
          }
          throw error;
        }
      } while (continuationToken);

      const result = {
        totalProjects: projectDocs.size,
        totalDocuments: totalDocuments,
        averageDocsPerProject: projectDocs.size > 0 ? (totalDocuments / projectDocs.size).toFixed(2) : 0,
        totalObjectsScanned: objectsScanned
      };

      logger.info(`✅ Count complete!`);
      logger.info(`   📊 Scanned ${objectsScanned.toLocaleString()} objects`);
      logger.info(`   📁 Found ${result.totalProjects.toLocaleString()} projects`);
      logger.info(`   📄 Found ${totalDocuments.toLocaleString()} documents (ALL file types)`);
      logger.info(`   📈 Average: ${result.averageDocsPerProject} docs/project`);

      return result;
    } catch (error) {
      logger.error('❌ Error getting quick count:', error);
      throw error;
    }
  }

  async scanAllDocuments() {
    const startTime = Date.now();
    logger.info('🔍 Starting document register scan...');
    logger.info('⚡ Single recursive S3 scan for maximum performance');

    try {
      const AWS = require('aws-sdk');
      const s3 = new AWS.S3({
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        region: process.env.AWS_REGION || 'eu-north-1',
        httpOptions: { timeout: 120000, connectTimeout: 10000 },
        maxRetries: 3
      });
      const bucket = process.env.S3_BUCKET || 'planning-documents-2';

      const allDocuments = [];
      const projectStats = {};
      let continuationToken = null;
      let objectsScanned = 0;
      let documentsFound = 0;

      logger.info('📊 Scanning planning-docs/...');

      do {
        const params = {
          Bucket: bucket,
          Prefix: 'planning-docs/',
          MaxKeys: 1000
        };
        if (continuationToken) {
          params.ContinuationToken = continuationToken;
        }

        try {
          const response = await s3.listObjectsV2(params).promise();
          if (response.Contents) {
            response.Contents.forEach(obj => {
              objectsScanned++;
              const match = obj.Key.match(/^planning-docs\/([^\/]+)\/(.+)$/);
              if (match) {
                const projectId = match[1];
                const fileName = match[2];
                if (fileName && !fileName.endsWith('/') && !fileName.startsWith('.')) {
                  allDocuments.push({
                    projectId: projectId,
                    fileName: fileName,
                    filePath: obj.Key,
                    lastModified: obj.LastModified,
                    lastModifiedISO: new Date(obj.LastModified).toISOString()
                  });
                  documentsFound++;
                  if (!projectStats[projectId]) {
                    projectStats[projectId] = { documentCount: 0, lastUpdated: null };
                  }
                  projectStats[projectId].documentCount++;
                  if (!projectStats[projectId].lastUpdated || new Date(obj.LastModified) > new Date(projectStats[projectId].lastUpdated)) {
                    projectStats[projectId].lastUpdated = obj.LastModified;
                  }
                }
              }
            });
          }
          continuationToken = response.IsTruncated ? response.NextContinuationToken : null;
          if (objectsScanned % 10000 === 0) {
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
            const rate = (objectsScanned / elapsed).toFixed(0);
            logger.info(`   📊 ${objectsScanned.toLocaleString()} objects in ${elapsed}s (${rate} obj/s) - ${Object.keys(projectStats).length.toLocaleString()} projects, ${documentsFound.toLocaleString()} docs`);
          }
        } catch (error) {
          logger.error('S3 API error:', error.message);
          if (error.retryable || error.code === 'TimeoutError') {
            logger.warn('⚠️  Timeout, waiting 3s...');
            await new Promise(resolve => setTimeout(resolve, 3000));
            continue;
          }
          throw error;
        }
      } while (continuationToken);

      logger.info('🔄 Sorting by last modified (newest first)...');
      allDocuments.sort((a, b) => new Date(b.lastModified) - new Date(a.lastModified));

      const processingTime = Date.now() - startTime;
      const projectCount = Object.keys(projectStats).length;

      logger.info(`✅ Scan complete!`);
      logger.info(`   📊 Scanned ${objectsScanned.toLocaleString()} objects`);
      logger.info(`   📁 Found ${projectCount.toLocaleString()} projects`);
      logger.info(`   📄 Found ${allDocuments.length.toLocaleString()} documents`);
      logger.info(`   ⏱️  Time: ${(processingTime / 1000 / 60).toFixed(1)} minutes`);
      logger.info(`   ⚡ ${(objectsScanned / (processingTime / 1000)).toFixed(0)} objects/second`);

      const metadata = {
        lastScanDate: new Date().toISOString(),
        totalProjects: projectCount,
        totalDocuments: allDocuments.length,
        totalObjectsScanned: objectsScanned,
        processingTimeMs: processingTime,
        processingTimeMinutes: (processingTime / 1000 / 60).toFixed(1),
        documentsByProject: projectStats
      };
      this.saveMetadata(metadata);

      return { documents: allDocuments, metadata, projectStats };
    } catch (error) {
      logger.error('❌ Error scanning documents:', error);
      throw error;
    }
  }

  async exportToCSV(documents) {
    logger.info('📄 Exporting to CSV...');

    const headers = ['Project ID', 'File Name', 'File Path', 'Last Modified'];
    let csvContent = headers.join(',') + '\n';

    documents.forEach(doc => {
      const row = [
        doc.projectId,
        `"${doc.fileName.replace(/"/g, '""')}"`,
        doc.filePath,
        doc.lastModifiedISO
      ];
      csvContent += row.join(',') + '\n';
    });

    fs.writeFileSync(this.csvFile, csvContent);
    logger.info(`✅ CSV exported: ${this.csvFile}`);

    const fileSize = fs.statSync(this.csvFile).size;
    logger.info(`   📊 File size: ${this.formatFileSize(fileSize)}`);

    return this.csvFile;
  }

  async exportToXLSX(documents, metadata) {
    logger.info('📊 Exporting to XLSX...');

    try {
      const XLSX = require('xlsx');
      const wb = XLSX.utils.book_new();

      // Main register sheet - simplified columns
      const wsData = [['Project ID', 'File Name', 'File Path', 'Last Modified']];
      documents.forEach(doc => {
        wsData.push([doc.projectId, doc.fileName, doc.filePath, doc.lastModifiedISO]);
      });
      const ws = XLSX.utils.aoa_to_sheet(wsData);
      XLSX.utils.book_append_sheet(wb, ws, 'Document Register');

      // Summary sheet
      const summaryData = [
        ['Metric', 'Value'],
        ['Total Projects', metadata.totalProjects],
        ['Total Documents', metadata.totalDocuments],
        ['Last Scan Date', metadata.lastScanDate],
        ['Processing Time (minutes)', metadata.processingTimeMinutes],
        ['Objects Scanned', metadata.totalObjectsScanned]
      ];

      const summaryWs = XLSX.utils.aoa_to_sheet(summaryData);
      XLSX.utils.book_append_sheet(wb, summaryWs, 'Summary');

      XLSX.writeFile(wb, this.xlsxFile);

      const fileSize = fs.statSync(this.xlsxFile).size;
      logger.info(`✅ XLSX exported: ${this.xlsxFile}`);
      logger.info(`   📊 File size: ${this.formatFileSize(fileSize)}`);

      return this.xlsxFile;

    } catch (error) {
      logger.error('❌ Error creating XLSX:', error);
      throw error;
    }
  }

  saveMetadata(metadata) {
    try {
      fs.writeFileSync(this.metadataFile, JSON.stringify(metadata, null, 2));
      logger.info(`💾 Metadata saved: ${this.metadataFile}`);
    } catch (error) {
      logger.error('❌ Error saving metadata:', error);
      throw error;
    }
  }

  loadMetadata() {
    try {
      if (fs.existsSync(this.metadataFile)) {
        return JSON.parse(fs.readFileSync(this.metadataFile, 'utf8'));
      }
      return null;
    } catch (error) {
      logger.warn('⚠️ Error loading metadata:', error.message);
      return null;
    }
  }

  async generateRegister(skipQuickCount = false) {
    try {
      logger.info('🚀 Generating document register...');
      logger.info(' ');
      logger.info('═══════════════════════════════════════════════════');
      logger.info('  PRE-SCAN: Quick Count');
      logger.info('═══════════════════════════════════════════════════');

      let quickCount = null;
      if (!skipQuickCount) {
        quickCount = await this.getQuickCount();
        logger.info(' ');
        logger.info('═══════════════════════════════════════════════════');
        logger.info('  FULL SCAN: Document Details');
        logger.info('═══════════════════════════════════════════════════');
      }

      const scanResult = await this.scanAllDocuments();
      const csvPath = await this.exportToCSV(scanResult.documents);
      const xlsxPath = await this.exportToXLSX(scanResult.documents, scanResult.metadata);

      const result = {
        success: true,
        quickCount,
        totalDocuments: scanResult.documents.length,
        totalProjects: scanResult.metadata.totalProjects,
        processingTime: scanResult.metadata.processingTimeMinutes,
        outputs: {
          csv: csvPath,
          xlsx: xlsxPath,
          metadata: this.metadataFile
        }
      };

      logger.info(' ');
      logger.info('🎉 Document register complete!');
      logger.info(`   📄 ${result.totalDocuments.toLocaleString()} documents from ${result.totalProjects.toLocaleString()} projects`);
      logger.info(`   📊 CSV: ${csvPath}`);
      logger.info(`   📋 XLSX: ${xlsxPath}`);
      logger.info(`   💾 Metadata: ${this.metadataFile}`);
      logger.info(`   ⏱️  Total time: ${result.processingTime} minutes`);

      return result;
    } catch (error) {
      logger.error('❌ Error generating register:', error);
      throw error;
    }
  }
}

module.exports = new DocumentRegisterService();
