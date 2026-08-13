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

const logger = require('../utils/logger');

// Configuration
const CONFIG = {
  // Number of concurrent S3 copy operations per project
  COPY_CONCURRENCY: 50,
  // Number of projects to process in parallel during batch routing
  PROJECT_CONCURRENCY: 5,
  // Delay between project batches (ms)
  BATCH_DELAY: 100
};

const KEEP_FILE_NAME = '.keep';

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
      // filter-docs keys this run accounted for: either copied successfully, or already
      // present in planning-docs with identical content. Only these may be deleted at
      // cleanup - see cleanupFilterDocs.
      handledKeys: [],
      durationMs: 0
    };

    const startTime = Date.now();

    try {
      // Step 1: Classify current planning-docs project state.
      // Treat projects with only docfiles/system files as effectively new.
      const planningProfile = await s3Service.getPlanningProjectContentProfile(projectId);
      result.isNewProject = !planningProfile.exists || planningProfile.hasOnlyDocfilesOrSystem;

      // Step 2: Get documents from filter-docs
      const filterDocs = (await s3Service.listFilterDocsProject(projectId))
        .filter(doc => doc.fileName !== KEEP_FILE_NAME);

      const incomingBaselineTriggerCount = filterDocs.filter(doc =>
        !s3Service.isSystemOrDocfilesFile(doc.fileName)
      ).length;

      if (filterDocs.length === 0) {
        logger.warn(`No documents found in filter-docs/${projectId}/`);
        return result;
      }

      if (result.isNewProject && planningProfile.exists && planningProfile.hasOnlyDocfilesOrSystem) {
        logger.info(
          `🔄 Routing ${filterDocs.length} documents for project ${projectId} (NEW project semantics: docfiles/system-only in planning-docs, sourceDocCount=${planningProfile.sourceDocCount}, docfilesCount=${planningProfile.docfilesCount})`
        );
      } else {
        logger.info(`🔄 Routing ${filterDocs.length} documents for project ${projectId} (${result.isNewProject ? 'NEW' : 'EXISTING'} project)`);
      }

      if (result.isNewProject) {
        // NEW PROJECT SEMANTICS: Copy everything in parallel.
        // Baseline marker is created only when the incoming batch contains
        // any non-docfiles/system file.
        result.isBaselined = false;
        this.stats.newProjects++;

        // MARKER FIRST, then the copies.
        //
        // This used to run the other way round, leaving a window - the whole parallel
        // copy - in which a crash or restart left a fully populated new project with no
        // marker. The next FI scan then treated that project's entire historical
        // back-catalogue as fresh uploads and emailed customers every FI request in it.
        //
        // Ordering it first inverts the failure: a crash after the marker leaves a
        // baselined project with some documents missing, and the next run re-copies them
        // (the ETag/size comparison makes that idempotent). Worst case is one project
        // skipped for the retention window instead of a mass false-lead send.
        if (incomingBaselineTriggerCount > 0) {
          try {
            await s3Service.createBaselineMarker(projectId);
            result.isBaselined = true;
          } catch (error) {
            // Copying unbaselined is the exact failure this ordering exists to prevent,
            // so abandon the project for this run rather than proceed without a marker.
            logger.error(`Failed to create baseline marker for ${projectId} - skipping its documents this run:`, error);
            result.errors.push({ fileName: '_baseline_', error: error.message });
            return result;
          }
        }

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
            result.handledKeys.push(item.key);
            this.stats.documentsRouted++;
          }
        }

        if (result.isBaselined) {
          logger.info(`📌 Project ${projectId} baselined with ${result.documentsCopied} documents (non-docfiles files in batch: ${incomingBaselineTriggerCount}, will skip FI scan)`);
        } else {
          logger.info(`ℹ️ Project ${projectId} routed with NEW semantics but no non-docfiles files in batch (docfiles/system-only); baseline marker not created yet`);
        }

      } else {
        // EXISTING PROJECT: Only copy genuinely new documents
        this.stats.existingProjects++;

        // Get existing documents in planning-docs
        const planningDocs = await s3Service.listPlanningDocsProject(projectId);
        const existingByName = new Map(
          planningDocs
            .filter(d => !d.fileName.startsWith('_baseline_')) // Exclude markers
            .map(d => [d.fileName, d])
        );

        // Copy anything whose name is new, OR whose content differs from the copy already
        // in planning-docs.
        //
        // Comparing filenames alone silently destroyed re-issued documents: authorities
        // routinely republish under the same name (a revised "FI Request.pdf"), the file
        // was skipped as already-present, and with INGESTION_CLEANUP_FILTER_DOCS=true the
        // staged copy was then deleted - losing the new version from both locations.
        // A multipart ETag ("<md5>-<partCount>") is not a plain MD5 and is NOT preserved
        // by copyObject, which writes a single-part object. Comparing one against the
        // other would report "changed" on every run - re-copying the file nightly, which
        // in turn refreshes its LastModified and makes the FI scanner reprocess the whole
        // corpus every night. Only compare ETags when both are single-part.
        const isSinglePartEtag = (etag) => !!etag && !/-\d+$/.test(etag);

        const isUnchanged = (doc) => {
          const existing = existingByName.get(doc.fileName);
          if (!existing) return false;
          if (isSinglePartEtag(doc.etag) && isSinglePartEtag(existing.etag)) {
            return doc.etag === existing.etag;
          }
          // Fall back to size, which is stable across a copy either way.
          return doc.size === existing.size;
        };

        const newDocs = filterDocs.filter(doc => !isUnchanged(doc));
        const skippedDocs = filterDocs.filter(doc => isUnchanged(doc));
        result.documentsSkipped = skippedDocs.length;

        const revisedDocs = newDocs.filter(doc => existingByName.has(doc.fileName));
        if (revisedDocs.length > 0) {
          logger.info(
            `♻️ Project ${projectId}: ${revisedDocs.length} document(s) changed content under an existing name, re-copying: ` +
            revisedDocs.map(d => d.fileName).join(', ')
          );
        }

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
              result.handledKeys.push(item.key);
              this.stats.documentsRouted++;
            }
          }
        }

        // Identical copies already in planning-docs are safe to remove from staging.
        result.handledKeys.push(...skippedDocs.map(doc => doc.key));

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
  /**
   * @param {string} projectId
   * @param {string[]|null} handledKeys - filter-docs keys this run copied or verified.
   *   When provided, only these are deleted. Omitting it restores the old behaviour of
   *   deleting everything under the prefix and is unsafe while the scraper is writing.
   */
  async cleanupFilterDocs(projectId, handledKeys = null) {
    try {
      const filterDocs = await s3Service.listFilterDocsProject(projectId);
      let deleteCandidates = filterDocs.filter(doc => doc.fileName !== KEEP_FILE_NAME);

      // Delete only what routing actually accounted for.
      //
      // This used to re-list the prefix and delete everything it found. Because the
      // routing snapshot is taken at the start of a run that can span the whole batch,
      // any file the scraper wrote in between was deleted without ever being copied to
      // planning-docs - lost outright.
      if (handledKeys) {
        const handled = new Set(handledKeys);
        const unhandled = deleteCandidates.filter(doc => !handled.has(doc.key));
        deleteCandidates = deleteCandidates.filter(doc => handled.has(doc.key));

        if (unhandled.length > 0) {
          logger.info(
            `⏭️ Leaving ${unhandled.length} unrouted file(s) in filter-docs/${projectId}/ for the next run: ` +
            unhandled.slice(0, 5).map(d => d.fileName).join(', ') +
            (unhandled.length > 5 ? ` (+${unhandled.length - 5} more)` : '')
          );
        }
      }

      if (deleteCandidates.length === 0) {
        return { projectId, deleted: 0 };
      }

      const keys = deleteCandidates.map(d => d.key);
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
    const cleanupEnabledByEnv = process.env.INGESTION_CLEANUP_FILTER_DOCS === 'true';
    const { cleanupAfter = cleanupEnabledByEnv } = options;

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
        pipelineResult.cleanup = await this.cleanupFilterDocs(
          projectId,
          pipelineResult.routing.handledKeys || []
        );
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
      docsSkippingFIScan: 0,    // Documents from baselined projects (will NOT be scanned)
      docsEligibleForFIScan: 0, // Documents from existing projects (WILL be scanned)
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

          if (routeResult.isBaselined) {
            results.docsSkippingFIScan += routeResult.documentsCopied;
          } else {
            // NEW semantics with no source docs copied (docfiles/system-only).
            // Not FI-eligible yet, but also not baseline-markered.
            results.docsEligibleForFIScan += 0;
          }
        } else {
          results.existingProjects++;
          results.docsEligibleForFIScan += routeResult.documentsCopied;
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
    logger.info(`   📊 FI Scan eligibility:`);
    logger.info(`      - Skipping FI scan (baselined): ${results.docsSkippingFIScan} docs`);
    logger.info(`      - Eligible for FI scan (new on existing): ${results.docsEligibleForFIScan} docs`);

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
   * Uses pagination to handle >1000 projects
   * @returns {string[]} Array of project IDs
   */
  async listStagedProjects() {
    try {
      const projectIds = [];
      let continuationToken = null;

      do {
        const params = {
          Bucket: s3Service.bucket,
          Prefix: 'filter-docs/',
          Delimiter: '/'
        };

        if (continuationToken) {
          params.ContinuationToken = continuationToken;
        }

        const response = await s3Service.s3.listObjectsV2(params).promise();

        const ids = (response.CommonPrefixes || [])
          .map(prefix => prefix.Prefix.replace('filter-docs/', '').replace('/', ''))
          .filter(id => id);

        projectIds.push(...ids);
        continuationToken = response.IsTruncated ? response.NextContinuationToken : null;

      } while (continuationToken);

      logger.info(`📋 Found ${projectIds.length} projects in filter-docs`);
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
