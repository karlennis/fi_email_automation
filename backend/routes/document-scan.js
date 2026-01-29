const express = require('express');
const router = express.Router();
const ScanJob = require('../models/ScanJob');
const Customer = require('../models/Customer');
const { authenticate, requireAdmin } = require('../middleware/auth');
const logger = require('../utils/logger');

/**
 * GET /api/document-scan/jobs
 * Get all scan jobs
 */
router.get('/jobs', authenticate, async (req, res) => {
  try {
    const jobs = await ScanJob.find()
      .populate('customers.customerId', 'company email projectId')
      .sort({ createdAt: -1 });

    res.json({
      success: true,
      data: {
        jobs,
        count: jobs.length
      }
    });
  } catch (error) {
    logger.error('Failed to get scan jobs:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/document-scan/jobs
 * Create a new scan job
 */
router.post('/jobs', authenticate, requireAdmin, async (req, res) => {
  try {
    const { name, documentType, customers, config, schedule } = req.body;

    logger.info('📝 Creating new scan job', {
      name,
      documentType,
      user: req.user.email
    });

    const job = new ScanJob({
      name,
      documentType,
      customers: customers || [],
      config: config || {},
      schedule: schedule || {},
      createdBy: {
        userId: req.user._id,
        email: req.user.email,
        name: req.user.name
      }
      // Don't set jobId - let the pre-save hook generate it
    });

    await job.save();

    logger.info(`✅ Created scan job: ${job.jobId}`);

    res.json({
      success: true,
      data: job
    });

  } catch (error) {
    logger.error('Failed to create scan job:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * PUT /api/document-scan/jobs/:jobId
 * Update a scan job
 */
router.put('/jobs/:jobId', authenticate, requireAdmin, async (req, res) => {
  try {
    const { jobId } = req.params;
    const updates = req.body;

    logger.info(`📝 Updating scan job: ${jobId}`, {
      user: req.user.email
    });

    const job = await ScanJob.findOne({ jobId });

    if (!job) {
      return res.status(404).json({
        success: false,
        error: 'Scan job not found'
      });
    }

    // Update allowed fields
    if (updates.name) job.name = updates.name;
    if (updates.config) job.config = { ...job.config, ...updates.config };
    if (updates.schedule) job.schedule = { ...job.schedule, ...updates.schedule };
    if (updates.customers) job.customers = updates.customers;

    job.lastModifiedBy = {
      userId: req.user._id,
      email: req.user.email,
      name: req.user.name,
      timestamp: new Date()
    };

    await job.save();

    logger.info(`✅ Updated scan job: ${jobId}`);

    res.json({
      success: true,
      data: job
    });

  } catch (error) {
    logger.error('Failed to update scan job:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/document-scan/jobs/:jobId/start
 * Start a scan job
 */
router.post('/jobs/:jobId/start', authenticate, requireAdmin, async (req, res) => {
  try {
    const { jobId } = req.params;

    logger.info(`▶️  Starting scan job: ${jobId}`, {
      user: req.user.email
    });

    const job = await ScanJob.findOne({ jobId });

    if (!job) {
      return res.status(404).json({
        success: false,
        error: 'Scan job not found'
      });
    }

    job.status = 'ACTIVE';

    job.lastModifiedBy = {
      userId: req.user._id,
      email: req.user.email,
      name: req.user.name,
      timestamp: new Date()
    };

    await job.save();

    logger.info(`✅ Scan job started: ${jobId}`);

    res.json({
      success: true,
      data: job,
      message: `Scan job "${job.name}" is now active`
    });

  } catch (error) {
    logger.error('Failed to start scan job:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/document-scan/jobs/:jobId/run-now
 * Manually trigger a scan job immediately (for testing)
 * Can optionally specify a target date to scan documents from that day
 */
router.post('/jobs/:jobId/run-now', authenticate, requireAdmin, async (req, res) => {
  try {
    const { jobId } = req.params;
    const { force, targetDate } = req.body; // Optional: force flag and targetDate (YYYY-MM-DD)

    logger.info(`🚀 Manual run triggered for scan job: ${jobId}`, {
      user: req.user.email,
      force: !!force,
      targetDate: targetDate || 'yesterday (default)'
    });

    const job = await ScanJob.findOne({ jobId })
      .populate('customers.customerId', 'email company name projectId');

    if (!job) {
      return res.status(404).json({
        success: false,
        error: 'Scan job not found'
      });
    }

    if (job.status !== 'ACTIVE' && !force) {
      return res.status(400).json({
        success: false,
        error: 'Scan job must be ACTIVE to run. Set force=true to override.'
      });
    }

    // Import scan job processor
    const scanJobProcessor = require('../services/scanJobProcessor');

    // Temporarily clear lastProcessedDate if force=true
    if (force) {
      const today = new Date().toISOString().split('T')[0];
      const lastScanDate = job.statistics.lastScanDate
        ? new Date(job.statistics.lastScanDate).toISOString().split('T')[0]
        : null;

      if (lastScanDate === today) {
        logger.info('⚠️ Force flag set - allowing re-run for today');
        // Temporarily set lastScanDate to yesterday to allow re-run
        job.statistics.lastScanDate = new Date(Date.now() - 24 * 60 * 60 * 1000);
        await job.save();
      }
    }

    // Update job status to RUNNING immediately
    job.status = 'RUNNING';
    await job.save();

    // Send immediate response - don't wait for scan to complete
    res.json({
      success: true,
      data: job,
      message: `Scan job "${job.name}" started. Check status for progress.`
    });

    // Process job asynchronously in background (don't await)
    setImmediate(async () => {
      try {
        await scanJobProcessor.processJob(job, targetDate);
        logger.info(`✅ Manual run completed for job: ${jobId}`);
      } catch (error) {
        logger.error(`❌ Manual run failed for job ${jobId}:`, error);
        // Update job status to ACTIVE on error
        try {
          const failedJob = await ScanJob.findOne({ jobId });
          if (failedJob) {
            failedJob.status = 'ACTIVE';
            await failedJob.save();
          }
        } catch (saveError) {
          logger.error('Failed to update job status after error:', saveError);
        }
      }
    });

  } catch (error) {
    logger.error('Failed to run scan job:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/document-scan/jobs/:jobId/stop
 * Stop a scan job
 */
router.post('/jobs/:jobId/stop', authenticate, requireAdmin, async (req, res) => {
  try {
    const { jobId } = req.params;

    logger.info(`⏸️  Stopping scan job: ${jobId}`, {
      user: req.user.email
    });

    const job = await ScanJob.findOne({ jobId });

    if (!job) {
      return res.status(404).json({
        success: false,
        error: 'Scan job not found'
      });
    }

    job.status = 'STOPPED';
    job.lastModifiedBy = {
      userId: req.user._id,
      email: req.user.email,
      name: req.user.name,
      timestamp: new Date()
    };

    await job.save();

    logger.info(`✅ Scan job stopped: ${jobId}`);

    res.json({
      success: true,
      data: job,
      message: `Scan job "${job.name}" has been stopped`
    });

  } catch (error) {
    logger.error('Failed to stop scan job:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * DELETE /api/document-scan/jobs/:jobId
 * Delete a scan job
 */
router.delete('/jobs/:jobId', authenticate, requireAdmin, async (req, res) => {
  try {
    const { jobId } = req.params;

    logger.info(`🗑️  Deleting scan job: ${jobId}`, {
      user: req.user.email
    });

    const job = await ScanJob.findOneAndDelete({ jobId });

    if (!job) {
      return res.status(404).json({
        success: false,
        error: 'Scan job not found'
      });
    }

    logger.info(`✅ Scan job deleted: ${jobId}`);

    res.json({
      success: true,
      message: `Scan job "${job.name}" has been deleted`
    });

  } catch (error) {
    logger.error('Failed to delete scan job:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/document-scan/jobs/:jobId/customers
 * Add customers to a scan job
 */
router.post('/jobs/:jobId/customers', authenticate, requireAdmin, async (req, res) => {
  try {
    const { jobId } = req.params;
    const { customerIds } = req.body;

    logger.info(`👥 Adding customers to scan job: ${jobId}`, {
      count: customerIds.length,
      user: req.user.email
    });

    const job = await ScanJob.findOne({ jobId });

    if (!job) {
      return res.status(404).json({
        success: false,
        error: 'Scan job not found'
      });
    }

    // Fetch customer details
    const customers = await Customer.find({ _id: { $in: customerIds } });

    // Add customers to job
    for (const customer of customers) {
      const exists = job.customers.some(c => c.customerId.toString() === customer._id.toString());
      if (!exists) {
        job.customers.push({
          customerId: customer._id,
          email: customer.email,
          company: customer.company
        });
      }
    }

    job.lastModifiedBy = {
      userId: req.user._id,
      email: req.user.email,
      name: req.user.name,
      timestamp: new Date()
    };

    await job.save();

    logger.info(`✅ Added ${customers.length} customers to scan job: ${jobId}`);

    res.json({
      success: true,
      data: job
    });

  } catch (error) {
    logger.error('Failed to add customers to scan job:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * DELETE /api/document-scan/jobs/:jobId/customers/:customerId
 * Remove a customer from a scan job
 */
router.delete('/jobs/:jobId/customers/:customerId', authenticate, requireAdmin, async (req, res) => {
  try {
    const { jobId, customerId } = req.params;

    logger.info(`👥 Removing customer from scan job: ${jobId}`, {
      customerId,
      user: req.user.email
    });

    const job = await ScanJob.findOne({ jobId });

    if (!job) {
      return res.status(404).json({
        success: false,
        error: 'Scan job not found'
      });
    }

    // Filter out the customer - handle both populated and unpopulated customerId
    job.customers = job.customers.filter(c => {
      const cId = c.customerId?._id ? c.customerId._id.toString() : c.customerId?.toString();
      return cId !== customerId;
    });

    job.lastModifiedBy = {
      userId: req.user._id,
      email: req.user.email,
      name: req.user.name,
      timestamp: new Date()
    };

    await job.save();

    logger.info(`✅ Removed customer from scan job: ${jobId}`);

    res.json({
      success: true,
      data: job
    });

  } catch (error) {
    logger.error('Failed to remove customer from scan job:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/document-scan/document-types
 * Get available document types
 */
router.get('/document-types', authenticate, (req, res) => {
  const documentTypes = [
    { value: 'acoustic', label: 'Acoustic Reports', icon: '🔊' },
    { value: 'transport', label: 'Transport Assessment', icon: '🚗' },
    { value: 'flood', label: 'Flood Risk Assessment', icon: '🌊' },
    { value: 'contamination', label: 'Contamination Reports', icon: '⚠️' },
    { value: 'ecology', label: 'Ecology Reports', icon: '🌿' },
    { value: 'arboricultural', label: 'Arboricultural Reports', icon: '🌳' },
    { value: 'other', label: 'Other Documents', icon: '📄' }
  ];

  res.json({
    success: true,
    documentTypes: documentTypes
  });
});

module.exports = router;
