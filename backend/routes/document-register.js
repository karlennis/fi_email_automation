const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const documentRegisterService = require('../services/documentRegisterService');
const fs = require('fs');
const path = require('path');

/**
 * Generate document register
 * POST /api/document-register/generate
 */
router.post('/generate', async (req, res) => {
  try {
    logger.info('📋 API request: Generate document register');

    const result = await documentRegisterService.generateRegister();

    res.json({
      success: true,
      message: 'Document register generated successfully',
      data: {
        totalDocuments: result.totalDocuments,
        totalProjects: result.totalProjects,
        processingTime: result.processingTime,
        outputs: result.outputs,
        topProjects: result.topProjects,
        scanDate: result.metadata.lastScanDate
      }
    });

  } catch (error) {
    logger.error('❌ Error generating document register:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to generate document register',
      error: error.message
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

module.exports = router;
