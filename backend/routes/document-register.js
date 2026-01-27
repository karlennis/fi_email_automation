const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const documentRegisterService = require('../services/documentRegisterService');
const documentRegisterScheduler = require('../services/documentRegisterScheduler');
const fs = require('fs');
const path = require('path');

const jobDir = path.join(__dirname, '../services/outputs');
const jobFilePath = path.join(jobDir, 'register-job.json');

function ensureJobDir() {
  if (!fs.existsSync(jobDir)) {
    fs.mkdirSync(jobDir, { recursive: true });
  }
}

function readJobFile() {
  try {
    if (fs.existsSync(jobFilePath)) {
      return JSON.parse(fs.readFileSync(jobFilePath, 'utf-8'));
    }
  } catch (error) {
    logger.warn('⚠️ Failed to read job file:', error.message);
  }
  return null;
}

function writeJobFile(job) {
  ensureJobDir();
  fs.writeFileSync(jobFilePath, JSON.stringify(job, null, 2));
}

/**
 * Generate document register - MEMORY SAFE VERSION
 * POST /api/document-register/generate
 * Body: { targetDate: '2026-01-21' } (optional)
 */
router.post('/generate', async (req, res) => {
  try {
    const { targetDate } = req.body;

    if (targetDate) {
      logger.info(`📋 API request: STREAMING document register for ${targetDate}`);
    } else {
      logger.info('📋 API request: STREAMING document register (yesterday)');
    }

    // Do NOT run the scan inline in the HTTP request
    const existingJob = readJobFile();
    if (existingJob && ['queued', 'running'].includes(existingJob.status)) {
      return res.status(202).json({
        success: true,
        status: existingJob.status,
        jobId: existingJob.id,
        message: 'A register generation job is already in progress',
        statusUrl: '/api/document-register/status'
      });
    }

    const jobId = `register-${Date.now()}`;
    const job = {
      id: jobId,
      status: 'queued',
      targetDate: targetDate || 'yesterday',
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      progress: {
        totalDocuments: 0,
        totalSize: 0,
        uniqueProjects: 0
      },
      error: null,
      outputs: {
        csv: null,
        metadata: null
      }
    };

    writeJobFile(job);

    res.status(202).json({
      success: true,
      status: 'queued',
      jobId,
      message: 'Document register generation queued',
      statusUrl: '/api/document-register/status'
    });

    // Run async after response (no inline scan)
    setImmediate(async () => {
      const runningJob = { ...job, status: 'running', startedAt: new Date().toISOString() };
      writeJobFile(runningJob);

      try {
        const baseDate = targetDate ? new Date(targetDate) : new Date();
        if (!targetDate) {
          baseDate.setDate(baseDate.getDate() - 1);
        }
        baseDate.setHours(0, 0, 0, 0);
        const dayStart = new Date(baseDate);
        const dayEnd = new Date(baseDate);
        dayEnd.setHours(23, 59, 59, 999);

        const paths = documentRegisterService.getDateBasedPaths(dayStart);
        const result = await documentRegisterService.streamDailyRegisterToCSV(
          dayStart,
          dayEnd,
          paths.csvFile
        );

        const completedJob = {
          ...runningJob,
          status: 'success',
          finishedAt: new Date().toISOString(),
          progress: {
            totalDocuments: result.totalDocuments,
            totalSize: result.totalSize,
            uniqueProjects: result.uniqueProjects
          },
          outputs: {
            csv: result.csvPath,
            metadata: result.metadataPath
          }
        };

        writeJobFile(completedJob);
      } catch (error) {
        const failedJob = {
          ...runningJob,
          status: 'error',
          finishedAt: new Date().toISOString(),
          error: error.message
        };

        writeJobFile(failedJob);
        logger.error('❌ Async document register job failed:', error);
      }
    });

  } catch (error) {
    logger.error('❌ Error generating STREAMING document register:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to generate document register',
      error: error.message,
      suggestion: 'Use streaming CSV method for large datasets'
    });
  }
});

/**
 * Get quick count of projects and documents
 * GET /api/document-register/count
 */
router.get('/count', async (req, res) => {
  try {
    logger.info('📋 API request: Get quick count');

    const count = await documentRegisterService.getQuickCount();

    res.json({
      success: true,
      data: {
        totalProjects: count.totalProjects,
        totalDocuments: count.totalDocuments,
        averageDocsPerProject: count.averageDocsPerProject
      }
    });

  } catch (error) {
    logger.error('❌ Error getting quick count:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get quick count',
      error: error.message
    });
  }
});

/**
 * Get document register status
 * GET /api/document-register/status
 */
router.get('/status', async (req, res) => {
  try {
    const metadata = documentRegisterService.loadMetadata() || {};
    const job = readJobFile();

    res.json({
      success: true,
      data: {
        lastScanDate: metadata.lastScanDate || null,
        totalProjects: metadata.totalProjects || 0,
        totalDocuments: metadata.totalDocuments || 0,
        hasExistingRegister: Boolean(metadata.lastScanDate),
        outputs: {
          csv: documentRegisterService.csvFile,
          xlsx: documentRegisterService.xlsxFile,
          metadata: documentRegisterService.metadataFile
        },
        job
      }
    });

  } catch (error) {
    logger.error('❌ Error getting document register status:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get document register status',
      error: error.message
    });
  }
});

/**
 * Download document register file
 * GET /api/document-register/download/:format
 * @param format - 'csv' or 'xlsx'
 */
router.get('/download/:format', async (req, res) => {
  try {
    const { format } = req.params;

    if (!['csv', 'xlsx'].includes(format)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid format. Use "csv" or "xlsx"'
      });
    }

    if (format === 'xlsx') {
      const metadata = documentRegisterService.loadMetadata();
      const totalDocuments = metadata?.totalDocuments || 0;
      if (totalDocuments > 2000 || !metadata) {
        return res.status(400).json({
          success: false,
          message: 'Use CSV export (XLSX disabled for large datasets)'
        });
      }
    }

    const filePath = format === 'csv'
      ? documentRegisterService.csvFile
      : documentRegisterService.xlsxFile;

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({
        success: false,
        message: 'Document register not found. Generate it first.'
      });
    }

    const fileName = `document-register-${new Date().toISOString().split('T')[0]}.${format}`;

    res.download(filePath, fileName, (err) => {
      if (err) {
        logger.error(`❌ Error downloading ${format} file:`, err);
        if (!res.headersSent) {
          res.status(500).json({
            success: false,
            message: 'Failed to download file',
            error: err.message
          });
        }
      }
    });

  } catch (error) {
    logger.error('❌ Error downloading document register:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to download document register',
      error: error.message
    });
  }
});

/**
 * Get project statistics
 * GET /api/document-register/stats
 */
router.get('/stats', async (req, res) => {
  try {
    const metadata = documentRegisterService.loadMetadata();

    if (!metadata.lastScanDate) {
      return res.status(404).json({
        success: false,
        message: 'No document register found. Generate it first.'
      });
    }

    // Get top projects by document count
    const topProjects = Object.entries(metadata.documentsByProject || {})
      .map(([projectId, stats]) => ({
        projectId,
        documentCount: stats.documentCount,
        lastUpdated: stats.lastUpdated,
        mostRecentDocument: stats.mostRecentDocument
      }))
      .sort((a, b) => new Date(b.lastUpdated) - new Date(a.lastUpdated))
      .slice(0, 20);

    res.json({
      success: true,
      data: {
        totalProjects: metadata.totalProjects,
        totalDocuments: metadata.totalDocuments,
        lastScanDate: metadata.lastScanDate,
        processingTime: metadata.processingTimeMs,
        topProjectsByUpdate: topProjects
      }
    });

  } catch (error) {
    logger.error('❌ Error getting document register stats:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get document register statistics',
      error: error.message
    });
  }
});

/**
 * Get documents by date
 * GET /api/document-register/documents?date=2026-01-22
 */
router.get('/documents', async (req, res) => {
  try {
    const { date } = req.query;

    if (!date) {
      return res.status(400).json({
        success: false,
        message: 'Date parameter is required'
      });
    }

    logger.info(`📋 API request: Get documents for date ${date}`);

    const targetDate = new Date(date);
    const nextDay = new Date(targetDate);
    nextDay.setDate(nextDay.getDate() + 1);

    logger.info(`Calling getDocumentsByDateRange with ${targetDate.toISOString()} to ${nextDay.toISOString()}`);

    const documents = await documentRegisterService.getDocumentsByDateRange(
      targetDate,
      nextDay
    );

    logger.info(`Found ${documents.length} documents for date ${date}`);

    res.json({
      success: true,
      data: {
        documents,
        count: documents.length,
        date: targetDate
      }
    });

  } catch (error) {
    // Handle the special case where register hasn't been generated yet
    if (error.message && error.message.startsWith('REGISTER_NOT_GENERATED:')) {
      const targetDate = error.message.split(':')[1];
      logger.warn(`⚠️  Register not generated for ${targetDate} - returning 202`);
      return res.status(202).json({
        success: false,
        status: 'not_generated',
        message: 'Document register not generated yet. Please generate first.',
        date: targetDate,
        action: 'Generate register first using POST /api/document-register/generate'
      });
    }
    
    logger.error('❌ Error getting documents by date:', error);
    logger.error('Stack trace:', error.stack);
    res.status(500).json({
      success: false,
      message: 'Failed to get documents',
      error: error.message
    });
  }
});

/**
 * Get scheduler status
 * GET /api/document-register/scheduler/status
 */
router.get('/scheduler/status', async (req, res) => {
  try {
    const status = documentRegisterScheduler.getStatus();

    res.json({
      success: true,
      data: status
    });

  } catch (error) {
    logger.error('❌ Error getting scheduler status:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get scheduler status',
      error: error.message
    });
  }
});

/**
 * Manually trigger document register generation
 * POST /api/document-register/scheduler/run
 */
router.post('/scheduler/run', async (req, res) => {
  try {
    logger.info('📋 API request: Manual document register generation');

    const result = await documentRegisterScheduler.runManual();

    res.json({
      success: true,
      message: 'Document register generation triggered successfully',
      data: {
        totalDocuments: result.totalDocuments,
        csvPath: result.csvPath,
        xlsxPath: result.xlsxPath
      }
    });

  } catch (error) {
    logger.error('❌ Error manually running document register:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to run document register generation',
      error: error.message
    });
  }
});

module.exports = router;

