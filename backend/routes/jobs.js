const express = require('express');
const router = express.Router();
const jobSchedulerService = require('../services/jobSchedulerService');
const s3Service = require('../services/s3Service');
const buildingInfoService = require('../services/buildingInfoService');

/**
 * POST /api/jobs/schedule-project
 * Schedule processing for a single project
 */
router.post('/schedule-project', async (req, res) => {
  try {
    const { projectId, reportTypes, customerEmails, delay = 0 } = req.body;

    if (!projectId || !reportTypes || !Array.isArray(reportTypes)) {
      return res.status(400).json({
        success: false,
        error: 'Project ID and report types are required'
      });
    }

    const job = await jobSchedulerService.scheduleProjectProcessing(
      projectId,
      reportTypes,
      customerEmails || [],
      delay
    );

    res.json({
      success: true,
      data: {
        jobId: job.id,
        projectId,
        reportTypes,
        scheduledFor: delay > 0 ? new Date(Date.now() + delay) : new Date(),
        status: 'scheduled'
      }
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to schedule project processing',
      message: error.message
    });
  }
});

/**
 * POST /api/jobs/schedule-batch
 * Schedule batch processing for multiple projects
 */
router.post('/schedule-batch', async (req, res) => {
  try {
    const { projectIds, reportTypes, customerEmails, scheduleTime } = req.body;

    if (!projectIds || !Array.isArray(projectIds) || !reportTypes || !Array.isArray(reportTypes)) {
      return res.status(400).json({
        success: false,
        error: 'Project IDs and report types are required'
      });
    }

    const job = await jobSchedulerService.scheduleBatchProcessing(
      projectIds,
      reportTypes,
      customerEmails || [],
      scheduleTime
    );

    res.json({
      success: true,
      data: {
        jobId: job.id,
        projectCount: projectIds.length,
        reportTypes,
        scheduledFor: scheduleTime || new Date(),
        status: 'scheduled'
      }
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to schedule batch processing',
      message: error.message
    });
  }
});

/**
 * GET /api/jobs/stats
 * Get job queue statistics
 */
router.get('/stats', async (req, res) => {
  try {
    const stats = await jobSchedulerService.getJobStats();

    res.json({
      success: true,
      data: stats
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to get job statistics',
      message: error.message
    });
  }
});

/**
 * DELETE /api/jobs/:jobId
 * Cancel a scheduled job
 */
router.delete('/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    const { queueType = 'process' } = req.query;

    const cancelled = await jobSchedulerService.cancelJob(jobId, queueType);

    if (cancelled) {
      res.json({
        success: true,
        message: `Job ${jobId} cancelled successfully`
      });
    } else {
      res.status(404).json({
        success: false,
        error: 'Job not found'
      });
    }

  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to cancel job',
      message: error.message
    });
  }
});

/**
 * GET /api/jobs/s3/projects
 * List all projects available in S3
 */
router.get('/s3/projects', async (req, res) => {
  try {
    const projects = await s3Service.listAllProjects();

    res.json({
      success: true,
      data: {
        projects,
        count: projects.length
      }
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to list S3 projects',
      message: error.message
    });
  }
});

/**
 * GET /api/jobs/s3/projects/:projectId/documents
 * List documents for a specific project in S3
 */
router.get('/s3/projects/:projectId/documents', async (req, res) => {
  try {
    const { projectId } = req.params;
    const documents = await s3Service.listProjectDocuments(projectId);

    res.json({
      success: true,
      data: {
        projectId,
        documents,
        count: documents.length
      }
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to list project documents',
      message: error.message
    });
  }
});

/**
 * GET /api/jobs/s3/stats
 * Get S3 bucket statistics
 */
router.get('/s3/stats', async (req, res) => {
  try {
    const stats = await s3Service.getBucketStats();

    res.json({
      success: true,
      data: stats
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to get S3 statistics',
      message: error.message
    });
  }
});

/**
 * GET /api/jobs/building-info/:projectId
 * Get project metadata from Building Info API
 */
router.get('/building-info/:projectId', async (req, res) => {
  try {
    const { projectId } = req.params;
    const metadata = await buildingInfoService.getProjectMetadata(projectId);

    res.json({
      success: true,
      data: metadata
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to get project metadata',
      message: error.message
    });
  }
});

/**
 * POST /api/jobs/building-info/batch
 * Get metadata for multiple projects
 */
router.post('/building-info/batch', async (req, res) => {
  try {
    const { projectIds } = req.body;

    if (!projectIds || !Array.isArray(projectIds)) {
      return res.status(400).json({
        success: false,
        error: 'Project IDs array is required'
      });
    }

    const metadata = await buildingInfoService.getBatchProjectMetadata(projectIds);

    res.json({
      success: true,
      data: metadata
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to get batch project metadata',
      message: error.message
    });
  }
});

module.exports = router;