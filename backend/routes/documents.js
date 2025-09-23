const express = require('express');
const router = express.Router();
const documentProcessor = require('../services/documentProcessor');
const fiDetectionService = require('../services/fiDetectionService');
const Project = require('../models/Project');



/**
 * POST /api/documents/process-text
 * Process text directly for FI detection
 */
router.post('/process-text', async (req, res) => {
  try {
    const { text, reportType, fileName = 'Text Input' } = req.body;

    if (!text || !reportType) {
      return res.status(400).json({
        success: false,
        error: 'Text and report type are required'
      });
    }

    const result = await fiDetectionService.processFIRequest(
      text,
      reportType,
      fileName
    );

    res.json({
      success: true,
      data: {
        fileName,
        textLength: text.length,
        isFIRequest: result.isFIRequest,
        matchesTargetType: result.matchesTargetType,
        extractedInfo: result.extractedInfo
      }
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to process text',
      message: error.message
    });
  }
});

/**
 * GET /api/documents/cache-stats
 * Get OCR cache statistics
 */
router.get('/cache-stats', async (req, res) => {
  try {
    const stats = await documentProcessor.getCacheStats();

    res.json({
      success: true,
      data: stats
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to get cache statistics',
      message: error.message
    });
  }
});

/**
 * POST /api/documents/cleanup-cache
 * Clean up old OCR cache files
 */
router.post('/cleanup-cache', async (req, res) => {
  try {
    const { maxAgeInDays = 7 } = req.body;

    const cleanedCount = await documentProcessor.cleanupOCRCache(maxAgeInDays);

    res.json({
      success: true,
      data: {
        cleanedCount,
        maxAgeInDays
      },
      message: `Cleaned up ${cleanedCount} old cache files`
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to cleanup cache',
      message: error.message
    });
  }
});

module.exports = router;
