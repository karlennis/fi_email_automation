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

  /**
   * Get file paths for a specific date
   */
  getDateBasedPaths(targetDate) {
    const dateStr = new Date(targetDate).toISOString().split('T')[0];
    return {
      metadataFile: path.join(this.outputDir, `register-metadata-${dateStr}.json`),
      csvFile: path.join(this.outputDir, `document-register-${dateStr}.csv`),
      xlsxFile: path.join(this.outputDir, `document-register-${dateStr}.xlsx`),
      dateStr
    };
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

      const { S3Client, ListObjectsV2Command } = require('@aws-sdk/client-s3');
      const s3Client = new S3Client({
        region: process.env.AWS_REGION || 'eu-north-1',
        credentials: {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
        },
        requestHandler: {
          requestTimeout: 120000,
          connectionTimeout: 10000
        },
        maxAttempts: 3
      });
      const bucket = process.env.S3_BUCKET || 'planning-documents-2';

      let totalDocuments = 0;
      const projectDocs = new Map();
      let continuationToken = null;
      let objectsScanned = 0;

      logger.info('🔍 Scanning all objects in planning-docs/...');

      do {
        const command = new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: 'planning-docs/',
          MaxKeys: 1000,
          ContinuationToken: continuationToken
        });

        try {
          const response = await s3Client.send(command);
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
          if (error.$retryable || error.name === 'TimeoutError') {
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
      const { S3Client, ListObjectsV2Command } = require('@aws-sdk/client-s3');
      const s3Client = new S3Client({
        region: process.env.AWS_REGION || 'eu-north-1',
        credentials: {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
        },
        requestHandler: {
          requestTimeout: 120000,
          connectionTimeout: 10000
        },
        maxAttempts: 3
      });
      const bucket = process.env.S3_BUCKET || 'planning-documents-2';

      const allDocuments = [];
      const projectStats = {};
      let continuationToken = null;
      let objectsScanned = 0;
      let documentsFound = 0;

      logger.info('📊 Scanning planning-docs/...');

      do {
        const command = new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: 'planning-docs/',
          MaxKeys: 1000,
          ContinuationToken: continuationToken
        });

        try {
          const response = await s3Client.send(command);
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
          if (error.$retryable || error.name === 'TimeoutError') {
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

  async exportToCSV(documents, customPath = null) {
    logger.info('📄 Exporting to CSV...');

    const csvPath = customPath || this.csvFile;
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

    fs.writeFileSync(csvPath, csvContent);
    logger.info(`✅ CSV exported: ${csvPath}`);

    const fileSize = fs.statSync(csvPath).size;
    logger.info(`   📊 File size: ${this.formatFileSize(fileSize)}`);

    return csvPath;
  }

  async exportToXLSX(documents, metadata, customPath = null) {
    logger.info('📊 Exporting to XLSX...');

    try {
      const xlsxPath = customPath || this.xlsxFile;
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

      XLSX.writeFile(wb, xlsxPath);

      const fileSize = fs.statSync(xlsxPath).size;
      logger.info(`✅ XLSX exported: ${xlsxPath}`);
      logger.info(`   📊 File size: ${this.formatFileSize(fileSize)}`);

      return xlsxPath;

    } catch (error) {
      logger.error('❌ Error creating XLSX:', error);
      throw error;
    }
  }

  saveMetadata(metadata, customPath = null) {
    try {
      const filePath = customPath || this.metadataFile;
      fs.writeFileSync(filePath, JSON.stringify(metadata, null, 2));
      logger.info(`💾 Metadata saved: ${filePath}`);

      // Also save documents array if present (for date-based registers)
      if (customPath && metadata.documents) {
        logger.info(`📄 Saved ${metadata.documents.length} documents in metadata`);
      }
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

  async getFirst50Projects() {
    try {
      logger.info('📊 Getting first 50 projects from planning-docs...');
      logger.info('⚡ Using optimized scan for project listing');

      const { S3Client, ListObjectsV2Command } = require('@aws-sdk/client-s3');

      // Ensure credentials are available
      const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
      const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
      const region = process.env.AWS_REGION || 'eu-north-1';

      if (!accessKeyId || !secretAccessKey) {
        throw new Error('AWS credentials not configured. Please set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY environment variables.');
      }

      const s3Client = new S3Client({
        region: region,
        credentials: {
          accessKeyId: accessKeyId,
          secretAccessKey: secretAccessKey
        }
      });
      const bucket = process.env.S3_BUCKET || 'planning-documents-2';

      const projectMap = new Map();
      let continuationToken = null;
      let objectsScanned = 0;

      logger.info('🔍 Scanning objects in planning-docs/...');

      // Scan until we have at least 50 projects or finish scanning
      do {
        const command = new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: 'planning-docs/',
          MaxKeys: 1000,
          ContinuationToken: continuationToken
        });

        try {
          const response = await s3Client.send(command);
          if (response.Contents) {
            response.Contents.forEach(obj => {
              objectsScanned++;
              const match = obj.Key.match(/^planning-docs\/([^\/]+)\/(.+)$/);
              if (match) {
                const projectId = match[1];
                const fileName = match[2];

                if (!projectMap.has(projectId)) {
                  projectMap.set(projectId, {
                    projectId,
                    documentCount: 0,
                    lastUpdated: null,
                    mostRecentDocument: null
                  });
                }

                const project = projectMap.get(projectId);

                if (fileName && !fileName.endsWith('/') && !fileName.startsWith('.')) {
                  project.documentCount++;
                  if (!project.lastUpdated || new Date(obj.LastModified) > new Date(project.lastUpdated)) {
                    project.lastUpdated = obj.LastModified;
                    project.mostRecentDocument = fileName;
                  }
                }
              }
            });
          }
          continuationToken = response.IsTruncated ? response.NextContinuationToken : null;

          if (objectsScanned % 5000 === 0) {
            logger.info(`   Scanned ${objectsScanned.toLocaleString()} objects... (${projectMap.size} projects found)`);
          }

          // Stop early if we have enough projects and want to optimize
          if (projectMap.size >= 100) {
            logger.info(`   Found ${projectMap.size} projects, stopping scan for first 50...`);
            break;
          }

        } catch (error) {
          logger.error('S3 API error:', error.message);
          if (error.$retryable || error.name === 'TimeoutError') {
            logger.warn('Timeout detected, retrying...');
            await new Promise(resolve => setTimeout(resolve, 2000));
            continue;
          }
          throw error;
        }
      } while (continuationToken);

      // Convert to array and sort by most recent document update (newest first)
      const projects = Array.from(projectMap.values())
        .filter(project => project.lastUpdated) // Only include projects with documents
        .sort((a, b) => new Date(b.lastUpdated) - new Date(a.lastUpdated))
        .slice(0, 50);

      logger.info(`📋 Found ${projects.length} projects (showing first 50, sorted by most recent)`);
      logger.info(`   Scanned ${objectsScanned.toLocaleString()} total objects`);

      return projects; // Return array directly, not spread into object

    } catch (error) {
      logger.error('❌ Error getting projects:', error);
      throw error;
    }
  }

  async generateRegister(skipQuickCount = false, targetDate = null) {
    try {
      const isDateSpecific = targetDate !== null;
      const dateInfo = isDateSpecific ? this.getDateBasedPaths(targetDate) : null;

      // Check if we already have this date's register
      if (isDateSpecific && fs.existsSync(dateInfo.metadataFile)) {
        logger.info(`✅ Register for ${dateInfo.dateStr} already exists, loading cached version`);
        const existingMetadata = JSON.parse(fs.readFileSync(dateInfo.metadataFile, 'utf-8'));

        return {
          success: true,
          quickCount: null,
          totalDocuments: existingMetadata.totalDocuments,
          totalProjects: existingMetadata.totalProjects,
          processingTime: existingMetadata.processingTimeMinutes,
          targetDate: dateInfo.dateStr,
          outputs: {
            csv: dateInfo.csvFile,
            xlsx: dateInfo.xlsxFile,
            metadata: dateInfo.metadataFile
          }
        };
      }

      // For date-specific requests, check if we can reuse a recent full scan
      let reusableMetadata = null;
      if (isDateSpecific) {
        // Only reuse if it's from today (same day)
        const todayStr = new Date().toISOString().split('T')[0];
        const todayMetadataPath = path.join(this.outputDir, `register-metadata-${todayStr}.json`);

        if (fs.existsSync(todayMetadataPath)) {
          const metadata = JSON.parse(fs.readFileSync(todayMetadataPath, 'utf-8'));
          // Validate metadata has documents array and valid project data
          const projectCount = metadata.totalProjects || Object.keys(metadata.documentsByProject || {}).length;
          if (metadata.documents && metadata.documents.length > 0 && projectCount > 0) {
            logger.info(`📦 Found today's metadata file (${todayStr})`);
            logger.info(`🔄 Reusing today's scan instead of re-scanning S3...`);
            reusableMetadata = metadata;
          } else {
            logger.warn(`⚠️  Today's metadata file is invalid (${metadata.documents?.length || 0} docs, ${projectCount} projects), will re-scan`);
            // Delete the corrupted file
            fs.unlinkSync(todayMetadataPath);
            logger.info(`🗑️  Deleted corrupted metadata file`);
          }
        } else {
          // Check for yesterday's file as fallback (within 24 hours)
          const yesterday = new Date();
          yesterday.setDate(yesterday.getDate() - 1);
          const yesterdayStr = yesterday.toISOString().split('T')[0];
          const yesterdayMetadataPath = path.join(this.outputDir, `register-metadata-${yesterdayStr}.json`);

          if (fs.existsSync(yesterdayMetadataPath)) {
            const stats = fs.statSync(yesterdayMetadataPath);
            const ageHours = (Date.now() - stats.mtime.getTime()) / (1000 * 60 * 60);

            if (ageHours < 24) {
              const metadata = JSON.parse(fs.readFileSync(yesterdayMetadataPath, 'utf-8'));
              // Validate metadata has documents array and valid project data
              const projectCount = metadata.totalProjects || Object.keys(metadata.documentsByProject || {}).length;
              if (metadata.documents && metadata.documents.length > 0 && projectCount > 0) {
                logger.info(`📦 Found yesterday's metadata file (${yesterdayStr}, ${ageHours.toFixed(1)} hours old)`);
                logger.info(`🔄 Reusing recent scan instead of re-scanning S3...`);
                reusableMetadata = metadata;
              } else {
                logger.warn(`⚠️  Yesterday's metadata file is invalid (${metadata.documents?.length || 0} docs, ${projectCount} projects), will re-scan`);
              }
            }
          }
        }
      }

      logger.info(`🚀 Generating document register${isDateSpecific ? ` for ${dateInfo.dateStr}` : ''}...`);
      logger.info(' ');

      let scanResult;

      if (reusableMetadata && reusableMetadata.documents) {
        // Reuse existing scan data
        logger.info(`✅ Reusing ${reusableMetadata.documents.length.toLocaleString()} documents from cache`);

        const totalProjects = reusableMetadata.totalProjects || Object.keys(reusableMetadata.documentsByProject || {}).length;
        logger.info(`📊 ${totalProjects.toLocaleString()} projects`);

        scanResult = {
          documents: reusableMetadata.documents,
          metadata: {
            lastScanDate: new Date().toISOString(),
            totalProjects: totalProjects,
            totalDocuments: reusableMetadata.documents.length,
            totalObjectsScanned: reusableMetadata.totalObjectsScanned || 0,
            processingTimeMs: 0,
            processingTimeMinutes: '0.0',
            documentsByProject: reusableMetadata.documentsByProject || {},
            reusedFromCache: true,
            originalScanDate: reusableMetadata.lastScanDate
          },
          projectStats: reusableMetadata.documentsByProject || {}
        };
      } else {
        // Do full S3 scan
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

        scanResult = await this.scanAllDocuments();
      }

      // Use date-specific paths if targetDate provided
      const csvPath = isDateSpecific ?
        await this.exportToCSV(scanResult.documents, dateInfo.csvFile) :
        await this.exportToCSV(scanResult.documents);

      const xlsxPath = isDateSpecific ?
        await this.exportToXLSX(scanResult.documents, scanResult.metadata, dateInfo.xlsxFile) :
        await this.exportToXLSX(scanResult.documents, scanResult.metadata);

      // Save metadata with documents array for date-specific registers
      if (isDateSpecific) {
        const metadataWithDocs = {
          ...scanResult.metadata,
          documents: scanResult.documents,
          targetDate: dateInfo.dateStr
        };
        this.saveMetadata(metadataWithDocs, dateInfo.metadataFile);
      } else {
        this.saveMetadata(scanResult.metadata);
      }

      const result = {
        success: true,
        quickCount: null,
        totalDocuments: scanResult.documents.length,
        totalProjects: scanResult.metadata.totalProjects,
        processingTime: scanResult.metadata.processingTimeMinutes,
        targetDate: isDateSpecific ? dateInfo.dateStr : null,
        reusedCache: scanResult.metadata.reusedFromCache || false,
        outputs: {
          csv: csvPath,
          xlsx: xlsxPath,
          metadata: isDateSpecific ? dateInfo.metadataFile : this.metadataFile
        }
      };

      logger.info(' ');
      logger.info('🎉 Document register complete!');
      logger.info(`   📄 ${result.totalDocuments.toLocaleString()} documents from ${result.totalProjects.toLocaleString()} projects`);
      if (result.reusedCache) {
        logger.info(`   ♻️  Reused cached data (no S3 scan needed)`);
      }
      logger.info(`   📊 CSV: ${csvPath}`);
      logger.info(`   📋 XLSX: ${xlsxPath}`);
      logger.info(`   💾 Metadata: ${isDateSpecific ? dateInfo.metadataFile : this.metadataFile}`);
      logger.info(`   ⏱️  Total time: ${result.processingTime} minutes`);

      return result;
    } catch (error) {
      logger.error('❌ Error generating register:', error);
      throw error;
    }
  }

  /**
   * Get documents by date range from the stored register
   * Auto-generates register for the target date if it doesn't exist
   */
  async getDocumentsByDateRange(startDate, endDate) {
    try {
      logger.info(`📋 Getting documents between ${startDate.toISOString()} and ${endDate.toISOString()}`);

      // Determine target date (use startDate for metadata file lookup)
      const targetDateStr = new Date(startDate).toISOString().split('T')[0];
      const metadataPath = path.join(this.outputDir, `register-metadata-${targetDateStr}.json`);

      // Check if register exists for this date
      if (!fs.existsSync(metadataPath)) {
        logger.warn(`⚠️  No document register found for ${targetDateStr}`);
        logger.info(`🔄 Auto-generating document register for ${targetDateStr}...`);

        // Generate register for this specific date
        await this.generateRegister(true, startDate); // Skip quick count for speed

        logger.info(`✅ Document register generated for ${targetDateStr}`);
      }

      // Now read from the metadata file (either existing or just generated)
      if (fs.existsSync(metadataPath)) {
        logger.info(`📄 Reading from metadata file: ${targetDateStr}`);
        const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
        const documents = metadata.documents || [];

        const startTime = startDate.getTime();
        const endTime = endDate.getTime();

        const filtered = documents.filter(doc => {
          // Exclude docfiles.txt
          if (doc.fileName && doc.fileName.toLowerCase() === 'docfiles.txt') {
            return false;
          }

          const docDate = new Date(doc.lastModified).getTime();
          return docDate >= startTime && docDate < endTime;
        });

        logger.info(`✅ Found ${filtered.length} documents in date range from metadata`);
        return filtered;
      }

      // Fallback to CSV file if metadata not found
      if (!fs.existsSync(this.csvFile)) {
        logger.warn('⚠️  No document register files found. Returning empty array.');
        return [];
      }

      logger.info('📄 Reading from CSV file (fallback)');
      const csvContent = fs.readFileSync(this.csvFile, 'utf-8');
      const lines = csvContent.split('\n').slice(1); // Skip header

      const documents = [];
      const startTime = startDate.getTime();
      const endTime = endDate.getTime();

      for (const line of lines) {
        if (!line.trim()) continue;

        // Parse CSV line - new format: Project ID,File Name,File Path,Last Modified,Size,File Type
        const parts = line.match(/(?:"([^"]*)"|([^,]*))(,|$)/g);
        if (!parts || parts.length < 4) continue;

        const getValue = (part) => {
          const cleaned = part.replace(/,$/, '').trim();
          return cleaned.startsWith('"') && cleaned.endsWith('"')
            ? cleaned.slice(1, -1).replace(/""/g, '"')
            : cleaned;
        };

        const projectId = getValue(parts[0]);
        const fileName = getValue(parts[1]);
        const filePath = getValue(parts[2]);
        const lastModified = getValue(parts[3]);
        const size = parts[4] ? parseInt(getValue(parts[4])) || 0 : 0;
        const fileType = parts[5] ? getValue(parts[5]) : 'unknown';

        const docDate = new Date(lastModified).getTime();

        if (docDate >= startTime && docDate < endTime) {
          documents.push({
            projectId,
            fileName,
            filePath,
            lastModified: new Date(lastModified),
            size,
            fileType
          });
        }
      }

      logger.info(`✅ Found ${documents.length} documents in date range from CSV`);
      return documents;

    } catch (error) {
      logger.error('❌ Error getting documents by date range:', error);
      throw error;
    }
  }
}

module.exports = new DocumentRegisterService();
