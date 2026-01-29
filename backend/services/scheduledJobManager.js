const schedule = require('node-schedule');
const winston = require('winston');
const ScheduledJob = require('../models/ScheduledJob');
const Customer = require('../models/Customer');
const fiDetectionService = require('./fiDetectionService');
const fiReportService = require('./fiReportService');
const emailService = require('./emailService');
const buildingInfoService = require('./buildingInfoService');
const s3Service = require('./s3Service');

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
        status: { $in: ['SCHEDULED', 'CACHED'] }
      });

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

      // Fetch customer details
      const customers = await Customer.find({
        _id: { $in: customerIds }
      }).select('_id email name');

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

        // For recurring jobs (DAILY, WEEKLY, MONTHLY, CRON), schedule pre-processing 2 hours before
        // This ensures reports are fresh and not outdated
        if (['DAILY', 'WEEKLY', 'MONTHLY', 'CRON'].includes(job.schedule.type)) {
          const preprocessRule = this.createPreprocessSchedule(job.schedule);

          if (preprocessRule) {
            const preprocessTask = schedule.scheduleJob(preprocessRule, async () => {
              logger.info(`[Pre-Processing Trigger] Running Phase 1 for job ${job.jobId} (2 hours before send)`);
              try {
                await this.executeReportGeneration(await ScheduledJob.findById(job._id));
              } catch (error) {
                logger.error(`Pre-processing failed for job ${job.jobId}:`, error);
                // Don't throw - let the main job try again if needed
              }
            });

            this.activeSchedules.set(`${job.jobId}_preprocess`, preprocessTask);
            logger.info(`Scheduled pre-processing for job ${job.jobId} (2 hours before send time)`);
          }
        }

        // For ONCE jobs, schedule pre-processing based on time until send
        if (job.schedule.type === 'ONCE' && job.schedule.scheduledFor) {
          const scheduledTime = new Date(job.schedule.scheduledFor);
          const now = new Date();
          const hoursUntilSend = (scheduledTime - now) / (1000 * 60 * 60);

          if (hoursUntilSend > 2) {
            // Schedule to run exactly 2 hours before send time
            const preprocessTime = new Date(scheduledTime.getTime() - (2 * 60 * 60 * 1000));

            logger.info(`[Pre-Processing] ONCE job scheduled ${hoursUntilSend.toFixed(1)}h from now, pre-processing will run at ${preprocessTime.toLocaleString()} (2h before send)`);

            const preprocessTask = schedule.scheduleJob(preprocessTime, async () => {
              logger.info(`[Pre-Processing Trigger] Running Phase 1 for ONCE job ${job.jobId} (2 hours before send)`);
              try {
                await this.executeReportGeneration(await ScheduledJob.findById(job._id));
              } catch (error) {
                logger.error(`Pre-processing failed for ONCE job ${job.jobId}:`, error);
              }
            });

            this.activeSchedules.set(`${job.jobId}_preprocess`, preprocessTask);
          } else if (hoursUntilSend > 0.1) {
            // Less than 2 hours but more than 6 minutes - run immediately
            logger.info(`[Pre-Processing] ONCE job scheduled ${hoursUntilSend.toFixed(1)}h from now (<2h), running pre-processing immediately`);

            // Run pre-processing in background (don't await)
            this.executeReportGeneration(job).catch(error => {
              logger.error(`Pre-processing failed for ONCE job ${job.jobId}:`, error);
            });
          } else {
            // Very soon (< 6 minutes) - no time for pre-processing
            logger.info(`[No Pre-Processing] ONCE job scheduled ${(hoursUntilSend * 60).toFixed(1)} minutes from now (too soon for pre-processing)`);
          }
        }

        logger.info(`Scheduled job ${job.jobId} with type ${job.schedule.type}`);
      }

    } catch (error) {
      logger.error(`Error scheduling job ${job.jobId}:`, error);
      throw error;
    }
  }

  /**
   * Create a schedule rule for pre-processing (2 hours before main schedule)
   * @param {Object} jobSchedule - The main schedule configuration
   * @returns {Object|null} - Pre-processing schedule rule
   */
  createPreprocessSchedule(jobSchedule) {
    try {
      let preprocessRule;

      switch (jobSchedule.type) {
        case 'WEEKLY':
          // For weekly jobs, run 2 hours before
          const [hours, minutes] = (jobSchedule.timeOfDay || '10:00').split(':');
          const sendHour = parseInt(hours);
          let preprocessHour = sendHour - 2;
          let preprocessDay = jobSchedule.dayOfWeek || 5;

          // Handle hour wraparound (e.g., if send is at 1 AM, preprocess at 11 PM previous day)
          if (preprocessHour < 0) {
            preprocessHour += 24;
            preprocessDay = (preprocessDay - 1 + 7) % 7; // Previous day
          }

          preprocessRule = new schedule.RecurrenceRule();
          preprocessRule.dayOfWeek = preprocessDay;
          preprocessRule.hour = preprocessHour;
          preprocessRule.minute = parseInt(minutes);
          break;

        case 'DAILY':
          // For daily jobs, run 2 hours before
          const [h, m] = (jobSchedule.timeOfDay || '10:00').split(':');
          let dailyPreprocessHour = parseInt(h) - 2;

          if (dailyPreprocessHour < 0) {
            dailyPreprocessHour += 24;
          }

          preprocessRule = new schedule.RecurrenceRule();
          preprocessRule.hour = dailyPreprocessHour;
          preprocessRule.minute = parseInt(m);
          break;

        case 'MONTHLY':
          // For monthly jobs, run 2 hours before
          const [mh, mm] = (jobSchedule.timeOfDay || '10:00').split(':');
          let monthlyPreprocessHour = parseInt(mh) - 2;
          let preprocessDate = jobSchedule.dayOfMonth || 1;

          if (monthlyPreprocessHour < 0) {
            monthlyPreprocessHour += 24;
            preprocessDate = preprocessDate - 1;
            if (preprocessDate < 1) preprocessDate = 1; // Stay on same month
          }

          preprocessRule = new schedule.RecurrenceRule();
          preprocessRule.date = preprocessDate;
          preprocessRule.hour = monthlyPreprocessHour;
          preprocessRule.minute = parseInt(mm);
          break;

        case 'CRON':
          // For cron, we can't easily calculate 2 hours before
          // Just use the same cron for now (user can set up separate cron if needed)
          logger.warn(`Pre-processing for CRON jobs not fully supported, using same schedule`);
          preprocessRule = jobSchedule.cronExpression;
          break;
      }

      return preprocessRule;
    } catch (error) {
      logger.error('Error creating preprocess schedule:', error);
      return null;
    }
  }

  /**
   * Execute a scheduled job
   */
  async executeJob(jobId) {
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

      // Execute based on job type
      let result;
      switch (job.jobType) {
        case 'REPORT_GENERATION':
          result = await this.executeReportGeneration(job);
          break;
        case 'EMAIL_BATCH':
          result = await this.executeEmailBatch(job);
          break;
        case 'FI_DETECTION':
          result = await this.executeFIDetection(job);
          break;
        default:
          throw new Error(`Unknown job type: ${job.jobType}`);
      }

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
   * Execute report generation and cache results (Phase 1: Pre-Processing)
   * This runs hours before the scheduled send time to allow plenty of time
   * for document downloads, OCR, and AI analysis without rushing
   */
  async executeReportGeneration(job) {
    try {
      const { reportTypes, projectIds, searchCriteria } = job.config;

      logger.info(`[Phase 1: Pre-Processing] Generating reports for job ${job.jobId}`);

      let projects = [];

      // Get projects based on criteria
      if (projectIds && projectIds.length > 0) {
        // Use specific project IDs
        logger.info(`Fetching metadata for ${projectIds.length} specific projects`);
        projects = await Promise.all(
          projectIds.map(id => buildingInfoService.getProjectMetadata(id))
        );
      } else if (searchCriteria) {
        // Use search criteria to find projects
        logger.info('Searching for projects based on criteria:', searchCriteria);
        projects = await fiDetectionService.searchProjects(searchCriteria);
      }

      if (projects.length === 0) {
        throw new Error('No projects found matching criteria');
      }

      logger.info(`Processing ${projects.length} projects for ${job.customers.length} customers`);

      const startTime = Date.now();

      // Use the existing FI detection service - this handles:
      // - Document downloads from S3/BII
      // - OCR processing
      // - AI analysis for FI matching
      // - Per-customer matching based on their report type preferences
      const fiDetectionService = require('./fiDetectionService');

      const apiParams = {
        projectIds: projects.map(p => p.planning_id || p.projectId)
      };

      // This is the slow part - can take minutes for many projects
      // That's why we run it hours before the scheduled send time
      const results = await fiDetectionService.processFIRequestWithFiltering(
        reportTypes,
        apiParams,
        job.customers // Array of {_id, name, email, reportTypes}
      );

      const processingTime = Date.now() - startTime;

      logger.info(`[Phase 1] FI Detection results:`, {
        success: results.success,
        hasCustomerMatches: !!results.customerMatches,
        customerMatchesLength: results.customerMatches?.length || 0,
        totalResults: results.results?.length || 0
      });

      if (!results.success) {
        throw new Error('FI detection processing failed');
      }

      // Ensure we have customer matches array (even if empty)
      const customerMatches = results.customerMatches || [];

      // Calculate total matches across all customers
      const totalMatches = customerMatches.reduce((sum, cm) => sum + (cm.matches?.length || 0), 0);

      // Cache the results for the email send phase
      const reportData = {
        customerMatches: customerMatches,
        totalMatches: totalMatches,
        processedProjects: results.processingStats?.totalProjects || projects.length,
        processingTime: processingTime,
        generatedAt: new Date(),
        reportSummary: results.processingStats || {},
        cacheExpiry: new Date(Date.now() + (7 * 24 * 60 * 60 * 1000)) // 1 week
      };

      // Store in job document so it persists across server restarts
      const updatedJob = await ScheduledJob.findByIdAndUpdate(
        job._id,
        {
          'cache.reportData': reportData,
          'cache.reportIds': reportData.customerMatches.map(cm => cm.reportId).filter(Boolean),
          'cache.generatedAt': reportData.generatedAt,
          'cache.expiresAt': reportData.cacheExpiry,
          'stats.totalMatches': reportData.totalMatches,
          'stats.processedProjects': reportData.processedProjects,
          'stats.lastProcessingTime': processingTime
        },
        { new: true } // Return the updated document
      );

      // Update the in-memory job object with the cache
      job.cache = updatedJob.cache;
      job.stats = updatedJob.stats;

      logger.info(`[Phase 1 Complete] Reports cached for job ${job.jobId}:`, {
        totalMatches: reportData.totalMatches,
        processedProjects: reportData.processedProjects,
        customersWithMatches: reportData.customerMatches.filter(cm => cm.matches.length > 0).length,
        processingTime: `${(processingTime / 1000).toFixed(2)}s`,
        cacheExpiry: reportData.cacheExpiry.toISOString()
      });

      return {
        projectsProcessed: projects.length,
        reportsGenerated: reportData.totalMatches,
        cached: true
      };

    } catch (error) {
      logger.error(`Error in report generation for job ${job.jobId}:`, error);
      throw error;
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

      // If no valid cache, generate reports now
      if (!cacheWasValid) {
        logger.info(`[Phase 2] Generating fresh reports for job ${job.jobId}`);
        await this.executeReportGeneration(job);

        // Reload job to get updated cache
        job = await ScheduledJob.findById(job._id);

        if (!job.cache?.reportData?.customerMatches) {
          logger.error(`[Phase 2] Failed to generate reports. Cache structure:`, JSON.stringify(job.cache, null, 2));
          throw new Error('Failed to generate reports - no customer matches data available');
        }

        reportData = job.cache.reportData;
        logger.info(`[Phase 2] Fresh reports generated: ${reportData.customerMatches.length} customers, ${reportData.totalMatches} total matches`);
      }

      await job.updateStatus('SENDING');

      // Initialize email stats if not already set
      if (!job.emailStats.totalEmails) {
        job.emailStats.totalEmails = job.customers.length;
        await job.save();
      }

      let sentCount = 0;
      let failedCount = 0;
      const emailService = require('./emailService');

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
   * Execute FI detection
   */
  async executeFIDetection(job) {
    try {
      const { reportTypes, searchCriteria } = job.config;

      logger.info(`Running FI detection for job ${job.jobId}`);

      // Search for projects
      const projects = await fiDetectionService.searchProjects(searchCriteria);

      const results = {
        projectsScanned: projects.length,
        fiRequestsFound: 0,
        reportsByType: {}
      };

      // Process each project
      for (const project of projects) {
        const fiResults = await fiDetectionService.detectFIRequests(
          project.planning_id,
          reportTypes
        );

        for (const [reportType, hasRequest] of Object.entries(fiResults)) {
          if (hasRequest) {
            results.fiRequestsFound++;
            results.reportsByType[reportType] = (results.reportsByType[reportType] || 0) + 1;
          }
        }
      }

      logger.info(`FI detection completed: ${results.fiRequestsFound} requests found`);

      return results;

    } catch (error) {
      logger.error(`Error in FI detection for job ${job.jobId}:`, error);
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
    // Check every minute for jobs that need execution
    setInterval(async () => {
      try {
        const now = new Date();
        const jobs = await ScheduledJob.find({
          isActive: true,
          status: 'SCHEDULED',
          'execution.nextRunAt': { $lte: now }
        });

        for (const job of jobs) {
          await this.executeJob(job._id);
        }

      } catch (error) {
        logger.error('Error in monitoring loop:', error);
      }
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
