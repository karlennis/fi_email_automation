/**
 * Document Ingestion Service
 * 
 * Handles the filter-docs first ingestion architecture:
 * 1. All scraped documents first land in filter-docs/
 * 2. Documents are then routed to planning-docs/ based on project status
 * 3. New projects get baseline markers (ineligible for FI scan)
 * 4. Existing projects get incremental updates (eligible for FI scan)
 */

const s3Service = require('./s3Service');
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

// Configuration
const CONFIG = {
  // Number of concurrent S3 copy operations per project
  COPY_CONCURRENCY: 50,
  // Number of projects to process in parallel during batch routing
  PROJECT_CONCURRENCY: 5,
  // Delay between project batches (ms)
  BATCH_DELAY: 100
};

class DocumentIngestionService {
  constructor() {
    this.stats = {
      totalIngested: 0,
      newProjects: 0,
      existingProjects: 0,
      documentsRouted: 0,
      errors: 0
    };
  }

  /**
   * Reset ingestion statistics
   */
  resetStats() {
    this.stats = {
      totalIngested: 0,
      newProjects: 0,
      existingProjects: 0,
      documentsRouted: 0,
      errors: 0
    };
  }

  /**
   * Process items in parallel with controlled concurrency
   * @param {Array} items - Items to process
   * @param {Function} processor - Async function to process each item
   * @param {number} concurrency - Max concurrent operations
   * @returns {Array} Results array with {item, result, error} for each item
   */
  async processInParallel(items, processor, concurrency = CONFIG.COPY_CONCURRENCY) {
    const results = [];
    const executing = new Set();

    for (const item of items) {
      const promise = processor(item)
        .then(result => ({ item, result, error: null }))
        .catch(error => ({ item, result: null, error }));

      results.push(promise);
      executing.add(promise);

      promise.finally(() => executing.delete(promise));

      if (executing.size >= concurrency) {
        await Promise.race(executing);
      }
    }

    return Promise.all(results);
  }

  /**
   * Ingest documents to filter-docs for a project
   * This is the first stage - raw scrape, no filtering
   * 
   * @param {string} projectId - Project ID
   * @param {Array} documents - Array of {buffer, fileName} or {localPath, fileName}
   * @returns {object} Ingestion result
   */
  async ingestToFilterDocs(projectId, documents) {
    const results = {
      projectId,
      successful: [],
      failed: [],
      totalSize: 0
    };

    logger.info(`📥 Ingesting ${documents.length} documents to filter-docs/${projectId}/`);

    for (const doc of documents) {
      try {
        const s3Key = `filter-docs/${projectId}/${doc.fileName}`;
        const content = doc.buffer || doc.localPath;
        
        const result = await s3Service.uploadDocument(content, s3Key);
        results.successful.push({
          fileName: doc.fileName,
          key: s3Key,
          size: result.size
        });
        results.totalSize += result.size;
        this.stats.totalIngested++;
      } catch (error) {
        logger.error(`Failed to ingest ${doc.fileName} for project ${projectId}:`, error);
        results.failed.push({
          fileName: doc.fileName,
          error: error.message
        });
        this.stats.errors++;
      }
    }

    logger.info(`✅ Ingested ${results.successful.length}/${documents.length} documents for project ${projectId}`);
    return results;
  }

  /**
   * Route documents from filter-docs to planning-docs
   * This is the core routing logic that handles new vs existing projects
   * Uses parallel processing for high throughput (50 concurrent copies)
   * 
   * @param {string} projectId - Project ID to route
   * @returns {object} Routing result with details
   */
  async routeToPlanning(projectId) {
    const result = {
      projectId,
      isNewProject: false,
      isBaselined: false,
      documentsCopied: 0,
      documentsSkipped: 0,
      newDocuments: [],
      errors: [],
      durationMs: 0
    };

    const startTime = Date.now();

    try {
      // Step 1: Check if project already exists in planning-docs
      const existsInPlanning = await s3Service.projectExistsInPlanning(projectId);
      result.isNewProject = !existsInPlanning;

      // Step 2: Get documents from filter-docs
      const filterDocs = await s3Service.listFilterDocsProject(projectId);
      
      if (filterDocs.length === 0) {
        logger.warn(`No documents found in filter-docs/${projectId}/`);
        return result;
      }

      logger.info(`🔄 Routing ${filterDocs.length} documents for project ${projectId} (${result.isNewProject ? 'NEW' : 'EXISTING'} project)`);

      if (result.isNewProject) {
        // NEW PROJECT: Copy everything in parallel and create baseline marker
        result.isBaselined = true;
        this.stats.newProjects++;

        // Parallel copy all documents
        const copyResults = await this.processInParallel(filterDocs, async (doc) => {
          const destKey = doc.key.replace('filter-docs/', 'planning-docs/');
          await s3Service.copyDocument(doc.key, destKey);
          return doc.fileName;
        });

        // Process results
        for (const { item, result: fileName, error } of copyResults) {
          if (error) {
            logger.error(`Failed to copy ${item.fileName}:`, error);
            result.errors.push({ fileName: item.fileName, error: error.message });
          } else {
            result.documentsCopied++;
            result.newDocuments.push(fileName);
            this.stats.documentsRouted++;
          }
        }

        // Create baseline marker to prevent FI scan
        await s3Service.createBaselineMarker(projectId);
        logger.info(`📌 Project ${projectId} baselined with ${result.documentsCopied} documents (will skip FI scan)`);

      } else {
        // EXISTING PROJECT: Only copy genuinely new documents
        this.stats.existingProjects++;

        // Get existing documents in planning-docs
        const planningDocs = await s3Service.listPlanningDocsProject(projectId);
        const existingFileNames = new Set(
          planningDocs
            .filter(d => !d.fileName.startsWith('_baseline_')) // Exclude markers
            .map(d => d.fileName)
        );

        // Filter to only new documents
        const newDocs = filterDocs.filter(doc => !existingFileNames.has(doc.fileName));
        const skippedDocs = filterDocs.filter(doc => existingFileNames.has(doc.fileName));
        result.documentsSkipped = skippedDocs.length;

        if (newDocs.length > 0) {
          // Parallel copy new documents only
          const copyResults = await this.processInParallel(newDocs, async (doc) => {
            const destKey = doc.key.replace('filter-docs/', 'planning-docs/');
            await s3Service.copyDocument(doc.key, destKey);
            return doc.fileName;
          });

          // Process results
          for (const { item, result: fileName, error } of copyResults) {
            if (error) {
              logger.error(`Failed to process ${item.fileName}:`, error);
              result.errors.push({ fileName: item.fileName, error: error.message });
            } else {
              result.documentsCopied++;
              result.newDocuments.push(fileName);
              this.stats.documentsRouted++;
            }
          }
        }

        logger.info(`✅ Project ${projectId}: ${result.documentsCopied} new, ${result.documentsSkipped} existing (eligible for FI scan)`);
      }

      result.durationMs = Date.now() - startTime;
      return result;

    } catch (error) {
      logger.error(`Error routing project ${projectId}:`, error);
      result.errors.push({ error: error.message });
      result.durationMs = Date.now() - startTime;
      this.stats.errors++;
      return result;
    }
  }

  /**
   * Clean up filter-docs after successful routing
   * 
   * @param {string} projectId - Project ID to clean up
   * @returns {object} Cleanup result
   */
  async cleanupFilterDocs(projectId) {
    try {
      const filterDocs = await s3Service.listFilterDocsProject(projectId);
      
      if (filterDocs.length === 0) {
        return { projectId, deleted: 0 };
      }

      const keys = filterDocs.map(d => d.key);
      const result = await s3Service.deleteDocuments(keys);
      
      logger.info(`🧹 Cleaned up ${result.deleted} documents from filter-docs/${projectId}/`);
      return { projectId, deleted: result.deleted };
    } catch (error) {
      logger.error(`Error cleaning up filter-docs for ${projectId}:`, error);
      throw error;
    }
  }

  /**
   * Full ingestion pipeline: ingest → route → cleanup
   * 
   * @param {string} projectId - Project ID
   * @param {Array} documents - Documents to ingest
   * @param {object} options - Pipeline options
   * @returns {object} Full pipeline result
   */
  async ingestAndRoute(projectId, documents, options = {}) {
    const { cleanupAfter = true } = options;
    
    const pipelineResult = {
      projectId,
      ingestion: null,
      routing: null,
      cleanup: null,
      success: false
    };

    try {
      // Step 1: Ingest to filter-docs
      pipelineResult.ingestion = await this.ingestToFilterDocs(projectId, documents);
      
      if (pipelineResult.ingestion.successful.length === 0) {
        logger.warn(`No documents successfully ingested for ${projectId}`);
        return pipelineResult;
      }

      // Step 2: Route to planning-docs
      pipelineResult.routing = await this.routeToPlanning(projectId);

      // Step 3: Cleanup filter-docs (optional)
      if (cleanupAfter && pipelineResult.routing.errors.length === 0) {
        pipelineResult.cleanup = await this.cleanupFilterDocs(projectId);
      }

      pipelineResult.success = pipelineResult.routing.errors.length === 0;
      return pipelineResult;

    } catch (error) {
      logger.error(`Pipeline error for ${projectId}:`, error);
      pipelineResult.error = error.message;
      return pipelineResult;
    }
  }

  /**
   * Route multiple projects from filter-docs to planning-docs
   * Uses parallel processing: 5 projects at a time, 50 docs per project concurrent
   * 
   * @param {string[]} projectIds - Array of project IDs to route
   * @returns {object} Batch routing results
   */
  async batchRouteToPlanning(projectIds) {
    const results = {
      total: projectIds.length,
      successful: 0,
      failed: 0,
      newProjects: 0,
      existingProjects: 0,
      totalDocumentsRouted: 0,
      projectResults: [],
      durationMs: 0
    };

    const startTime = Date.now();
    logger.info(`🚀 Starting batch routing for ${projectIds.length} projects (${CONFIG.PROJECT_CONCURRENCY} parallel)`);

    // Process projects in parallel batches
    const projectResults = await this.processInParallel(
      projectIds,
      async (projectId) => await this.routeToPlanning(projectId),
      CONFIG.PROJECT_CONCURRENCY
    );

    // Aggregate results
    for (const { item: projectId, result: routeResult, error } of projectResults) {
      if (error) {
        logger.error(`Batch routing failed for ${projectId}:`, error);
        results.failed++;
        results.projectResults.push({ projectId, error: error.message });
      } else {
        if (routeResult.errors.length === 0) {
          results.successful++;
        } else {
          results.failed++;
        }

        if (routeResult.isNewProject) {
          results.newProjects++;
        } else {
          results.existingProjects++;
        }

        results.totalDocumentsRouted += routeResult.documentsCopied;
        results.projectResults.push(routeResult);
      }
    }

    results.durationMs = Date.now() - startTime;
    const docsPerSecond = results.totalDocumentsRouted / (results.durationMs / 1000);

    logger.info(`✅ Batch routing complete: ${results.successful}/${results.total} successful (${(results.durationMs / 1000).toFixed(1)}s)`);
    logger.info(`   New projects: ${results.newProjects}, Existing: ${results.existingProjects}`);
    logger.info(`   Total documents routed: ${results.totalDocumentsRouted} (${docsPerSecond.toFixed(0)} docs/sec)`);

    return results;
  }

  /**
   * Check if a project should be skipped in FI scan (has baseline marker for today)
   * 
   * @param {string} projectId - Project ID to check
   * @returns {boolean} True if project should be skipped
   */
  async shouldSkipFIScan(projectId) {
    return await s3Service.hasBaselineMarker(projectId);
  }

  /**
   * Get ingestion statistics
   */
  getStats() {
    return { ...this.stats };
  }

  /**
   * List all projects currently in filter-docs (staging area)
   * @returns {string[]} Array of project IDs
   */
  async listStagedProjects() {
    try {
      const params = {
        Bucket: s3Service.bucket,
        Prefix: 'filter-docs/',
        Delimiter: '/'
      };

      const response = await s3Service.s3.listObjectsV2(params).promise();
      
      const projectIds = (response.CommonPrefixes || [])
        .map(prefix => prefix.Prefix.replace('filter-docs/', '').replace('/', ''))
        .filter(id => id);

      return projectIds;
    } catch (error) {
      logger.error('Error listing staged projects:', error);
      throw error;
    }
  }

  /**
   * Get summary of projects with baseline markers
   * @returns {object} Summary of baselined projects
   */
  async getBaselinedProjectsSummary() {
    try {
      // This is a simplified version - for full implementation,
      // we'd need to scan planning-docs for _baseline_* files
      const today = new Date().toISOString().split('T')[0];
      
      // Get projects from planning-docs and check for today's markers
      const projects = await s3Service.listPlanningDocsProjects();
      const baselinedToday = [];

      // Sample check first 100 projects (for performance)
      const sampleSize = Math.min(projects.length, 100);
      for (let i = 0; i < sampleSize; i++) {
        const projectId = projects[i].projectId;
        if (await s3Service.hasBaselineMarker(projectId)) {
          baselinedToday.push(projectId);
        }
      }

      return {
        date: today,
        baselinedTodayCount: baselinedToday.length,
        baselinedTodaySample: baselinedToday.slice(0, 20),
        note: sampleSize < projects.length ? `Sampled ${sampleSize} of ${projects.length} projects` : 'All projects checked'
      };
    } catch (error) {
      logger.error('Error getting baselined projects summary:', error);
      throw error;
    }
  }
}

module.exports = new DocumentIngestionService();
