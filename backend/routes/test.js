/**
 * Quick Test Routes for FI Detection System
 * Add this to your main app.js or routes
 */

const express = require('express');
const fiDetectionService = require('../services/fiDetectionService');
const emailService = require('../services/emailService');
const buildingInfoService = require('../services/buildingInfoService');

const router = express.Router();

/**
 * Quick FI Detection Test
 * GET /api/test/fi-detection?reportTypes=acoustic,flood&maxProjects=3
 */
router.get('/fi-detection', async (req, res) => {
  try {
    const startTime = Date.now();

    // Parse parameters
    const reportTypes = req.query.reportTypes ? req.query.reportTypes.split(',') : ['acoustic'];
    const maxProjects = parseInt(req.query.maxProjects) || 5;
    const sendEmail = req.query.sendEmail === 'true';

    console.log(`🧪 Quick Test: ${reportTypes.join(', ')} - Max ${maxProjects} projects`);

    // Run FI detection
    const result = await fiDetectionService.processFIRequestWithFiltering(
      reportTypes,
      {}, // No API filters for quick test
      sendEmail ? [{
        email: 'afolabifatogun01@gmail.com',
        name: 'Test User'
      }] : []
    );

    const endTime = Date.now();
    const duration = ((endTime - startTime) / 1000).toFixed(2);

    // Send email if requested and matches found
    let emailResult = null;
    if (sendEmail && result.customerMatches && result.customerMatches.length > 0) {
      for (const customerMatch of result.customerMatches) {
        if (customerMatch.matches && customerMatch.matches.length > 0) {
          emailResult = await emailService.sendBatchFINotification(
            customerMatch.email,
            customerMatch.name,
            { matches: customerMatch.matches }
          );
          break; // Just test with first customer
        }
      }
    }

    res.json({
      success: true,
      duration: `${duration}s`,
      testParams: {
        reportTypes,
        maxProjects,
        sendEmail
      },
      summary: {
        totalMatches: result.results?.length || 0,
        customersNotified: result.customerMatches?.length || 0,
        processingStats: result.processingStats
      },
      matches: result.results?.slice(0, 10).map(match => ({
        projectId: match.projectId,
        reportType: match.reportType,
        projectTitle: match.projectMetadata?.planning_title || 'N/A',
        biiUrl: match.projectMetadata?.bii_url || null,
        hasValidUrl: !!(match.projectMetadata?.bii_url),
        documentName: match.documentName,
        detectionMethod: match.detectionMethod
      })) || [],
      emailResult: emailResult ? {
        success: emailResult.success,
        messageId: emailResult.messageId,
        error: emailResult.error
      } : null
    });

  } catch (error) {
    console.error('Test API error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

/**
 * Test Single Project Metadata
 * GET /api/test/project-metadata/366490
 */
router.get('/project-metadata/:projectId', async (req, res) => {
  try {
    const { projectId } = req.params;

    console.log(`🔍 Testing metadata for project ${projectId}`);

    const metadata = await buildingInfoService.getProjectMetadata(projectId);

    res.json({
      success: true,
      projectId,
      metadata,
      hasValidUrl: !!(metadata.bii_url),
      urlConstruction: metadata.bii_url ? 'Valid from planning_path_url' : 'No valid path available'
    });

  } catch (error) {
    console.error('Metadata test error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Test Email System
 * POST /api/test/email
 */
router.post('/email', async (req, res) => {
  try {
    const { email = 'afolabifatogun01@gmail.com', type = 'test' } = req.body;

    let result;

    if (type === 'test') {
      result = await emailService.sendTestEmail(email);
    } else if (type === 'sample-fi') {
      // Send a sample FI notification
      result = await emailService.sendBatchFINotification(
        email,
        'Test User',
        {
          matches: [{
            projectId: '366490',
            reportType: 'acoustic',
            projectMetadata: {
              planning_title: 'Test Project',
              planning_stage: 'Plans Granted',
              planning_sector: 'Commercial',
              bii_url: 'https://app.buildinginfo.com/p-test123'
            },
            documentName: 'test-document.pdf',
            confidence: 0.95,
            detectionMethod: 'test'
          }]
        }
      );
    }

    res.json({
      success: true,
      emailType: type,
      result
    });

  } catch (error) {
    console.error('Email test error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * System Status Check
 * GET /api/test/status
 */
router.get('/status', async (req, res) => {
  try {
    const checks = {
      openai: !!process.env.OPENAI_API_KEY,
      buildingInfoApi: !!(process.env.BUILDING_INFO_API_KEY && process.env.BUILDING_INFO_API_UKEY),
      email: !!process.env.SMTP_USER,
      aws: !!(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY)
    };

    const allGood = Object.values(checks).every(check => check);

    res.json({
      success: true,
      status: allGood ? 'All systems ready' : 'Some configuration missing',
      checks,
      cacheStats: {
        fiDetection: fiDetectionService.getCacheStats(),
        buildingInfo: buildingInfoService.cache?.size || 0
      }
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;