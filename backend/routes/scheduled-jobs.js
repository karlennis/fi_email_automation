const express = require('express');
const router = express.Router();
const scheduledJobManager = require('../services/scheduledJobManager');
const Customer = require('../models/Customer');
const { authenticate, requirePermission } = require('../middleware/auth');
const logger = require('../utils/logger');

/**
 * POST /api/scheduled-jobs/create
 * Create a new scheduled job (requires authentication)
 */
router.post('/create', authenticate, requirePermission('canManageJobs'), async (req, res) => {
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
      attachReports,
      notes
    } = req.body;

    // Validation
    if (!jobType || !scheduleType) {
      return res.status(400).json({
        success: false,
        error: 'Job type and schedule type are required'
      });
    }

    // Customer validation - optional for FI_DETECTION jobs (they can be configured later)
    if (jobType === 'EMAIL_BATCH' && (!customerIds || customerIds.length === 0)) {
      return res.status(400).json({
        success: false,
        error: 'At least one customer must be specified for EMAIL_BATCH jobs'
      });
    }

    const job = await scheduledJobManager.createScheduledJob({
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
      attachReports,
      notes
    }, req.user); // Pass the authenticated user

    res.json({
      success: true,
      message: 'Scheduled job created successfully',
      data: {
        jobId: job.jobId,
        status: job.status,
        nextRunAt: job.execution.nextRunAt,
        customerCount: job.customers.length
      }
    });

  } catch (error) {
    logger.error('Error creating scheduled job:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create scheduled job',
      message: error.message
    });
  }
});

/**
 * GET /api/scheduled-jobs/list
 * Get all scheduled jobs with optional filters
 */
router.get('/list', async (req, res) => {
  try {
    const { status, jobType, isActive, limit = 50, page = 1 } = req.query;

    const filters = {};
    if (status) filters.status = status;
    if (jobType) filters.jobType = jobType;
    if (isActive !== undefined) filters.isActive = isActive === 'true';

    const jobs = await scheduledJobManager.getScheduledJobs(filters);

    // Pagination
    const startIndex = (page - 1) * limit;
    const endIndex = startIndex + parseInt(limit);
    const paginatedJobs = jobs.slice(startIndex, endIndex);

    res.json({
      success: true,
      data: {
        jobs: paginatedJobs,
        pagination: {
          total: jobs.length,
          page: parseInt(page),
          limit: parseInt(limit),
          totalPages: Math.ceil(jobs.length / limit)
        }
      }
    });

  } catch (error) {
    logger.error('Error listing scheduled jobs:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to list scheduled jobs',
      message: error.message
    });
  }
});

/**
 * GET /api/scheduled-jobs/:jobId
 * Get specific job details
 */
router.get('/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;

    const job = await scheduledJobManager.getJobById(jobId);

    if (!job) {
      return res.status(404).json({
        success: false,
        error: 'Job not found'
      });
    }

    res.json({
      success: true,
      data: job
    });

  } catch (error) {
    logger.error('Error getting job details:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get job details',
      message: error.message
    });
  }
});

/**
 * PUT /api/scheduled-jobs/:jobId
 * Update scheduled job
 */
router.put('/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    const updates = req.body;

    const job = await scheduledJobManager.updateJob(jobId, updates);

    res.json({
      success: true,
      message: 'Job updated successfully',
      data: {
        jobId: job.jobId,
        status: job.status,
        nextRunAt: job.execution.nextRunAt
      }
    });

  } catch (error) {
    logger.error('Error updating job:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update job',
      message: error.message
    });
  }
});

/**
 * POST /api/scheduled-jobs/:jobId/cancel
 * Cancel a scheduled job
 */
router.post('/:jobId/cancel', async (req, res) => {
  try {
    const { jobId } = req.params;

    const job = await scheduledJobManager.cancelJob(jobId);

    res.json({
      success: true,
      message: 'Job cancelled successfully',
      data: {
        jobId: job.jobId,
        status: job.status
      }
    });

  } catch (error) {
    logger.error('Error cancelling job:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to cancel job',
      message: error.message
    });
  }
});

/**
 * POST /api/scheduled-jobs/:jobId/pause
 * Pause a scheduled job
 */
router.post('/:jobId/pause', async (req, res) => {
  try {
    const { jobId } = req.params;

    const job = await scheduledJobManager.pauseJob(jobId);

    res.json({
      success: true,
      message: 'Job paused successfully',
      data: {
        jobId: job.jobId,
        status: job.status
      }
    });

  } catch (error) {
    logger.error('Error pausing job:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to pause job',
      message: error.message
    });
  }
});

/**
 * POST /api/scheduled-jobs/:jobId/resume
 * Resume a paused job
 */
router.post('/:jobId/resume', async (req, res) => {
  try {
    const { jobId } = req.params;

    const job = await scheduledJobManager.resumeJob(jobId);

    res.json({
      success: true,
      message: 'Job resumed successfully',
      data: {
        jobId: job.jobId,
        status: job.status,
        nextRunAt: job.execution.nextRunAt
      }
    });

  } catch (error) {
    logger.error('Error resuming job:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to resume job',
      message: error.message
    });
  }
});

/**
 * POST /api/scheduled-jobs/:jobId/execute-now
 * Execute a job immediately (regardless of schedule)
 */
router.post('/:jobId/execute-now', async (req, res) => {
  try {
    const { jobId } = req.params;

    const job = await scheduledJobManager.getJobById(jobId);

    if (!job) {
      return res.status(404).json({
        success: false,
        error: 'Job not found'
      });
    }

    // Execute job immediately
    scheduledJobManager.executeJob(job._id);

    res.json({
      success: true,
      message: 'Job execution started',
      data: {
        jobId: job.jobId,
        status: 'PROCESSING'
      }
    });

  } catch (error) {
    logger.error('Error executing job:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to execute job',
      message: error.message
    });
  }
});

/**
 * GET /api/scheduled-jobs/dashboard/stats
 * Get dashboard statistics
 */
router.get('/dashboard/stats', async (req, res) => {
  try {
    const stats = await scheduledJobManager.getJobStatistics();
    const dashboardStats = await scheduledJobManager.getDashboardStatistics();

    res.json({
      success: true,
      data: {
        ...stats,
        ...dashboardStats
      }
    });

  } catch (error) {
    logger.error('Error getting dashboard stats:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get dashboard statistics',
      message: error.message
    });
  }
});

/**
 * GET /api/scheduled-jobs/dashboard/upcoming
 * Get upcoming scheduled jobs
 */
router.get('/dashboard/upcoming', async (req, res) => {
  try {
    const { limit = 10 } = req.query;

    const jobs = await scheduledJobManager.getScheduledJobs({
      isActive: true,
      status: { $in: ['SCHEDULED', 'CACHED'] }
    });

    // Sort by next run time
    const upcomingJobs = jobs
      .filter(j => j.execution.nextRunAt)
      .sort((a, b) => new Date(a.execution.nextRunAt) - new Date(b.execution.nextRunAt))
      .slice(0, parseInt(limit));

    res.json({
      success: true,
      data: upcomingJobs
    });

  } catch (error) {
    logger.error('Error getting upcoming jobs:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get upcoming jobs',
      message: error.message
    });
  }
});

/**
 * GET /api/scheduled-jobs/dashboard/recent
 * Get recently completed jobs
 */
router.get('/dashboard/recent', async (req, res) => {
  try {
    const { limit = 10 } = req.query;

    const jobs = await scheduledJobManager.getScheduledJobs({
      status: { $in: ['COMPLETED', 'FAILED'] }
    });

    // Sort by last run time
    const recentJobs = jobs
      .filter(j => j.execution.lastRunAt)
      .sort((a, b) => new Date(b.execution.lastRunAt) - new Date(a.execution.lastRunAt))
      .slice(0, parseInt(limit));

    res.json({
      success: true,
      data: recentJobs
    });

  } catch (error) {
    logger.error('Error getting recent jobs:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get recent jobs',
      message: error.message
    });
  }
});

/**
 * GET /api/scheduled-jobs/:jobId/customers
 * Get customer send status for a job
 */
router.get('/:jobId/customers', async (req, res) => {
  try {
    const { jobId } = req.params;

    const job = await scheduledJobManager.getJobById(jobId);

    if (!job) {
      return res.status(404).json({
        success: false,
        error: 'Job not found'
      });
    }

    res.json({
      success: true,
      data: {
        customers: job.customers,
        emailStats: job.emailStats,
        progress: job.progress
      }
    });

  } catch (error) {
    logger.error('Error getting job customers:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get job customers',
      message: error.message
    });
  }
});

/**
 * POST /api/scheduled-jobs/send-immediate
 * Send emails immediately without scheduling
 */
router.post('/send-immediate', async (req, res) => {
  try {
    const {
      reportTypes,
      projectIds,
      customerIds,
      emailTemplate,
      customSubject,
      attachReports = true
    } = req.body;

    // Create immediate job
    const job = await scheduledJobManager.createScheduledJob({
      jobType: 'EMAIL_BATCH',
      scheduleType: 'IMMEDIATE',
      reportTypes,
      projectIds,
      customerIds,
      emailTemplate,
      customSubject,
      attachReports,
      createdBy: req.user || { username: 'system' }
    });

    res.json({
      success: true,
      message: 'Immediate email job started',
      data: {
        jobId: job.jobId,
        customerCount: job.customers.length
      }
    });

  } catch (error) {
    logger.error('Error sending immediate emails:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to send immediate emails',
      message: error.message
    });
  }
});

module.exports = router;
