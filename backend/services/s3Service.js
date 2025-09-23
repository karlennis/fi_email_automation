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
   */
  async listProjectDocuments(projectId) {
    try {
      // First find where this project is located
      const projectPath = await this.findProjectPath(projectId);
      if (!projectPath) {
        logger.warn(`Project ${projectId} not found in any folder`);
        return [];
      }

      const params = {
        Bucket: this.bucket,
        Prefix: projectPath,
        MaxKeys: 1000
      };

      const response = await this.s3.listObjectsV2(params).promise();

      return response.Contents
        .filter(obj => obj.Key.toLowerCase().endsWith('.pdf'))
        .map(obj => ({
          key: obj.Key,
          fileName: path.basename(obj.Key),
          size: obj.Size,
          lastModified: obj.LastModified,
          projectId: projectId,
          folderPath: projectPath
        }));

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
   */
  async listMainFolders() {
    try {
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
}

module.exports = new S3Service();