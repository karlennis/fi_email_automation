const schedule = require('node-schedule');
const winston = require('winston');
const ScheduledJob = require('../models/ScheduledJob');
const Customer = require('../models/Customer');
const emailService = require('./emailService');
const { withLock } = require('./jobLock');

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'logs/scheduled-jobs.log' })
  ]
});

class ScheduledJobManager {
  constructor() {
    this.activeSchedules = new Map(); // jobId -> node-schedule job
    this.initialized = false;
    // Don't initialize immediately - wait for explicit call after DB connection
  }

  /**
   * Initialize the scheduled job manager
   * Should be called after MongoDB connection is established
   */
  async initialize() {
    if (this.initialized) {
      return;
    }

    try {
      await this.initializeScheduledJobs();
      this.initialized = true;
    } catch (error) {
      logger.error('Failed to initialize scheduled job manager:', error);
      throw error;
    }
  }

  /**
   * Get or create system user for automated jobs
   */
  async getSystemUser() {
    const User = require('../models/User');

    let systemUser = await User.findOne({ email: 'system@buildinginfo.com' });

    if (!systemUser) {
      systemUser = new User({
        name: 'System',
        email: 'system@buildinginfo.com',
        role: 'admin',
        isActive: true,
        permissions: {
          canManageUsers: true,
          canManageJobs: true,
          canViewAllJobs: true,
          canManageSystem: true
        }
      });
      await systemUser.save();
    }

    return systemUser;
  }

  /**
   * Initialize all active scheduled jobs from database
   */
  async initializeScheduledJobs() {
    try {
      logger.info('Initializing scheduled jobs from database...');

      const jobs = await ScheduledJob.find({
        isActive: true,
        status: { $in: ['SCHEDULED', 'CACHED'] },
        // Retired types would be scheduled only to throw when they fired.
        jobType: { $nin: ScheduledJob.RETIRED_JOB_TYPES }
      });

      const retiredCount = await ScheduledJob.countDocuments({
        isActive: true,
        status: { $in: ['SCHEDULED', 'CACHED'] },
        jobType: { $in: ScheduledJob.RETIRED_JOB_TYPES }
      });

      if (retiredCount > 0) {
        logger.warn(
          `Skipped ${retiredCount} active job(s) of a retired type ` +
          `(${ScheduledJob.RETIRED_JOB_TYPES.join(', ')}). ` +
          `Run scripts/retire-dead-scheduled-jobs.js --apply to deactivate them.`
        );
      }

      for (const job of jobs) {
        await this.scheduleJob(job);
      }

      logger.info(`Initialized ${jobs.length} scheduled jobs`);

      // Start monitoring loop
      this.startMonitoring();

    } catch (error) {
      logger.error('Error initializing scheduled jobs:', error);
    }
  }

  /**
   * Create a new scheduled job with user tracking
   */
  async createScheduledJob(config, user = null) {
    try {
      const {
        jobType,
        scheduleType,
        cronExpression,
        scheduledFor,
        dayOfWeek,
        timeOfDay,
        reportTypes,
        projectIds,
        searchCriteria,
        customerIds,
        emailTemplate,
        customSubject,
        attachReports = true,
        notes
      } = config;

      // Get system user if no user provided
      let createdByUser = user;
      if (!createdByUser) {
        createdByUser = await this.getSystemUser();
      }

      // Fetch customer details. The create route requires at least one, but keep this
      // tolerant of an empty list so a job created another way still saves.
      let customers = [];
      if (customerIds && customerIds.length > 0) {
        customers = await Customer.find({
          _id: { $in: customerIds }
        }).select('_id email name');
      }

      const job = new ScheduledJob({
        jobType,
        schedule: {
          type: scheduleType,
          cronExpression,
          scheduledFor,
          dayOfWeek,
          timeOfDay
        },
        customers: customers.map(c => ({
          customerId: c._id,
          email: c.email,
          name: c.name,
          sendStatus: 'PENDING'
        })),
        config: {
          reportTypes,
          projectIds,
          searchCriteria,
          emailTemplate,
          customSubject,
          attachReports
        },
        emailStats: {
          totalEmails: customers.length
        },
        createdBy: {
          userId: createdByUser._id,
          username: createdByUser.name,
          email: createdByUser.email
        },
        executionHistory: [{
          executedBy: {
            userId: createdByUser._id,
            username: createdByUser.name,
            email: createdByUser.email
          },
          executedAt: new Date(),
          action: 'CREATED',
          details: `Job created with ${customers.length} recipients`
        }],
        notes
      });

      // Calculate next run time
      await job.calculateNextRun();
      await job.save();

      // Schedule the job
      await this.scheduleJob(job);

      logger.info(`Created scheduled job ${job.jobId} with ${customers.length} recipients`);

      return job;

    } catch (error) {
      logger.error('Error creating scheduled job:', error);
      throw error;
    }
  }

  /**
   * Schedule a job with node-schedule
   */
  async scheduleJob(job) {
    try {
      // Cancel existing schedule if any
      if (this.activeSchedules.has(job.jobId)) {
        this.activeSchedules.get(job.jobId).cancel();
      }

      let scheduleRule;

      switch (job.schedule.type) {
        case 'IMMEDIATE':
          // Execute immediately
          await this.executeJob(job._id);
          return;

        case 'ONCE':
          // Schedule for specific date/time
          scheduleRule = job.schedule.scheduledFor;
          break;

        case 'CRON':
          // Use cron expression
          scheduleRule = job.schedule.cronExpression;
          break;

        case 'WEEKLY':
          // Weekly schedule (e.g., Friday at 10:00)
          const [hours, minutes] = (job.schedule.timeOfDay || '10:00').split(':');
          scheduleRule = new schedule.RecurrenceRule();
          scheduleRule.dayOfWeek = job.schedule.dayOfWeek || 5; // Default Friday
          scheduleRule.hour = parseInt(hours);
          scheduleRule.minute = parseInt(minutes);
          break;

        case 'DAILY':
          // Daily schedule at specific time
          const [h, m] = (job.schedule.timeOfDay || '10:00').split(':');
          scheduleRule = new schedule.RecurrenceRule();
          scheduleRule.hour = parseInt(h);
          scheduleRule.minute = parseInt(m);
          break;

        case 'MONTHLY':
          // Monthly on specific day
          const [mh, mm] = (job.schedule.timeOfDay || '10:00').split(':');
          scheduleRule = new schedule.RecurrenceRule();
          scheduleRule.date = job.schedule.dayOfMonth || 1;
          scheduleRule.hour = parseInt(mh);
          scheduleRule.minute = parseInt(mm);
          break;
      }

      if (scheduleRule) {
        // Schedule the main job execution (Phase 2: Send)
        const scheduledTask = schedule.scheduleJob(scheduleRule, async () => {
          await this.executeJob(job._id);
        });

        this.activeSchedules.set(job.jobId, scheduledTask);

        // Pre-processing (the old "Phase 1") used to be scheduled here, two hours
        // before the send. It called executeReportGeneration, which never ran to
        // completion - see the removal note on executeJob below. The `_preprocess`
        // entries it wrote were also never cancelled by cancelJob or pauseJob, so
        // each reschedule leaked a timer.

        logger.info(`Scheduled job ${job.jobId} with type ${job.schedule.type}`);
      }

    } catch (error) {
      logger.error(`Error scheduling job ${job.jobId}:`, error);
      throw error;
    }
  }

  /**
   * Execute a scheduled job.
   *
   * Locked per job: this class only tracks node-schedule handles, never a per-execution
   * flag, so two cluster instances (or the monitor loop racing the cron) could both enter
   * here for the same job and send every customer their email twice.
   */
  async executeJob(jobId) {
    const outcome = await withLock(
      `scheduled-job:${jobId}`,
      {
        ttlMs: 60 * 60 * 1000,
        heartbeat: true,
        meta: { jobId: String(jobId) },
        skipMessage: `⏭️ Scheduled job ${jobId} already running elsewhere, skipping`
      },
      () => this.runJob(jobId)
    );

    return outcome.ran ? outcome.result : undefined;
  }

  async runJob(jobId) {
    let job;

    try {
      job = await ScheduledJob.findById(jobId).populate('customers.customerId');

      if (!job) {
        logger.error(`Job ${jobId} not found`);
        return;
      }

      logger.info(`Executing job ${job.jobId}, type: ${job.jobType}`);

      // Update status
      await job.updateStatus('PROCESSING');

      const startTime = Date.now();

      // EMAIL_BATCH is the only job type that ever worked.
      //
      // REPORT_GENERATION and FI_DETECTION both called fiDetectionService.searchProjects
      // and fiDetectionService.detectFIRequests, neither of which exists on that service
      // (searchProjects lives on buildingInfoService; detectFIRequests exists nowhere -
      // the closest is detectFIRequest, singular, with a different signature). On top of
      // that, executeReportGeneration re-required fiDetectionService inside its own body,
      // shadowing the module import, so the first reference hit the temporal dead zone and
      // threw a ReferenceError before it could even reach the missing method. Both paths
      // therefore failed on every single run and were removed rather than implemented.
      //
      // The enum values remain on the ScheduledJob model so existing rows stay saveable;
      // creation of new ones is blocked in routes/scheduled-jobs.js and initialization
      // skips them.
      if (job.jobType !== 'EMAIL_BATCH') {
        throw new Error(
          `Unsupported job type: ${job.jobType}. Only EMAIL_BATCH is implemented ` +
          `(REPORT_GENERATION and FI_DETECTION were removed - they never ran successfully).`
        );
      }

      const result = await this.executeEmailBatch(job);

      // Update execution stats
      const duration = Date.now() - startTime;
      job.execution.lastRunAt = new Date();
      job.execution.runCount += 1;
      job.execution.successCount += 1;
      job.execution.avgProcessingTime = job.execution.avgProcessingTime
        ? (job.execution.avgProcessingTime + duration) / 2
        : duration;

      // Calculate next run if recurring
      if (job.schedule.type !== 'ONCE' && job.schedule.type !== 'IMMEDIATE') {
        await job.calculateNextRun();
      } else {
        job.isActive = false;
      }

      await job.updateStatus('COMPLETED');

      logger.info(`Job ${job.jobId} completed in ${duration}ms`);

    } catch (error) {
      logger.error(`Error executing job ${jobId}:`, error);
      if (job) {
        await job.updateStatus('FAILED', error);
      }
    }
  }

  /**
   * Execute email batch sending (Phase 2: Send)
   * This runs at the scheduled send time and uses pre-cached results
   */
  async executeEmailBatch(job) {
    try {
      logger.info(`[Phase 2: Send] Sending batch emails for job ${job.jobId} to ${job.customers.length} recipients`);

      let reportData;
      let cacheWasValid = false;

      // Check if we have valid pre-generated reports from Phase 1
      // Valid cache must:
      // 1. Exist with customerMatches array
      // 2. Be generated within the last 24 hours (for recurring jobs)
      // 3. Have been generated after the job was created (not from a previous job)
      if (job.cache?.reportData?.customerMatches) {
        const cacheGeneratedAt = job.cache.reportData.generatedAt || job.cache.generatedAt;
        const jobCreatedAt = job.createdAt;
        const cacheAge = cacheGeneratedAt ? Date.now() - new Date(cacheGeneratedAt).getTime() : Infinity;
        const cacheAgeHours = (cacheAge / (1000 * 60 * 60)).toFixed(1);

        // Check if cache was generated for THIS job (after job was created)
        const cacheIsForThisJob = cacheGeneratedAt && jobCreatedAt &&
                                  new Date(cacheGeneratedAt) >= new Date(jobCreatedAt);

        // Check if cache is fresh (less than 24 hours old)
        const cacheIsFresh = cacheAge < 24 * 60 * 60 * 1000;

        if (cacheIsForThisJob && cacheIsFresh) {
          logger.info(`[Phase 2] Using cached reports from Phase 1 (generated ${cacheAgeHours}h ago, ${job.cache.reportData.customerMatches.length} customers)`);
          reportData = job.cache.reportData;
          cacheWasValid = true;
        } else {
          if (!cacheIsForThisJob) {
            logger.warn(`[Phase 2] Cache is from a previous job (job created: ${jobCreatedAt}, cache: ${cacheGeneratedAt}), regenerating...`);
          } else {
            logger.warn(`[Phase 2] Cache is stale (${cacheAgeHours}h old), regenerating...`);
          }
        }
      }

      // No valid cache means there is nothing to send. This used to fall back to
      // executeReportGeneration, which threw a ReferenceError on its first line, so the
      // job already failed here - just illegibly, as "Cannot access 'fiDetectionService'
      // before initialization". Fail with something an operator can act on instead.
      if (!cacheWasValid) {
        throw new Error(
          `No valid pre-generated report cache for job ${job.jobId}. Cache must be ` +
          `populated for this job and less than 24 hours old. On-demand generation was ` +
          `removed - it never worked.`
        );
      }

      await job.updateStatus('SENDING');

      // Initialize email stats if not already set
      if (!job.emailStats.totalEmails) {
        job.emailStats.totalEmails = job.customers.length;
        await job.save();
      }

      let sentCount = 0;
      let failedCount = 0;

      // Send emails using cached customer matches
      for (const customerMatch of reportData.customerMatches) {
        // Find the customer in the job's customer list
        const customer = job.customers.find(c => c.email === customerMatch.email);

        if (!customer) {
          logger.warn(`Customer ${customerMatch.email} not found in job customers list`);
          continue;
        }

        if (customer.sendStatus === 'SENT') {
          logger.info(`Skipping ${customer.email} - already sent`);
          continue;
        }

        try {
          // Only send if customer has matches
          if (customerMatch.matches && customerMatch.matches.length > 0) {
            await emailService.sendBatchFINotification(
              customerMatch.email,
              customerMatch.name,
              {
                matches: customerMatch.matches,
                reportTypes: job.config.reportTypes,
                jobId: job.jobId,
                generatedAt: reportData.generatedAt
              }
            );

            // Mark as sent using customerId
            await job.markCustomerSent(customer.customerId);
            sentCount++;

            logger.info(`✅ Email sent to ${customer.email} (${customerMatch.matches.length} matches)`);
          } else {
            logger.info(`⏭️  Skipping ${customer.email} - no FI matches found`);
            await job.markCustomerSent(customer.customerId, 'SKIPPED');
          }

        } catch (emailError) {
          logger.error(`Failed to send email to ${customer.email}:`, emailError);
          failedCount++;
          await job.markCustomerFailed(customer.customerId, emailError.message);
        }
      }

      // Final job status update
      await ScheduledJob.findByIdAndUpdate(job._id, {
        status: 'COMPLETED',
        'execution.lastRunAt': new Date(),
        'execution.runCount': { $inc: 1 },
        'execution.successCount': { $inc: 1 }
      });

      logger.info(`[Phase 2 Complete] Emails sent for job ${job.jobId}:`, {
        sent: sentCount,
        failed: failedCount,
        skipped: reportData.customerMatches.length - sentCount - failedCount
      });

      return {
        success: true,
        sentCount,
        failedCount,
        totalRecipients: job.customers.length
      };

    } catch (error) {
      logger.error(`Error in email batch for job ${job.jobId}:`, error);
      throw error;
    }
  }

  /**
   * Get all scheduled jobs with filters
   */
  async getScheduledJobs(filters = {}) {
    const query = { ...filters };

    return await ScheduledJob.find(query)
      .populate('customers.customerId', 'name email')
      .sort({ createdAt: -1 });
  }

  /**
   * Get job by ID
   */
  async getJobById(jobId) {
    return await ScheduledJob.findOne({ jobId })
      .populate('customers.customerId', 'name email company');
  }

  /**
   * Update job
   */
  async updateJob(jobId, updates) {
    const job = await ScheduledJob.findOne({ jobId });

    if (!job) {
      throw new Error('Job not found');
    }

    // Update fields
    Object.assign(job, updates);

    await job.save();

    // Reschedule if schedule changed
    if (updates.schedule || updates.isActive !== undefined) {
      await this.scheduleJob(job);
    }

    return job;
  }

  /**
   * Cancel job
   */
  async cancelJob(jobId) {
    const job = await ScheduledJob.findOne({ jobId });

    if (!job) {
      throw new Error('Job not found');
    }

    // Update without running full document validation to avoid issues with missing required fields
    await ScheduledJob.updateOne(
      { jobId },
      {
        status: 'CANCELLED',
        isActive: false
      },
      { runValidators: false }
    );

    // Cancel schedule
    if (this.activeSchedules.has(jobId)) {
      this.activeSchedules.get(jobId).cancel();
      this.activeSchedules.delete(jobId);
    }

    logger.info(`Cancelled job ${jobId}`);

    // Return updated job
    return await ScheduledJob.findOne({ jobId });
  }

  /**
   * Pause job
   */
  async pauseJob(jobId) {
    const job = await ScheduledJob.findOne({ jobId });

    if (!job) {
      throw new Error('Job not found');
    }

    // Update without running full document validation
    await ScheduledJob.updateOne(
      { jobId },
      { status: 'PAUSED' },
      { runValidators: false }
    );

    // Cancel schedule but keep job active
    if (this.activeSchedules.has(jobId)) {
      this.activeSchedules.get(jobId).cancel();
      this.activeSchedules.delete(jobId);
    }

    logger.info(`Paused job ${jobId}`);

    // Return updated job
    return await ScheduledJob.findOne({ jobId });
  }

  /**
   * Resume job
   */
  async resumeJob(jobId) {
    const job = await ScheduledJob.findOne({ jobId });

    if (!job) {
      throw new Error('Job not found');
    }

    // Calculate next run before updating
    await job.calculateNextRun();

    // Update status and next run time
    await ScheduledJob.updateOne(
      { jobId },
      {
        status: 'SCHEDULED',
        'execution.nextRunAt': job.execution.nextRunAt
      },
      { runValidators: false }
    );

    // Get updated job for rescheduling
    const updatedJob = await ScheduledJob.findOne({ jobId });

    // Reschedule
    await this.scheduleJob(updatedJob);

    logger.info(`Resumed job ${jobId}`);
    return updatedJob;
  }

  /**
   * Start monitoring for jobs that need execution
   */
  startMonitoring() {
    // Check every minute for jobs that need execution. The sweep itself is locked so
    // two instances do not both build the due list; executeJob then locks per job.
    setInterval(async () => {
      await withLock('scheduled-job-monitor', { ttlMs: 2 * 60 * 1000, skipMessage: false }, async () => {
        try {
          const now = new Date();
          const jobs = await ScheduledJob.find({
            isActive: true,
            status: 'SCHEDULED',
            jobType: { $nin: ScheduledJob.RETIRED_JOB_TYPES },
            'execution.nextRunAt': { $lte: now }
          });

          for (const job of jobs) {
            await this.executeJob(job._id);
          }

        } catch (error) {
          logger.error('Error in monitoring loop:', error);
        }
      });
    }, 60000); // Every minute

    logger.info('Started job monitoring loop');
  }

  /**
   * Get job statistics
   */
  async getJobStatistics() {
    const stats = await ScheduledJob.aggregate([
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 },
          avgProcessingTime: { $avg: '$execution.avgProcessingTime' }
        }
      }
    ]);

    const typeStats = await ScheduledJob.aggregate([
      {
        $group: {
          _id: '$jobType',
          count: { $sum: 1 }
        }
      }
    ]);

    const totalJobs = await ScheduledJob.countDocuments();
    const activeJobs = await ScheduledJob.countDocuments({ isActive: true });

    // Calculate success rate
    const completedJobs = await ScheduledJob.countDocuments({ status: 'COMPLETED' });
    const failedJobs = await ScheduledJob.countDocuments({ status: 'FAILED' });
    const totalExecuted = completedJobs + failedJobs;
    const successRate = totalExecuted > 0 ? (completedJobs / totalExecuted) * 100 : 0;

    // Calculate average processing time
    const avgTimeResult = await ScheduledJob.aggregate([
      { $match: { 'execution.avgProcessingTime': { $exists: true, $ne: null } } },
      { $group: { _id: null, avgTime: { $avg: '$execution.avgProcessingTime' } } }
    ]);
    const averageProcessingTime = avgTimeResult.length > 0 ? avgTimeResult[0].avgTime : 0;

    return {
      total: totalJobs,
      active: activeJobs,
      byStatus: stats.reduce((acc, item) => {
        acc[item._id] = item.count;
        return acc;
      }, {}),
      byType: typeStats.reduce((acc, item) => {
        acc[item._id] = item.count;
        return acc;
      }, {}),
      averageProcessingTime: Math.round(averageProcessingTime),
      successRate: Math.round(successRate * 10) / 10
    };
  }

  /**
   * Get dashboard-specific statistics
   */
  async getDashboardStatistics() {
    try {
      logger.info('[Dashboard Stats] Calculating statistics from scheduled jobs...');

      // Get total emails sent across all jobs
      const emailStats = await ScheduledJob.aggregate([
        {
          $group: {
            _id: null,
            totalEmailsSent: { $sum: '$emailStats.sentEmails' },
            totalEmailsFailed: { $sum: '$emailStats.failedEmails' },
            totalEmails: { $sum: '$emailStats.totalEmails' }
          }
        }
      ]);

      // Get total FI matches from cache
      const fiMatchStats = await ScheduledJob.aggregate([
        {
          $match: {
            'cache.reportData.totalMatches': { $exists: true }
          }
        },
        {
          $group: {
            _id: null,
            totalFIMatches: { $sum: '$cache.reportData.totalMatches' },
            totalProcessedProjects: { $sum: '$cache.reportData.processedProjects' }
          }
        }
      ]);

      const emailData = emailStats[0] || { totalEmailsSent: 0, totalEmailsFailed: 0, totalEmails: 0 };
      const fiData = fiMatchStats[0] || { totalFIMatches: 0, totalProcessedProjects: 0 };

      logger.info('[Dashboard Stats] Email aggregation result:', emailData);
      logger.info('[Dashboard Stats] FI Match aggregation result:', fiData);

      const stats = {
        emailsSent: emailData.totalEmailsSent || 0,
        emailsFailed: emailData.totalEmailsFailed || 0,
        totalEmails: emailData.totalEmails || 0,
        fiMatches: fiData.totalFIMatches || 0,
        processedProjects: fiData.totalProcessedProjects || 0,
        emailSuccessRate: emailData.totalEmails > 0
          ? Math.round((emailData.totalEmailsSent / emailData.totalEmails) * 100 * 10) / 10
          : 0
      };

      logger.info('[Dashboard Stats] Final calculated stats:', stats);
      return stats;

    } catch (error) {
      logger.error('[Dashboard Stats] Error calculating dashboard statistics:', error);
      return {
        emailsSent: 0,
        emailsFailed: 0,
        totalEmails: 0,
        fiMatches: 0,
        processedProjects: 0,
        emailSuccessRate: 0
      };
    }
  }
}

module.exports = new ScheduledJobManager();
