const AWS = require('aws-sdk');
const fs = require('fs').promises;
const path = require('path');
const winston = require('winston');

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console()
  ]
});

class S3Service {
  constructor() {
    // Configure AWS
    AWS.config.update({
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      region: process.env.AWS_REGION || 'eu-north-1'
    });

    this.s3 = new AWS.S3();
    this.bucket = process.env.S3_BUCKET || 'planning-documents-2';
    this.downloadDir = process.env.DOWNLOAD_DIR || './temp/downloads';

    // Cache for listMainFolders to prevent hammering S3
    this.mainFoldersCache = null;
    this.mainFoldersCacheExpiry = null;
    this.CACHE_TTL = 5 * 60 * 1000; // 5 minutes cache

    // Singleflight lock to prevent concurrent duplicate S3 calls
    this.inFlightPromise = null;

    this.ensureDownloadDir();
  }

  async ensureDownloadDir() {
    try {
      await fs.mkdir(this.downloadDir, { recursive: true });
    } catch (error) {
      logger.error('Error creating download directory:', error);
    }
  }

  /**
   * Find project folder path by searching through all main folders
   */
  async findProjectPath(projectId) {
    try {
      const mainFolders = await this.listMainFolders();

      for (const folder of mainFolders) {
        const projects = await this.listProjectsInFolder(folder.prefix);
        const project = projects.find(p => p.projectId === projectId);
        if (project) {
          return project.folderPath;
        }
      }

      return null;
    } catch (error) {
      logger.error(`Error finding project path for ${projectId}:`, error);
      throw error;
    }
  }

  /**
   * List all documents for a specific project ID
   * Uses pagination to retrieve ALL documents (not limited to 1000)
   */
  async listProjectDocuments(projectId) {
    try {
      // First find where this project is located
      const projectPath = await this.findProjectPath(projectId);
      if (!projectPath) {
        logger.warn(`Project ${projectId} not found in any folder`);
        return [];
      }

      const allDocuments = [];
      let continuationToken = null;

      // Paginate through all results
      do {
        const params = {
          Bucket: this.bucket,
          Prefix: projectPath,
          MaxKeys: 1000
        };

        if (continuationToken) {
          params.ContinuationToken = continuationToken;
        }

        const response = await this.s3.listObjectsV2(params).promise();

        const documents = response.Contents
          .filter(obj => {
            const key = obj.Key.toLowerCase();
            return key.endsWith('.pdf') || key.endsWith('.docx');
          })
          .map(obj => ({
            key: obj.Key,
            fileName: path.basename(obj.Key),
            size: obj.Size,
            lastModified: obj.LastModified,
            projectId: projectId,
            folderPath: projectPath
          }));

        allDocuments.push(...documents);

        // Check if there are more results
        continuationToken = response.IsTruncated ? response.NextContinuationToken : null;

      } while (continuationToken);

      return allDocuments;

    } catch (error) {
      logger.error(`Error listing documents for project ${projectId}:`, error);
      throw error;
    }
  }

  /**
   * Download a specific document from S3
   */
  async downloadDocument(s3Key, localFileName = null) {
    try {
      const fileName = localFileName || path.basename(s3Key);
      const localPath = path.join(this.downloadDir, fileName);

      const params = {
        Bucket: this.bucket,
        Key: s3Key
      };

      const response = await this.s3.getObject(params).promise();
      await fs.writeFile(localPath, response.Body);

      logger.info(`Downloaded ${s3Key} to ${localPath}`);

      return {
        localPath,
        fileName,
        size: response.Body.length,
        contentType: response.ContentType
      };

    } catch (error) {
      logger.error(`Error downloading ${s3Key}:`, error);
      throw error;
    }
  }

  /**
   * Get document buffer from S3 without saving to disk (streaming alternative)
   */
  async getDocumentBuffer(s3Key) {
    try {
      const params = {
        Bucket: this.bucket,
        Key: s3Key
      };

      const response = await this.s3.getObject(params).promise();

      logger.debug(`📄 Streamed ${s3Key} (${response.Body.length} bytes) without disk write`);

      return {
        buffer: response.Body,
        fileName: path.basename(s3Key),
        size: response.Body.length,
        contentType: response.ContentType
      };

    } catch (error) {
      logger.error(`Error streaming ${s3Key}:`, error);
      throw error;
    }
  }

  /**
   * Download all documents for a project
   */
  async downloadProjectDocuments(projectId) {
    try {
      const documents = await this.listProjectDocuments(projectId);
      const downloaded = [];

      for (const doc of documents) {
        try {
          const result = await this.downloadDocument(doc.key);
          downloaded.push({
            ...result,
            projectId,
            s3Key: doc.key
          });
        } catch (error) {
          logger.warn(`Failed to download ${doc.key}:`, error.message);
        }
      }

      return downloaded;

    } catch (error) {
      logger.error(`Error downloading documents for project ${projectId}:`, error);
      throw error;
    }
  }

  /**
   * List all main folders in the S3 bucket (like june_2025/, planning_documents_2025_03/, etc.)
   * CACHED to prevent excessive S3 API calls (5 min TTL)
   */
  async listMainFolders() {
    try {
      // Check cache first
      const now = Date.now();
      if (this.mainFoldersCache && this.mainFoldersCacheExpiry && now < this.mainFoldersCacheExpiry) {
        logger.info('✅ Returning cached main folders (avoiding S3 call)');
        return this.mainFoldersCache;
      }

      // Singleflight: if already in progress, wait for it
      if (this.inFlightPromise) {
        logger.info('⏳ S3 call already in progress, waiting for result...');
        return await this.inFlightPromise;
      }

      logger.info('🚀 Starting S3 call to list main folders:', this.bucket);

      // Create the in-flight promise
      this.inFlightPromise = this._doListMainFolders();

      try {
        const result = await this.inFlightPromise;
        return result;
      } finally {
        this.inFlightPromise = null;
      }
    } catch (error) {
      this.inFlightPromise = null;
      throw error;
    }
  }

  async _doListMainFolders() {
    try {
      const now = Date.now(); // Define 'now' for cache expiry calculation
      logger.info('Attempting to list main folders from S3 bucket:', this.bucket);

      const params = {
        Bucket: this.bucket,
        Delimiter: '/',
        MaxKeys: 1000
      };

      logger.info('S3 listObjectsV2 parameters:', params);
      const response = await this.s3.listObjectsV2(params).promise();
      logger.info('S3 listObjectsV2 response CommonPrefixes:', response.CommonPrefixes);

      const folders = response.CommonPrefixes
        .map(prefix => ({
          name: prefix.Prefix.replace('/', ''),
          prefix: prefix.Prefix,
          type: 'folder'
        }))
        .filter(folder => folder.name); // Filter out empty names

      logger.info('Processed folders:', folders);

      // Cache the result
      this.mainFoldersCache = folders;
      this.mainFoldersCacheExpiry = now + this.CACHE_TTL;
      logger.info(`📦 Cached main folders for ${this.CACHE_TTL / 1000}s`);

      return folders;

    } catch (error) {
      logger.error('Error listing main folders:', error);
      logger.error('Error details:', {
        message: error.message,
        code: error.code,
        statusCode: error.statusCode,
        region: this.s3.config.region,
        bucket: this.bucket
      });
      throw error;
    }
  }

  /**
   * List project folders within a specific main folder
   */
  async listProjectsInFolder(folderPrefix) {
    try {
      const params = {
        Bucket: this.bucket,
        Prefix: folderPrefix,
        Delimiter: '/',
        MaxKeys: 1000
      };

      const response = await this.s3.listObjectsV2(params).promise();

      const projects = response.CommonPrefixes
        .map(prefix => {
          const fullPath = prefix.Prefix;
          const projectFolder = fullPath.replace(folderPrefix, '').replace('/', '');
          return {
            projectId: projectFolder,
            folderPath: fullPath,
            parentFolder: folderPrefix.replace('/', '')
          };
        })
        .filter(project => project.projectId);

      return projects;

    } catch (error) {
      logger.error(`Error listing projects in folder ${folderPrefix}:`, error);
      throw error;
    }
  }

  /**
   * List all project folders across all main folders
   */
  async listAllProjects() {
    try {
      const mainFolders = await this.listMainFolders();
      const allProjects = [];

      for (const folder of mainFolders) {
        try {
          const projects = await this.listProjectsInFolder(folder.prefix);
          allProjects.push(...projects);
        } catch (error) {
          logger.warn(`Error getting projects from folder ${folder.name}:`, error.message);
        }
      }

      return allProjects.map(p => p.projectId);

    } catch (error) {
      logger.error('Error listing all projects:', error);
      throw error;
    }
  }

  /**
   * Get statistics about documents in the bucket
   */
  async getBucketStats() {
    try {
      const projects = await this.listAllProjects();
      let totalDocuments = 0;
      let totalSize = 0;

      for (const projectId of projects.slice(0, 10)) { // Sample first 10 projects
        const docs = await this.listProjectDocuments(projectId);
        totalDocuments += docs.length;
        totalSize += docs.reduce((sum, doc) => sum + doc.size, 0);
      }

      return {
        totalProjects: projects.length,
        sampleDocuments: totalDocuments,
        estimatedTotalDocuments: Math.round(totalDocuments * projects.length / 10),
        sampleTotalSize: totalSize,
        averageDocumentsPerProject: Math.round(totalDocuments / 10)
      };

    } catch (error) {
      logger.error('Error getting bucket stats:', error);
      throw error;
    }
  }

  /**
   * List projects in the planning-docs folder only
   * Uses pagination to retrieve ALL projects (not limited to 1000)
   */
  async listPlanningDocsProjects() {
    try {
      const planningDocsPrefix = 'planning-docs/';
      const allProjects = [];
      let continuationToken = null;

      // Paginate through all results
      do {
        const params = {
          Bucket: this.bucket,
          Prefix: planningDocsPrefix,
          Delimiter: '/',
          MaxKeys: 1000
        };

        if (continuationToken) {
          params.ContinuationToken = continuationToken;
        }

        const response = await this.s3.listObjectsV2(params).promise();

        const projects = response.CommonPrefixes
          .map(prefix => {
            const fullPath = prefix.Prefix;
            const projectId = fullPath.replace(planningDocsPrefix, '').replace('/', '');
            return {
              projectId: projectId,
              folderPath: fullPath,
              parentFolder: 'planning-docs'
            };
          })
          .filter(project => project.projectId);

        allProjects.push(...projects);

        // Check if there are more results
        continuationToken = response.IsTruncated ? response.NextContinuationToken : null;

        if (continuationToken) {
          logger.info(`Retrieved ${allProjects.length} projects so far, fetching more...`);
        }

      } while (continuationToken);

      logger.info(`Found ${allProjects.length} total projects in planning-docs folder`);
      return allProjects;

    } catch (error) {
      logger.error('Error listing projects in planning-docs folder:', error);
      throw error;
    }
  }

  /**
   * List documents for projects filtered by API results (planning-docs only)
   * Uses pagination to retrieve ALL documents per project
   */
  async listFilteredProjectDocuments(filteredProjectIds) {
    try {
      const allDocuments = [];
      const planningDocsPrefix = 'planning-docs/';

      // Process projects in batches to avoid overwhelming S3
      const batchSize = 10;

      for (let i = 0; i < filteredProjectIds.length; i += batchSize) {
        const batch = filteredProjectIds.slice(i, i + batchSize);

        const batchPromises = batch.map(async (projectId) => {
          try {
            const projectPath = `${planningDocsPrefix}${projectId}/`;
            const projectDocuments = [];
            let continuationToken = null;

            // Paginate through all documents for this project
            do {
              const params = {
                Bucket: this.bucket,
                Prefix: projectPath,
                MaxKeys: 1000
              };

              if (continuationToken) {
                params.ContinuationToken = continuationToken;
              }

              const response = await this.s3.listObjectsV2(params).promise();

              const documents = response.Contents
                .filter(obj => {
                  const key = obj.Key.toLowerCase();
                  return key.endsWith('.pdf') || key.endsWith('.docx');
                })
                .map(obj => ({
                  key: obj.Key,
                  fileName: path.basename(obj.Key),
                  size: obj.Size,
                  lastModified: obj.LastModified,
                  projectId: projectId,
                  folderPath: projectPath
                }));

              projectDocuments.push(...documents);

              // Check if there are more results
              continuationToken = response.IsTruncated ? response.NextContinuationToken : null;

            } while (continuationToken);

            return projectDocuments;

          } catch (error) {
            logger.warn(`Error listing documents for project ${projectId}:`, error.message);
            return [];
          }
        });

        const batchResults = await Promise.allSettled(batchPromises);

        batchResults.forEach((result, index) => {
          if (result.status === 'fulfilled') {
            allDocuments.push(...result.value);
          } else {
            logger.warn(`Failed to get documents for project ${batch[index]}:`, result.reason);
          }
        });

        // Small delay between batches
        if (i + batchSize < filteredProjectIds.length) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }

      logger.info(`Found ${allDocuments.length} documents across ${filteredProjectIds.length} filtered projects`);
      return allDocuments;

    } catch (error) {
      logger.error('Error listing filtered project documents:', error);
      throw error;
    }
  }

  /**
   * Get documents for a specific project in planning-docs folder
   */
  async getPlanningDocsProjectDocuments(projectId) {
    try {
      const projectPath = `planning-docs/${projectId}/`;

      const params = {
        Bucket: this.bucket,
        Prefix: projectPath,
        MaxKeys: 1000
      };

      const response = await this.s3.listObjectsV2(params).promise();

      const documents = response.Contents
        .filter(obj => {
          const key = obj.Key.toLowerCase();
          return key.endsWith('.pdf') || key.endsWith('.docx');
        })
        .map(obj => ({
          key: obj.Key,
          fileName: path.basename(obj.Key),
          size: obj.Size,
          lastModified: obj.LastModified,
          projectId: projectId,
          folderPath: projectPath
        }));

      logger.info(`Found ${documents.length} documents for project ${projectId} in planning-docs`);
      return documents;

    } catch (error) {
      logger.error(`Error getting documents for project ${projectId} in planning-docs:`, error);
      throw error;
    }
  }

  /**
   * Clean up downloaded files older than specified hours
   */
  async cleanupDownloads(maxAgeHours = 24) {
    try {
      const files = await fs.readdir(this.downloadDir);
      const maxAge = maxAgeHours * 60 * 60 * 1000; // Convert to milliseconds
      const now = Date.now();
      let cleanedCount = 0;

      for (const file of files) {
        const filePath = path.join(this.downloadDir, file);
        try {
          const stats = await fs.stat(filePath);
          if (now - stats.mtime.getTime() > maxAge) {
            await fs.unlink(filePath);
            cleanedCount++;
          }
        } catch (error) {
          logger.warn(`Error checking/removing file ${filePath}:`, error);
        }
      }

      logger.info(`Cleaned up ${cleanedCount} old download files`);
      return cleanedCount;

    } catch (error) {
      logger.error('Error during download cleanup:', error);
      throw error;
    }
  }

  /**
   * Check if an object exists in S3
   */
  async objectExists(key) {
    try {
      await this.s3.headObject({
        Bucket: this.bucket,
        Key: key
      }).promise();
      return true;
    } catch (error) {
      if (error.code === 'NotFound') {
        return false;
      }
      throw error;
    }
  }

  /**
   * Ensure root filter-docs sentinel exists so the prefix remains visible
   */
  async ensureFilterDocsRootKeep() {
    const keepKey = 'filter-docs/.keep';

    try {
      const exists = await this.objectExists(keepKey);

      if (exists) {
        logger.info('✅ filter-docs root keep file already exists');
        return { key: keepKey, created: false };
      }

      await this.uploadDocument(
        Buffer.from('keep\n', 'utf8'),
        keepKey,
        { sentinel: 'true', purpose: 'preserve-prefix' }
      );

      logger.info('✅ Created filter-docs root keep file');
      return { key: keepKey, created: true };
    } catch (error) {
      logger.error('❌ Failed to ensure filter-docs root keep file:', error);
      throw error;
    }
  }

  // ============================================
  // FILTER-DOCS INGESTION OPERATIONS
  // ============================================

  /**
   * Upload a document to S3
   * @param {Buffer|string} content - File content (Buffer) or local file path
   * @param {string} s3Key - Destination key in S3
   * @param {object} metadata - Optional metadata to attach
   */
  async uploadDocument(content, s3Key, metadata = {}) {
    try {
      let body = content;

      // If content is a string path, read the file
      if (typeof content === 'string') {
        body = await fs.readFile(content);
      }

      const params = {
        Bucket: this.bucket,
        Key: s3Key,
        Body: body,
        Metadata: metadata
      };

      // Set content type based on extension
      const ext = path.extname(s3Key).toLowerCase();
      if (ext === '.pdf') {
        params.ContentType = 'application/pdf';
      } else if (ext === '.docx') {
        params.ContentType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
      } else if (ext === '.txt') {
        params.ContentType = 'text/plain';
      } else if (ext === '.json') {
        params.ContentType = 'application/json';
      }

      await this.s3.putObject(params).promise();
      logger.info(`📤 Uploaded document to ${s3Key}`);

      return { key: s3Key, size: body.length };
    } catch (error) {
      logger.error(`Error uploading document to ${s3Key}:`, error);
      throw error;
    }
  }

  /**
   * Copy a document within S3 (same bucket)
   * @param {string} sourceKey - Source object key
   * @param {string} destKey - Destination object key
   */
  async copyDocument(sourceKey, destKey) {
    try {
      const params = {
        Bucket: this.bucket,
        CopySource: `${this.bucket}/${sourceKey}`,
        Key: destKey
      };

      await this.s3.copyObject(params).promise();
      logger.info(`📋 Copied ${sourceKey} to ${destKey}`);

      return { sourceKey, destKey };
    } catch (error) {
      logger.error(`Error copying ${sourceKey} to ${destKey}:`, error);
      throw error;
    }
  }

  /**
   * Delete a document from S3
   * @param {string} s3Key - Object key to delete
   */
  async deleteDocument(s3Key) {
    try {
      const params = {
        Bucket: this.bucket,
        Key: s3Key
      };

      await this.s3.deleteObject(params).promise();
      logger.info(`🗑️ Deleted ${s3Key}`);

      return { key: s3Key, deleted: true };
    } catch (error) {
      logger.error(`Error deleting ${s3Key}:`, error);
      throw error;
    }
  }

  /**
   * Delete multiple documents from S3
   * @param {string[]} s3Keys - Array of object keys to delete
   */
  async deleteDocuments(s3Keys) {
    try {
      if (!s3Keys || s3Keys.length === 0) {
        return { deleted: 0 };
      }

      // S3 deleteObjects can handle up to 1000 keys at once
      const batchSize = 1000;
      let totalDeleted = 0;

      for (let i = 0; i < s3Keys.length; i += batchSize) {
        const batch = s3Keys.slice(i, i + batchSize);
        const params = {
          Bucket: this.bucket,
          Delete: {
            Objects: batch.map(key => ({ Key: key })),
            Quiet: true
          }
        };

        await this.s3.deleteObjects(params).promise();
        totalDeleted += batch.length;
      }

      logger.info(`🗑️ Deleted ${totalDeleted} documents`);
      return { deleted: totalDeleted };
    } catch (error) {
      logger.error(`Error batch deleting documents:`, error);
      throw error;
    }
  }

  /**
   * Check if a project folder exists in planning-docs
   * @param {string} projectId - Project ID to check
   */
  async projectExistsInPlanning(projectId) {
    try {
      const params = {
        Bucket: this.bucket,
        Prefix: `planning-docs/${projectId}/`,
        MaxKeys: 1
      };

      const response = await this.s3.listObjectsV2(params).promise();
      const exists = response.Contents && response.Contents.length > 0;

      logger.debug(`Project ${projectId} exists in planning-docs: ${exists}`);
      return exists;
    } catch (error) {
      logger.error(`Error checking if project ${projectId} exists:`, error);
      throw error;
    }
  }

  /**
   * Check if a project folder exists in filter-docs
   * @param {string} projectId - Project ID to check
   */
  async projectExistsInFilter(projectId) {
    try {
      const params = {
        Bucket: this.bucket,
        Prefix: `filter-docs/${projectId}/`,
        MaxKeys: 1
      };

      const response = await this.s3.listObjectsV2(params).promise();
      return response.Contents && response.Contents.length > 0;
    } catch (error) {
      logger.error(`Error checking if project ${projectId} exists in filter-docs:`, error);
      throw error;
    }
  }

  /**
   * Create a baseline marker for a project (marks it as newly ingested, skip FI scan)
   * @param {string} projectId - Project ID
   * @param {Date} date - Date for the baseline marker (defaults to today)
   */
  async createBaselineMarker(projectId, date = new Date()) {
    try {
      const dateStr = date.toISOString().split('T')[0]; // YYYY-MM-DD
      const markerKey = `planning-docs/${projectId}/_baseline_${dateStr}`;

      await this.s3.putObject({
        Bucket: this.bucket,
        Key: markerKey,
        Body: JSON.stringify({
          createdAt: date.toISOString(),
          projectId: projectId,
          reason: 'First-time ingestion - baseline snapshot, not eligible for FI scan'
        }),
        ContentType: 'application/json'
      }).promise();

      logger.info(`📌 Created baseline marker for project ${projectId}: ${markerKey}`);
      return { projectId, markerKey, date: dateStr };
    } catch (error) {
      logger.error(`Error creating baseline marker for ${projectId}:`, error);
      throw error;
    }
  }

  /**
   * Check if a project has a baseline marker (any recent marker within last 24 hours)
   * This handles the timing gap where routing runs at 11PM but FI scan runs at 12:10AM next day
   * @param {string} projectId - Project ID
   * @param {Date} date - Date to check from (defaults to now)
   */
  async hasBaselineMarker(projectId, date = new Date()) {
    try {
      // Check for today's marker
      const todayStr = date.toISOString().split('T')[0];
      const todayKey = `planning-docs/${projectId}/_baseline_${todayStr}`;

      const todayExists = await this.objectExists(todayKey);
      if (todayExists) {
        logger.debug(`📌 Found today's baseline marker for project ${projectId}: ${todayKey}`);
        return true;
      }

      // Also check yesterday's marker (handles 11PM routing → 12:10AM scan edge case)
      const yesterday = new Date(date);
      yesterday.setDate(yesterday.getDate() - 1);
      const yesterdayStr = yesterday.toISOString().split('T')[0];
      const yesterdayKey = `planning-docs/${projectId}/_baseline_${yesterdayStr}`;

      const yesterdayExists = await this.objectExists(yesterdayKey);
      if (yesterdayExists) {
        logger.debug(`📌 Found yesterday's baseline marker for project ${projectId}: ${yesterdayKey}`);
        return true;
      }

      return false;
    } catch (error) {
      logger.error(`Error checking baseline marker for ${projectId}:`, error);
      return false;
    }
  }

  /**
   * Get all baseline markers for a project
   * @param {string} projectId - Project ID
   */
  async getBaselineMarkers(projectId) {
    try {
      const params = {
        Bucket: this.bucket,
        Prefix: `planning-docs/${projectId}/_baseline_`
      };

      const response = await this.s3.listObjectsV2(params).promise();
      return (response.Contents || []).map(obj => ({
        key: obj.Key,
        date: obj.Key.split('_baseline_')[1],
        lastModified: obj.LastModified
      }));
    } catch (error) {
      logger.error(`Error getting baseline markers for ${projectId}:`, error);
      return [];
    }
  }

  /**
   * Clean up old baseline markers (remove markers older than specified days)
   * @param {number} maxAgeDays - Maximum age in days (default: 1, keep only today's markers)
   */
  async cleanupOldBaselineMarkers(maxAgeDays = 1) {
    try {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - maxAgeDays);
      const cutoffStr = cutoffDate.toISOString().split('T')[0];

      // List all baseline markers across all projects
      const params = {
        Bucket: this.bucket,
        Prefix: 'planning-docs/'
      };

      let continuationToken = null;
      const markersToDelete = [];

      do {
        if (continuationToken) {
          params.ContinuationToken = continuationToken;
        }

        const response = await this.s3.listObjectsV2(params).promise();

        // Find baseline markers older than cutoff
        for (const obj of response.Contents || []) {
          if (obj.Key.includes('/_baseline_')) {
            const markerDate = obj.Key.split('_baseline_')[1];
            if (markerDate && markerDate < cutoffStr) {
              markersToDelete.push(obj.Key);
            }
          }
        }

        continuationToken = response.IsTruncated ? response.NextContinuationToken : null;
      } while (continuationToken);

      // Delete old markers
      if (markersToDelete.length > 0) {
        await this.deleteDocuments(markersToDelete);
        logger.info(`🧹 Cleaned up ${markersToDelete.length} old baseline markers`);
      } else {
        logger.info('🧹 No old baseline markers to clean up');
      }

      return { deleted: markersToDelete.length };
    } catch (error) {
      logger.error('Error cleaning up baseline markers:', error);
      throw error;
    }
  }

  /**
   * List all documents in filter-docs for a project
   * @param {string} projectId - Project ID
   */
  async listFilterDocsProject(projectId) {
    try {
      const projectPath = `filter-docs/${projectId}/`;
      const allDocuments = [];
      let continuationToken = null;

      do {
        const params = {
          Bucket: this.bucket,
          Prefix: projectPath,
          MaxKeys: 1000
        };

        if (continuationToken) {
          params.ContinuationToken = continuationToken;
        }

        const response = await this.s3.listObjectsV2(params).promise();

        const documents = (response.Contents || []).map(obj => ({
          key: obj.Key,
          fileName: path.basename(obj.Key),
          size: obj.Size,
          lastModified: obj.LastModified,
          projectId: projectId
        }));

        allDocuments.push(...documents);
        continuationToken = response.IsTruncated ? response.NextContinuationToken : null;
      } while (continuationToken);

      return allDocuments;
    } catch (error) {
      logger.error(`Error listing filter-docs for project ${projectId}:`, error);
      throw error;
    }
  }

  /**
   * List all documents in planning-docs for a project (including system files)
   * @param {string} projectId - Project ID
   */
  async listPlanningDocsProject(projectId) {
    try {
      const projectPath = `planning-docs/${projectId}/`;
      const allDocuments = [];
      let continuationToken = null;

      do {
        const params = {
          Bucket: this.bucket,
          Prefix: projectPath,
          MaxKeys: 1000
        };

        if (continuationToken) {
          params.ContinuationToken = continuationToken;
        }

        const response = await this.s3.listObjectsV2(params).promise();

        const documents = (response.Contents || []).map(obj => ({
          key: obj.Key,
          fileName: path.basename(obj.Key),
          size: obj.Size,
          lastModified: obj.LastModified,
          projectId: projectId
        }));

        allDocuments.push(...documents);
        continuationToken = response.IsTruncated ? response.NextContinuationToken : null;
      } while (continuationToken);

      return allDocuments;
    } catch (error) {
      logger.error(`Error listing planning-docs for project ${projectId}:`, error);
      throw error;
    }
  }

  /**
   * Check whether a planning-docs file is a scan-eligible source document.
   * Source documents are the primary files we scan for FI (PDF/DOCX).
   * @param {string} fileName - File name to evaluate
   * @returns {boolean}
   */
  isSourceDocumentFile(fileName) {
    if (!fileName) return false;
    const lower = fileName.toLowerCase();
    return lower.endsWith('.pdf') || lower.endsWith('.docx');
  }

  /**
   * Check whether a planning-docs file is a system/non-source file.
   * @param {string} fileName - File name to evaluate
   * @returns {boolean}
   */
  isSystemOrDocfilesFile(fileName) {
    if (!fileName) return true;

    const lower = fileName.toLowerCase();
    return (
      lower === 'docfiles.txt' ||
      lower === '.keep' ||
      fileName.startsWith('_baseline_') ||
      fileName.startsWith('.')
    );
  }

  /**
   * Get planning-docs content profile for baseline decisions.
   *
    * A project with only docfiles/system files should be treated as
    * effectively non-existent for first-ingestion baseline semantics.
   *
   * @param {string} projectId - Project ID
   * @returns {object} Content profile
   */
  async getPlanningProjectContentProfile(projectId) {
    try {
      const planningDocs = await this.listPlanningDocsProject(projectId);

      // Remove folder marker rows and empty basenames.
      const files = planningDocs.filter(doc => !!doc.fileName);
      const sourceDocs = files.filter(doc => this.isSourceDocumentFile(doc.fileName));
      const docfilesEntries = files.filter(doc => doc.fileName.toLowerCase() === 'docfiles.txt');
      const nonSystemNonSourceFiles = files.filter(
        doc => !this.isSystemOrDocfilesFile(doc.fileName) && !this.isSourceDocumentFile(doc.fileName)
      );

      const hasSourceDocs = sourceDocs.length > 0;
      const hasOnlyDocfilesOrSystem = files.length > 0 && !hasSourceDocs && nonSystemNonSourceFiles.length === 0;

      return {
        exists: files.length > 0,
        hasSourceDocs,
        hasOnlyDocfilesOrSystem,
        sourceDocCount: sourceDocs.length,
        docfilesCount: docfilesEntries.length,
        nonSystemNonSourceCount: nonSystemNonSourceFiles.length
      };
    } catch (error) {
      logger.error(`Error building planning-docs content profile for ${projectId}:`, error);
      throw error;
    }
  }
}

module.exports = new S3Service();