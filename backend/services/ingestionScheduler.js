/**
 * Ingestion Scheduler Service
 *
 * Handles scheduled routing of documents from filter-docs to planning-docs
 * Runs before the FI scan to ensure all documents are properly placed
 *
 * Schedule:
 * - 11:00 PM: Route filter-docs → planning-docs (70 mins before FI scan)
 * - 12:05 AM: Clean up old baseline markers (after FI scan starts)
 */

const schedule = require('node-schedule');
const documentIngestionService = require('./documentIngestionService');
const s3Service = require('./s3Service');
const emailService = require('./emailService');
const logger = require('../utils/logger');
const { withLock } = require('./jobLock');

class IngestionScheduler {
  constructor() {
    this.isRunning = false;
    this.routingJob = null;
    this.cleanupJob = null;
    this.lastRunDate = null;
  }

  /**
   * Initialize the ingestion scheduler
   */
  async initialize() {
    try {
      logger.info('📦 Initializing Ingestion Scheduler...');

      if (process.env.INGESTION_SCHEDULER_ENABLED === 'false') {
        logger.info('⏭️ Ingestion scheduler disabled (INGESTION_SCHEDULER_ENABLED=false)');
        return;
      }

      // Schedule routing job for 11:00 PM (70 mins before 12:10 AM FI scan)
      // This allows ~60+ minutes for parallel processing of up to 20K documents
      this.routingJob = schedule.scheduleJob('0 23 * * *', async () => {
        await this.runRoutingJob();
      });

      // Schedule baseline cleanup for 12:05 AM (after FI scan starts)
      this.cleanupJob = schedule.scheduleJob('5 0 * * *', async () => {
        await this.runCleanupJob();
      });

      logger.info('✅ Ingestion Scheduler initialized:');
      logger.info('   - Routing job: 11:00 PM daily');
      logger.info('   - Cleanup job: 12:05 AM daily');

    } catch (error) {
      logger.error('❌ Failed to initialize Ingestion Scheduler:', error);
    }
  }

  /**
   * Run the routing job - move documents from filter-docs to planning-docs
   */
  async runRoutingJob() {
    if (this.isRunning) {
      logger.info('⏭️ Routing job already in progress, skipping...');
      return;
    }

    const today = new Date().toISOString().split('T')[0];
    if (this.lastRunDate === today) {
      logger.info('⏭️ Routing job already ran today, skipping...');
      return;
    }

    // isRunning and lastRunDate are both reset by a restart, so on their own they let a
    // crash mid-run start a second pass on top of the first. This worker is instances: 1
    // today, but the lock is what actually holds if that ever changes.
    const outcome = await withLock(
      'ingestion-routing',
      {
        ttlMs: 120 * 60 * 1000,
        heartbeat: true,
        skipMessage: '⏭️ Routing job held by another process, skipping...'
      },
      () => this.executeRoutingJob(today)
    );

    return outcome.ran ? outcome.result : undefined;
  }

  async executeRoutingJob(today) {
    this.isRunning = true;
    const startTime = Date.now();

    try {
      logger.info('🚀 Starting scheduled routing job...');

      // Get all projects currently in filter-docs
      const stagedProjects = await documentIngestionService.listStagedProjects();

      if (stagedProjects.length === 0) {
        logger.info('📭 No projects in filter-docs staging area');
        this.lastRunDate = today;
        return;
      }

      logger.info(`📦 Found ${stagedProjects.length} projects in filter-docs to route`);

      // Route all projects
      const results = await documentIngestionService.batchRouteToPlanning(stagedProjects);

      const shouldCleanupFilterDocs = process.env.INGESTION_CLEANUP_FILTER_DOCS === 'true';

      // Clean up successfully routed projects from filter-docs (opt-in)
      let cleanedUp = 0;
      if (shouldCleanupFilterDocs) {
        for (const result of results.projectResults) {
          if (result.errors && result.errors.length === 0) {
            try {
              // Pass the keys this run actually routed so files the scraper added
              // mid-run survive for the next pass instead of being deleted unrouted.
              await documentIngestionService.cleanupFilterDocs(result.projectId, result.handledKeys || []);
              cleanedUp++;
            } catch (error) {
              logger.warn(`Failed to clean up filter-docs for ${result.projectId}:`, error.message);
            }
          }
        }
      } else {
        logger.info('⏭️ Skipping filter-docs cleanup (INGESTION_CLEANUP_FILTER_DOCS is not true)');
      }

      const duration = ((Date.now() - startTime) / 1000).toFixed(2);

      logger.info('✅ Routing job complete:');
      logger.info(`   - Projects processed: ${results.total}`);
      logger.info(`   - New projects (baselined): ${results.newProjects}`);
      logger.info(`   - Existing projects (updated): ${results.existingProjects}`);
      logger.info(`   - Documents routed: ${results.totalDocumentsRouted}`);
      logger.info(`   - Filter-docs cleaned: ${cleanedUp}${shouldCleanupFilterDocs ? '' : ' (cleanup disabled)'}`);
      logger.info(`   - Duration: ${duration}s`);
      logger.info(`   📊 FI Scan Eligibility:`);
      logger.info(`   - Skipping FI scan (baselined projects): ${results.docsSkippingFIScan} docs`);
      logger.info(`   - Eligible for FI scan (existing projects): ${results.docsEligibleForFIScan} docs`);

      this.lastRunDate = today;

    } catch (error) {
      logger.error('❌ Routing job failed:', error);

      // Routing feeds the FI scan 70 minutes later. If it fails, that night scans
      // whatever happens to already be in planning-docs and nobody is told.
      await this.sendAlert({
        severity: 'critical',
        subject: 'Document routing job failed',
        headline:
          'The nightly filter-docs → planning-docs routing job threw. Tonight\'s FI scan will run ' +
          'against un-routed data, and routing will not retry for 24 hours.',
        details: { 'Error': error.message },
        action: 'Investigate, then call ingestionScheduler.triggerRouting() to re-run before the 12:10 AM scan.'
      });
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Run the cleanup job - remove old baseline markers
   */
  async runCleanupJob() {
    const outcome = await withLock(
      'baseline-marker-cleanup',
      {
        ttlMs: 60 * 60 * 1000,
        skipMessage: '⏭️ Baseline marker cleanup held by another process, skipping...'
      },
      () => this.executeCleanupJob()
    );

    return outcome.ran ? outcome.result : undefined;
  }

  async executeCleanupJob() {
    try {
      logger.info('🧹 Starting baseline marker cleanup...');

      // Retention comes from s3Service, which is also what hasBaselineMarker looks back
      // over. Passing a literal here is how the two drifted apart before.
      const result = await s3Service.cleanupOldBaselineMarkers();

      if (result.failed > 0) {
        logger.warn(`⚠️ Cleanup finished with ${result.failed} markers it could not delete (removed ${result.deleted} of ${result.deleted + result.failed})`);

        // A marker that survives cleanup keeps its project excluded from FI scanning
        // indefinitely, so a persistent failure quietly shrinks the scanned corpus.
        // 13,239 stale markers accumulated before anyone noticed.
        await this.sendAlert({
          severity: 'warning',
          subject: 'Baseline marker cleanup could not delete some markers',
          headline:
            `${result.failed} stale baseline marker(s) could not be deleted (${result.deleted} were). ` +
            `Every surviving marker keeps its project excluded from FI scanning.`,
          details: {
            'Deleted': result.deleted,
            'Failed': result.failed,
            'Objects scanned': result.objectsScanned,
            'Cutoff date': result.cutoffDate
          },
          action: 'Check the S3 delete permissions on planning-docs/, then run document-register/audit-baseline-markers.js.'
        });
      } else {
        logger.info(`✅ Cleanup complete: removed ${result.deleted} old baseline markers`);
      }

      return result;

    } catch (error) {
      logger.error('❌ Cleanup job failed:', error);

      await this.sendAlert({
        severity: 'critical',
        subject: 'Baseline marker cleanup failed',
        headline: 'The nightly baseline marker cleanup threw and did not complete. It will not retry for 24 hours.',
        details: { 'Error': error.message },
        action: 'Investigate, then run ingestionScheduler.triggerCleanup() or the cleanup script manually.'
      });
    }
  }

  /**
   * Both ingestion jobs previously swallowed every failure into a log line - no retry,
   * no persisted state, and the next attempt 24 hours later. Nothing surfaced.
   */
  async sendAlert(alert) {
    try {
      const recipient = process.env.ALERT_EMAIL || process.env.ADMIN_EMAIL || 'afatogun@buildinginfo.com';
      return await emailService.sendJobAlertEmail(recipient, alert);
    } catch (error) {
      // An alert that cannot be sent must not take the job down with it.
      logger.error('Failed to send ingestion alert:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Manually trigger the routing job
   */
  async triggerRouting() {
    logger.info('🔧 Manual routing job triggered');
    this.lastRunDate = null; // Reset to allow re-run
    await this.runRoutingJob();
  }

  /**
   * Manually trigger the cleanup job
   */
  async triggerCleanup() {
    logger.info('🔧 Manual cleanup job triggered');
    await this.runCleanupJob();
  }

  /**
   * Get scheduler status
   */
  getStatus() {
    return {
      isRunning: this.isRunning,
      lastRunDate: this.lastRunDate,
      routingJobScheduled: !!this.routingJob,
      cleanupJobScheduled: !!this.cleanupJob,
      nextRoutingRun: this.routingJob ? this.routingJob.nextInvocation() : null,
      nextCleanupRun: this.cleanupJob ? this.cleanupJob.nextInvocation() : null
    };
  }

  /**
   * Stop all scheduled jobs
   */
  stop() {
    if (this.routingJob) {
      this.routingJob.cancel();
      this.routingJob = null;
    }
    if (this.cleanupJob) {
      this.cleanupJob.cancel();
      this.cleanupJob = null;
    }
    logger.info('🛑 Ingestion scheduler stopped');
  }
}

module.exports = new IngestionScheduler();
