const Queue = require('bull');
const redis = require('redis');
const schedule = require('node-schedule');
const winston = require('winston');
const s3Service = require('./s3Service');
const buildingInfoService = require('./buildingInfoService');
const fiDetectionService = require('./fiDetectionService');
const documentProcessor = require('./documentProcessor');
const emailService = require('./emailService');
const Project = require('../models/Project');
const Customer = require('../models/Customer');

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'logs/jobs.log' })
  ]
});

class JobSchedulerService {
  constructor() {
    // Create Redis connection
    this.redisClient = redis.createClient({
      url: process.env.REDIS_URL || 'redis://localhost:6379'
    });

    // Create job queues
    this.processQueue = new Queue('document processing', process.env.REDIS_URL || 'redis://localhost:6379');
    this.emailQueue = new Queue('email notifications', process.env.REDIS_URL || 'redis://localhost:6379');

    this.setupQueueProcessors();
    this.setupScheduledJobs();
  }

  /**
   * Setup queue processors
   */
  setupQueueProcessors() {
    // Document processing queue
    this.processQueue.process('process-project-documents', parseInt(process.env.QUEUE_CONCURRENCY) || 3, async (job) => {
      const { projectId, reportTypes, customerEmails } = job.data;
      return await this.processProjectDocuments(projectId, reportTypes, customerEmails);
    });

    // Batch processing queue
    this.processQueue.process('process-batch-documents', 1, async (job) => {
      const { projectIds, reportTypes, customerEmails } = job.data;
      return await this.processBatchDocuments(projectIds, reportTypes, customerEmails);
    });

    // Email notification queue
    this.emailQueue.process('send-fi-notifications', 5, async (job) => {
      const { fiRequestId, customerEmails } = job.data;
      return await this.sendFINotifications(fiRequestId, customerEmails);
    });

    // Queue event handlers
    this.processQueue.on('completed', (job, result) => {
      logger.info(`Job ${job.id} completed:`, result);
    });

    this.processQueue.on('failed', (job, err) => {
      logger.error(`Job ${job.id} failed:`, err);
    });

    this.emailQueue.on('completed', (job, result) => {
      logger.info(`Email job ${job.id} completed:`, result);
    });

    this.emailQueue.on('failed', (job, err) => {
      logger.error(`Email job ${job.id} failed:`, err);
    });
  }

  /**
   * Setup scheduled jobs
   */
  setupScheduledJobs() {
    // Daily cleanup job at 2 AM
    schedule.scheduleJob('0 2 * * *', async () => {
      logger.info('Starting daily cleanup job');
      try {
        await s3Service.cleanupDownloads(24);
        await documentProcessor.cleanupOCRCache(7);
        logger.info('Daily cleanup job completed');
      } catch (error) {
        logger.error('Daily cleanup job failed:', error);
      }
    });

    // Weekly cache cleanup on Sundays at 1 AM
    schedule.scheduleJob('0 1 * * 0', async () => {
      logger.info('Starting weekly cache cleanup');
      try {
        buildingInfoService.clearCache();
        logger.info('Weekly cache cleanup completed');
      } catch (error) {
        logger.error('Weekly cache cleanup failed:', error);
      }
    });
  }

  /**
   * Schedule processing of a single project
   */
  async scheduleProjectProcessing(projectId, reportTypes, customerEmails, delay = 0) {
    const jobOptions = {
      delay: delay,
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 2000
      }
    };

    const job = await this.processQueue.add('process-project-documents', {
      projectId,
      reportTypes,
      customerEmails,
      scheduledAt: new Date()
    }, jobOptions);

    logger.info(`Scheduled processing for project ${projectId}, job ID: ${job.id}`);
    return job;
  }

  /**
   * Schedule batch processing of multiple projects
   */
  async scheduleBatchProcessing(projectIds, reportTypes, customerEmails, scheduleTime = null) {
    const delay = scheduleTime ? new Date(scheduleTime).getTime() - Date.now() : 0;

    const jobOptions = {
      delay: Math.max(0, delay),
      attempts: 2,
      backoff: {
        type: 'exponential',
        delay: 5000
      }
    };

    const job = await this.processQueue.add('process-batch-documents', {
      projectIds,
      reportTypes,
      customerEmails,
      scheduledAt: scheduleTime || new Date()
    }, jobOptions);

    logger.info(`Scheduled batch processing for ${projectIds.length} projects, job ID: ${job.id}`);
    return job;
  }

  /**
   * Process documents for a single project
   */
  async processProjectDocuments(projectId, reportTypes, customerEmails) {
    const startTime = Date.now();
    const results = {
      projectId,
      reportTypes,
      processedDocuments: 0,
      fiRequestsFound: 0,
      emailsSent: 0,
      errors: []
    };

    try {
      logger.info(`Starting processing for project ${projectId}`);

      // Get project metadata
      const projectMetadata = await buildingInfoService.getProjectMetadata(projectId);

      // Find or create project record
      let project = await Project.findOne({ projectId });
      if (!project) {
        project = new Project({
          projectId,
          title: projectMetadata.planning_title,
          planningAuthority: projectMetadata.planning_authority,
          status: projectMetadata.planning_status,
          stage: projectMetadata.planning_stage,
          sector: projectMetadata.planning_sector,
          location: projectMetadata.planning_location,
          applicant: projectMetadata.planning_applicant
        });
        await project.save();
      }

      // Download documents from S3
      const documents = await s3Service.downloadProjectDocuments(projectId);
      results.processedDocuments = documents.length;

      if (documents.length === 0) {
        logger.warn(`No documents found for project ${projectId}`);
        return results;
      }

      // Process each report type
      for (const reportType of reportTypes) {
        const reportResults = await this.processDocumentsForReportType(
          documents,
          reportType,
          project,
          projectMetadata
        );

        results.fiRequestsFound += reportResults.fiRequestsFound;

        // FI request notifications simplified - use documents-browser batch email system instead
      }

      // Cleanup downloaded files
      for (const doc of documents) {
        try {
          await require('fs').promises.unlink(doc.localPath);
        } catch (error) {
          logger.warn(`Failed to cleanup ${doc.localPath}:`, error.message);
        }
      }

      const duration = Date.now() - startTime;
      logger.info(`Completed processing for project ${projectId} in ${duration}ms`, results);

      return results;

    } catch (error) {
      logger.error(`Error processing project ${projectId}:`, error);
      results.errors.push(error.message);
      throw error;
    }
  }

  /**
   * Process documents for a specific report type - OPTIMIZED VERSION
   */
  async processDocumentsForReportType(documents, reportType, project, projectMetadata) {
    const results = {
      reportType,
      fiRequestsFound: 0,
      documentsProcessed: 0,
      documentsSkipped: 0,
      earlyTermination: false,
      detectionMethods: {}
    };

    // OPTIMIZATION 1: Prioritize documents by likelihood of containing FI requests
    const prioritizedDocs = fiDetectionService.prioritizeDocuments([...documents]);

    logger.info(`Processing ${prioritizedDocs.length} documents for ${reportType} in project ${project.projectId}`);

    for (const doc of prioritizedDocs) {
      try {
        results.documentsProcessed++;

        // Process document to extract text
        const processedDoc = await documentProcessor.processDocument(doc.localPath, doc.fileName);

        // Check for FI requests using optimized detection
        const fiResult = await fiDetectionService.processFIRequest(
          processedDoc.text,
          reportType,
          doc.fileName
        );

        // Track detection methods for analytics
        if (fiResult.detectionMethod) {
          results.detectionMethods[fiResult.detectionMethod] = (results.detectionMethods[fiResult.detectionMethod] || 0) + 1;
        }

        if (fiResult.isFIRequest && fiResult.matchesTargetType) {
          results.fiRequestsFound++;

          logger.info(`FI request detected for ${reportType} in project ${project.projectId}: ${doc.fileName} (method: ${fiResult.detectionMethod})`);

          // OPTIMIZATION 2: EARLY TERMINATION - Once we find an FI request for this report type, stop processing
          // This is the key optimization - FI requests are typically single documents per report type
          results.earlyTermination = true;
          results.documentsSkipped = prioritizedDocs.length - results.documentsProcessed;

          logger.info(`EARLY TERMINATION: Found FI request for ${reportType}, skipping remaining ${results.documentsSkipped} documents`);
          break;
        }

      } catch (error) {
        logger.error(`Error processing document ${doc.fileName}:`, error);
      }
    }

    logger.info(`Completed ${reportType} processing for project ${project.projectId}: ${results.fiRequestsFound} FI requests found, ${results.documentsProcessed} processed, ${results.documentsSkipped} skipped`);
    return results;
  }

  /**
   * Process multiple projects in batch - OPTIMIZED VERSION
   */
  async processBatchDocuments(projectIds, reportTypes, customerEmails) {
    const batchResults = {
      totalProjects: projectIds.length,
      completedProjects: 0,
      totalFIRequests: 0,
      totalEmailsSent: 0,
      totalDocumentsProcessed: 0,
      totalDocumentsSkipped: 0,
      earlyTerminations: 0,
      detectionMethods: {},
      errors: []
    };

    logger.info(`Starting OPTIMIZED batch processing for ${projectIds.length} projects with early termination enabled`);

    for (const projectId of projectIds) {
      try {
        const result = await this.processProjectDocuments(projectId, reportTypes, customerEmails);
        batchResults.completedProjects++;
        batchResults.totalFIRequests += result.fiRequestsFound;
        batchResults.totalEmailsSent += result.emailsSent;

        // Track optimization metrics
        if (result.reportTypeResults) {
          for (const reportResult of result.reportTypeResults) {
            batchResults.totalDocumentsProcessed += reportResult.documentsProcessed || 0;
            batchResults.totalDocumentsSkipped += reportResult.documentsSkipped || 0;
            if (reportResult.earlyTermination) batchResults.earlyTerminations++;

            // Aggregate detection methods
            if (reportResult.detectionMethods) {
              for (const [method, count] of Object.entries(reportResult.detectionMethods)) {
                batchResults.detectionMethods[method] = (batchResults.detectionMethods[method] || 0) + count;
              }
            }
          }
        }

      } catch (error) {
        batchResults.errors.push(`Project ${projectId}: ${error.message}`);
      }

      // Small delay between projects to avoid overwhelming the system
      await new Promise(resolve => setTimeout(resolve, 500)); // Reduced delay since we're more efficient
    }

    // Log optimization statistics
    const cacheStats = fiDetectionService.getCacheStats();
    logger.info(`BATCH OPTIMIZATION RESULTS:
      - Projects processed: ${batchResults.completedProjects}/${batchResults.totalProjects}
      - Documents processed: ${batchResults.totalDocumentsProcessed}
      - Documents skipped via early termination: ${batchResults.totalDocumentsSkipped}
      - Early terminations: ${batchResults.earlyTerminations}
      - Cache hit rate: ${cacheStats.hitRate.toFixed(1)}%
      - Detection methods: ${JSON.stringify(batchResults.detectionMethods, null, 2)}
    `);

    batchResults.cacheStats = cacheStats;
    return batchResults;

    logger.info('Batch processing completed:', batchResults);
    return batchResults;
  }

  /**
   * Send FI notifications
   */
  async sendFINotifications(fiRequestId, customerEmails) {
    // Simplified - FI request functionality has been removed
    try {
      const results = {
        fiRequestId,
        emailsSent: 0,
        emailsFailed: 0,
        errors: []
      };

      logger.info(`FI notification job simplified - FI request functionality removed`);
      return results;

    } catch (error) {
      logger.error(`Error sending FI notifications:`, error);
      throw error;
    }
  }

  /**
   * Get job statistics
   */
  async getJobStats() {
    const [processWaiting, processActive, processCompleted, processFailed] = await Promise.all([
      this.processQueue.getWaiting(),
      this.processQueue.getActive(),
      this.processQueue.getCompleted(),
      this.processQueue.getFailed()
    ]);

    const [emailWaiting, emailActive, emailCompleted, emailFailed] = await Promise.all([
      this.emailQueue.getWaiting(),
      this.emailQueue.getActive(),
      this.emailQueue.getCompleted(),
      this.emailQueue.getFailed()
    ]);

    return {
      processQueue: {
        waiting: processWaiting.length,
        active: processActive.length,
        completed: processCompleted.length,
        failed: processFailed.length
      },
      emailQueue: {
        waiting: emailWaiting.length,
        active: emailActive.length,
        completed: emailCompleted.length,
        failed: emailFailed.length
      }
    };
  }

  /**
   * Cancel a job
   */
  async cancelJob(jobId, queueType = 'process') {
    const queue = queueType === 'email' ? this.emailQueue : this.processQueue;
    const job = await queue.getJob(jobId);

    if (job) {
      await job.remove();
      logger.info(`Cancelled job ${jobId} from ${queueType} queue`);
      return true;
    }

    return false;
  }
}

module.exports = new JobSchedulerService();