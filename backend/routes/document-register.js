const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const documentRegisterService = require('../services/documentRegisterService');
const documentRegisterScheduler = require('../services/documentRegisterScheduler');
const fs = require('fs');
const path = require('path');

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

    // Use the memory-safe streaming scheduler
    const result = await documentRegisterScheduler.streamDailyRegisterToCSV({
      date: targetDate,
      csvPath: null // Will be auto-generated
    });

    res.json({
      success: true,
      message: targetDate ?
        `Document register streamed successfully for ${targetDate}` :
        'Document register streamed successfully',
      data: {
        totalDocuments: result.totalDocuments,
        uniqueProjects: result.uniqueProjects,
        processingTime: result.duration,
        csvPath: result.csvPath,
        method: 'streaming',
        memoryFootprint: 'constant',
        scanDate: targetDate || 'yesterday'
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
    const metadata = documentRegisterService.loadMetadata();

    res.json({
      success: true,
      data: {
        lastScanDate: metadata.lastScanDate,
        totalProjects: metadata.totalProjects,
        totalDocuments: metadata.totalDocuments,
        hasExistingRegister: metadata.lastScanDate !== null,
        outputs: {
          csv: documentRegisterService.csvFile,
          xlsx: documentRegisterService.xlsxFile,
          metadata: documentRegisterService.metadataFile
        }
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

