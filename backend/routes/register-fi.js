const express = require('express');
const router = express.Router();
const registerFiService = require('../services/registerFiService');
const documentFilterService = require('../services/documentFilterService');
const ScheduledJob = require('../models/ScheduledJob');
const { authenticate, requireAdmin } = require('../middleware/auth');
const logger = require('../utils/logger');

/**
 * POST /api/register-fi/scan/acoustic/trigger
 * Trigger a manual acoustic report scan
 */
router.post('/scan/acoustic/trigger', authenticate, requireAdmin, async (req, res) => {
  try {
    const { from, to, projectIds } = req.body;

    logger.info('🚀 Manual acoustic scan triggered', {
      user: req.user.email,
      from,
      to,
      projectIds: projectIds?.length || 'all'
    });

    // Parse dates
    const options = {};
    if (from) options.from = new Date(from);
    if (to) options.to = new Date(to);
    if (projectIds && projectIds.length > 0) options.projectIds = projectIds;

    const result = await registerFiService.scanForAcousticReports(options);

    res.json({
      success: true,
      data: result
    });

  } catch (error) {
    logger.error('Failed to trigger acoustic scan:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/register-fi/scan/acoustic/daily
 * Trigger daily scan (scans yesterday's documents)
 */
router.post('/scan/acoustic/daily', authenticate, requireAdmin, async (req, res) => {
  try {
    logger.info('📅 Daily acoustic scan triggered', {
      user: req.user.email
    });

    const result = await registerFiService.runDailyScan();

    res.json({
      success: true,
      data: result
    });

  } catch (error) {
    logger.error('Failed to run daily scan:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/register-fi/scan/acoustic/status
 * Get current scan status
 */
router.get('/scan/acoustic/status', authenticate, async (req, res) => {
  try {
    const status = registerFiService.getScanStatus();
    const config = registerFiService.getConfig();
    const filterStats = documentFilterService.getStats();

    res.json({
      success: true,
      data: {
        status,
        config,
        filterStats
      }
    });

  } catch (error) {
    logger.error('Failed to get scan status:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/register-fi/scan/acoustic/queue
 * Get documents in review queue
 */
router.get('/scan/acoustic/queue', authenticate, async (req, res) => {
  try {
    const status = registerFiService.getScanStatus();

    if (!status.currentScan) {
      return res.json({
        success: true,
        data: {
          queue: [],
          count: 0,
          message: 'No scan in progress or completed'
        }
      });
    }

    // Return review queue from last scan
    // In production, store this in database
    res.json({
      success: true,
      data: {
        queue: status.currentScan.results?.reviewQueue || [],
        count: status.currentScan.stats?.reviewQueue || 0,
        scanId: status.currentScan.scanId
      }
    });

  } catch (error) {
    logger.error('Failed to get review queue:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/register-fi/scan/acoustic/approve/:documentPath
 * Approve a document from review queue
 */
router.post('/scan/acoustic/approve/:documentPath', authenticate, requireAdmin, async (req, res) => {
  try {
    const { documentPath } = req.params;
    const { approved, notes } = req.body;

    logger.info(`📝 Document review: ${documentPath}`, {
      user: req.user.email,
      approved,
      notes
    });

    // In production, store approval in database
    // For now, just acknowledge
    res.json({
      success: true,
      data: {
        documentPath,
        approved,
        reviewedBy: req.user.email,
        reviewedAt: new Date(),
        notes
      }
    });

  } catch (error) {
    logger.error('Failed to approve document:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * PUT /api/register-fi/scan/acoustic/config
 * Update acoustic scan configuration
 */
router.put('/scan/acoustic/config', authenticate, requireAdmin, async (req, res) => {
  try {
    const { confidenceThreshold, reviewThreshold } = req.body;

    logger.info('⚙️  Updating acoustic scan config', {
      user: req.user.email,
      confidenceThreshold,
      reviewThreshold
    });

    // Validate thresholds
    if (confidenceThreshold !== undefined) {
      if (confidenceThreshold < 0 || confidenceThreshold > 1) {
        return res.status(400).json({
          success: false,
          error: 'Confidence threshold must be between 0 and 1'
        });
      }
    }

    if (reviewThreshold !== undefined) {
      if (reviewThreshold < 0 || reviewThreshold > 1) {
        return res.status(400).json({
          success: false,
          error: 'Review threshold must be between 0 and 1'
        });
      }
    }

    registerFiService.updateThresholds(confidenceThreshold, reviewThreshold);

    const updatedConfig = registerFiService.getConfig();

    res.json({
      success: true,
      data: updatedConfig
    });

  } catch (error) {
    logger.error('Failed to update config:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/register-fi/scan/acoustic/config
 * Get current configuration
 */
router.get('/scan/acoustic/config', authenticate, async (req, res) => {
  try {
    const config = registerFiService.getConfig();

    res.json({
      success: true,
      data: config
    });

  } catch (error) {
    logger.error('Failed to get config:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/register-fi/scan/acoustic/schedule
 * Create a scheduled job for daily acoustic scans
 */
router.post('/scan/acoustic/schedule', authenticate, requireAdmin, async (req, res) => {
  try {
    const { timeOfDay, enabled, config } = req.body;

    logger.info('📆 Creating scheduled acoustic scan job', {
      user: req.user.email,
      timeOfDay,
      enabled
    });

    // Create scheduled job
    const job = new ScheduledJob({
      jobType: 'REGISTER_ACOUSTIC_SCAN',
      schedule: {
        type: 'DAILY',
        timeOfDay: timeOfDay || '09:00'
      },
      status: enabled ? 'SCHEDULED' : 'PAUSED',
      config: {
        reportTypes: ['acoustic'],
        registerScan: {
          confidenceThreshold: config?.confidenceThreshold || 0.8,
          reviewThreshold: config?.reviewThreshold || 0.5,
          autoProcess: config?.autoProcess !== false,
          enableVisionAPI: config?.enableVisionAPI !== false
        }
      },
      createdBy: {
        userId: req.user.userId,
        email: req.user.email,
        name: req.user.name
      }
    });

    await job.save();

    logger.info(`✅ Created scheduled job: ${job.jobId}`);

    res.json({
      success: true,
      data: {
        jobId: job.jobId,
        schedule: job.schedule,
        status: job.status,
        config: job.config
      }
    });

  } catch (error) {
    logger.error('Failed to create scheduled job:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/register-fi/scan/acoustic/jobs
 * Get all acoustic scan scheduled jobs
 */
router.get('/scan/acoustic/jobs', authenticate, async (req, res) => {
  try {
    const jobs = await ScheduledJob.find({
      jobType: 'REGISTER_ACOUSTIC_SCAN'
    }).sort({ createdAt: -1 });

    res.json({
      success: true,
      data: {
        jobs,
        count: jobs.length
      }
    });

  } catch (error) {
    logger.error('Failed to get scheduled jobs:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/register-fi/stats
 * Get acoustic scan statistics
 */
router.get('/stats', authenticate, async (req, res) => {
  try {
    const filterStats = documentFilterService.getStats();
    const scanStatus = registerFiService.getScanStatus();

    res.json({
      success: true,
      data: {
        filterStats,
        scanStatus,
        timestamp: new Date()
      }
    });

  } catch (error) {
    logger.error('Failed to get stats:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;
