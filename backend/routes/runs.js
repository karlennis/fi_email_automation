const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const DailyRun = require('../models/DailyRun');
const DailyRunItem = require('../models/DailyRunItem');
const dailyRunService = require('../services/dailyRunService');

/**
 * Create a new daily run
 * POST /api/runs/daily?date=YYYY-MM-DD
 */
router.post('/daily', async (req, res) => {
  try {
    const dateParam = req.query.date || req.body.date;
    
    let targetDate;
    if (dateParam) {
      targetDate = new Date(dateParam);
      targetDate.setHours(0, 0, 0, 0);
    } else {
      // Default to yesterday
      targetDate = new Date();
      targetDate.setDate(targetDate.getDate() - 1);
      targetDate.setHours(0, 0, 0, 0);
    }

    if (isNaN(targetDate.getTime())) {
      return res.status(400).json({
        success: false,
        message: 'Invalid date format. Use YYYY-MM-DD'
      });
    }

    // Check if run already exists for this date
    const existingRun = await DailyRun.findOne({
      targetDate,
      status: { $in: ['queued', 'scanning', 'processing'] }
    });

    if (existingRun) {
      return res.status(409).json({
        success: false,
        message: 'A run is already in progress for this date',
        runId: existingRun.runId
      });
    }

    // Create new run
    const run = await DailyRun.create({
      targetDate,
      status: 'queued'
    });

    logger.info(`📋 Created daily run ${run.runId} for ${targetDate.toISOString().split('T')[0]}`);

    // Start scan asynchronously
    setImmediate(() => {
      dailyRunService.startScan(run.runId).catch(err => {
        logger.error(`❌ Error starting scan for run ${run.runId}:`, err);
      });
    });

    res.status(202).json({
      success: true,
      runId: run.runId,
      targetDate: run.targetDate,
      status: run.status,
      message: 'Daily run created and scan started'
    });

  } catch (error) {
    logger.error('❌ Error creating daily run:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create daily run',
      error: error.message
    });
  }
});

/**
 * Get run status
 * GET /api/runs/:runId
 */
router.get('/:runId', async (req, res) => {
  try {
    const { runId } = req.params;

    const run = await DailyRun.findOne({ runId });

    if (!run) {
      return res.status(404).json({
        success: false,
        message: 'Run not found'
      });
    }

    res.json({
      success: true,
      data: {
        runId: run.runId,
        targetDate: run.targetDate,
        status: run.status,
        counters: run.counters,
        scanProgress: run.scanProgress,
        createdAt: run.createdAt,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
        error: run.error
      }
    });

  } catch (error) {
    logger.error('❌ Error getting run status:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get run status',
      error: error.message
    });
  }
});

/**
 * Get run items (paginated)
 * GET /api/runs/:runId/items?page=1&pageSize=50&status=queued
 */
router.get('/:runId/items', async (req, res) => {
  try {
    const { runId } = req.params;
    const page = parseInt(req.query.page) || 1;
    const pageSize = Math.min(parseInt(req.query.pageSize) || 50, 200);
    const status = req.query.status;

    const query = { runId };
    if (status) {
      query.status = status;
    }

    const skip = (page - 1) * pageSize;

    const [items, totalCount] = await Promise.all([
      DailyRunItem.find(query)
        .sort({ createdAt: 1 })
        .skip(skip)
        .limit(pageSize)
        .lean(),
      DailyRunItem.countDocuments(query)
    ]);

    res.json({
      success: true,
      data: {
        items,
        pagination: {
          page,
          pageSize,
          totalCount,
          totalPages: Math.ceil(totalCount / pageSize),
          hasMore: skip + items.length < totalCount
        }
      }
    });

  } catch (error) {
    logger.error('❌ Error getting run items:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get run items',
      error: error.message
    });
  }
});

/**
 * Retry failed items
 * POST /api/runs/:runId/retry-failed
 */
router.post('/:runId/retry-failed', async (req, res) => {
  try {
    const { runId } = req.params;

    const run = await DailyRun.findOne({ runId });

    if (!run) {
      return res.status(404).json({
        success: false,
        message: 'Run not found'
      });
    }

    // Reset failed items to queued
    const result = await DailyRunItem.updateMany(
      { runId, status: 'failed' },
      { 
        $set: { 
          status: 'queued',
          error: null,
          processingStartedAt: null
        }
      }
    );

    // Update run counters
    if (result.modifiedCount > 0) {
      await DailyRun.updateOne(
        { runId },
        {
          $inc: {
            'counters.failed': -result.modifiedCount,
            'counters.queued': result.modifiedCount
          }
        }
      );

      logger.info(`♻️ Retrying ${result.modifiedCount} failed items for run ${runId}`);
    }

    res.json({
      success: true,
      message: `Reset ${result.modifiedCount} failed items to queued`,
      retriedCount: result.modifiedCount
    });

  } catch (error) {
    logger.error('❌ Error retrying failed items:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to retry items',
      error: error.message
    });
  }
});

/**
 * List all runs
 * GET /api/runs?page=1&pageSize=20
 */
router.get('/', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const pageSize = Math.min(parseInt(req.query.pageSize) || 20, 100);
    const skip = (page - 1) * pageSize;

    const [runs, totalCount] = await Promise.all([
      DailyRun.find()
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(pageSize)
        .lean(),
      DailyRun.countDocuments()
    ]);

    res.json({
      success: true,
      data: {
        runs,
        pagination: {
          page,
          pageSize,
          totalCount,
          totalPages: Math.ceil(totalCount / pageSize)
        }
      }
    });

  } catch (error) {
    logger.error('❌ Error listing runs:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to list runs',
      error: error.message
    });
  }
});

module.exports = router;
