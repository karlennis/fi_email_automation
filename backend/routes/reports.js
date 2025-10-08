const express = require('express');
const router = express.Router();
const fiReportService = require('../services/fiReportService');
const emailService = require('../services/emailService');
const logger = require('../utils/logger');

// Middleware for basic validation
const validateCustomerId = (req, res, next) => {
  const customerId = req.params.customerId || req.body.customerId || req.query.customerId;
  if (!customerId) {
    return res.status(400).json({
      success: false,
      error: 'Customer ID is required'
    });
  }
  req.customerId = customerId;
  next();
};

/**
 * GET /api/reports/customer/:customerId
 * Get all reports for a specific customer
 */
router.get('/customer/:customerId', validateCustomerId, async (req, res) => {
  try {
    const { customerId } = req.params;
    const {
      status,
      reportType,
      dateFrom,
      dateTo,
      limit = 50,
      page = 1
    } = req.query;

    const options = {
      status,
      reportType,
      dateFrom,
      dateTo,
      limit: parseInt(limit),
      skip: (parseInt(page) - 1) * parseInt(limit)
    };

    const reports = await fiReportService.getCustomerReports(customerId, options);

    res.json({
      success: true,
      data: {
        reports: reports.map(report => ({
          reportId: report.reportId,
          reportType: report.reportType,
          status: report.status,
          generatedAt: report.generatedAt,
          sentAt: report.sentAt,
          totalFIMatches: report.totalFIMatches,
          totalProjectsScanned: report.totalProjectsScanned,
          processingTime: report.processingTime,
          lastDeliveryStatus: report.lastDeliveryStatus,
          totalDeliveryAttempts: report.totalDeliveryAttempts,
          customerEmail: report.customerEmail,
          canResend: report.canResend()
        })),
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: reports.length
        }
      }
    });
  } catch (error) {
    logger.error('Error retrieving customer reports:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve reports'
    });
  }
});

/**
 * GET /api/reports/:reportId
 * Get detailed information about a specific report
 */
router.get('/:reportId', async (req, res) => {
  try {
    const { reportId } = req.params;
    const { customerId } = req.query;

    const report = await fiReportService.getReport(reportId, customerId);

    res.json({
      success: true,
      data: {
        reportId: report.reportId,
        customerId: report.customerId,
        customerEmail: report.customerEmail,
        customerName: report.customerName,
        reportType: report.reportType,
        status: report.status,
        searchCriteria: report.searchCriteria,
        projectsFound: report.projectsFound,
        totalProjectsScanned: report.totalProjectsScanned,
        totalFIMatches: report.totalFIMatches,
        processingTime: report.processingTime,
        generatedAt: report.generatedAt,
        sentAt: report.sentAt,
        lastAttemptAt: report.lastAttemptAt,
        deliveryAttempts: report.deliveryAttempts,
        emailData: {
          subject: report.emailData?.subject,
          hasContent: !!report.emailData?.htmlContent
        },
        source: report.source,
        notes: report.notes,
        canResend: report.canResend()
      }
    });
  } catch (error) {
    logger.error(`Error retrieving report ${req.params.reportId}:`, error);
    res.status(404).json({
      success: false,
      error: 'Report not found'
    });
  }
});

/**
 * GET /api/reports/customer/:customerId/dashboard
 * Get dashboard summary for a customer
 */
router.get('/customer/:customerId/dashboard', validateCustomerId, async (req, res) => {
  try {
    const { customerId } = req.params;

    const summary = await fiReportService.getDashboardSummary(customerId);

    res.json({
      success: true,
      data: summary
    });
  } catch (error) {
    logger.error(`Error retrieving dashboard for customer ${req.params.customerId}:`, error);
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve dashboard data'
    });
  }
});

/**
 * GET /api/reports/customer/:customerId/stats
 * Get statistics for a customer
 */
router.get('/customer/:customerId/stats', validateCustomerId, async (req, res) => {
  try {
    const { customerId } = req.params;
    const { days = 30 } = req.query;

    const stats = await fiReportService.getCustomerStats(customerId, parseInt(days));

    res.json({
      success: true,
      data: stats
    });
  } catch (error) {
    logger.error(`Error retrieving stats for customer ${req.params.customerId}:`, error);
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve statistics'
    });
  }
});

/**
 * POST /api/reports/:reportId/resend
 * Resend a report to a different email address
 */
router.post('/:reportId/resend', async (req, res) => {
  try {
    const { reportId } = req.params;
    const { newRecipientEmail, customerId } = req.body;

    if (!newRecipientEmail) {
      return res.status(400).json({
        success: false,
        error: 'New recipient email is required'
      });
    }

    if (!customerId) {
      return res.status(400).json({
        success: false,
        error: 'Customer ID is required'
      });
    }

    // Prepare the report for resending
    const report = await fiReportService.resendReport(reportId, newRecipientEmail, customerId);

    // Generate email content
    const emailContent = await emailService.generateFINotificationEmail([{
      email: newRecipientEmail,
      name: report.customerName || newRecipientEmail.split('@')[0],
      matches: report.projectsFound.map(project => ({
        projectId: project.projectId,
        planningTitle: project.planningTitle,
        planningStage: project.planningStage,
        planningCounty: project.planningCounty,
        biiUrl: project.biiUrl,
        fiIndicators: project.fiIndicators,
        matchedKeywords: project.matchedKeywords,
        fullMetadata: project.metadata
      }))
    }]);

    // Send the email
    const emailResult = await emailService.sendBatchFINotification(emailContent);

    // Update delivery status
    if (emailResult.success) {
      await fiReportService.updateDeliveryStatus(
        reportId,
        'SUCCESS',
        newRecipientEmail,
        null,
        emailResult.messageId
      );

      res.json({
        success: true,
        message: 'Report resent successfully',
        data: {
          reportId: report.reportId,
          newRecipientEmail,
          messageId: emailResult.messageId
        }
      });
    } else {
      await fiReportService.updateDeliveryStatus(
        reportId,
        'FAILED',
        newRecipientEmail,
        emailResult.error
      );

      res.status(500).json({
        success: false,
        error: 'Failed to send email',
        details: emailResult.error
      });
    }
  } catch (error) {
    logger.error(`Error resending report ${req.params.reportId}:`, error);
    res.status(500).json({
      success: false,
      error: 'Failed to resend report'
    });
  }
});

/**
 * POST /api/reports/:reportId/retry
 * Retry sending a failed report to the original recipient
 */
router.post('/:reportId/retry', async (req, res) => {
  try {
    const { reportId } = req.params;
    const { customerId } = req.body;

    const report = await fiReportService.getReport(reportId, customerId);

    if (report.status !== 'FAILED') {
      return res.status(400).json({
        success: false,
        error: `Report status is ${report.status}, only FAILED reports can be retried`
      });
    }

    // Generate email content
    const emailContent = await emailService.generateFINotificationEmail([{
      email: report.customerEmail,
      name: report.customerName || report.customerEmail.split('@')[0],
      matches: report.projectsFound.map(project => ({
        projectId: project.projectId,
        planningTitle: project.planningTitle,
        planningStage: project.planningStage,
        planningCounty: project.planningCounty,
        biiUrl: project.biiUrl,
        fiIndicators: project.fiIndicators,
        matchedKeywords: project.matchedKeywords,
        fullMetadata: project.metadata
      }))
    }]);

    // Send the email
    const emailResult = await emailService.sendBatchFINotification(emailContent);

    // Update delivery status
    if (emailResult.success) {
      await fiReportService.updateDeliveryStatus(
        reportId,
        'SUCCESS',
        report.customerEmail,
        null,
        emailResult.messageId
      );

      res.json({
        success: true,
        message: 'Report retry sent successfully',
        data: {
          reportId: report.reportId,
          recipientEmail: report.customerEmail,
          messageId: emailResult.messageId
        }
      });
    } else {
      await fiReportService.updateDeliveryStatus(
        reportId,
        'FAILED',
        report.customerEmail,
        emailResult.error
      );

      res.status(500).json({
        success: false,
        error: 'Failed to retry email',
        details: emailResult.error
      });
    }
  } catch (error) {
    logger.error(`Error retrying report ${req.params.reportId}:`, error);
    res.status(500).json({
      success: false,
      error: 'Failed to retry report'
    });
  }
});

/**
 * GET /api/reports/search/project/:projectId
 * Search for reports containing a specific project
 */
router.get('/search/project/:projectId', async (req, res) => {
  try {
    const { projectId } = req.params;
    const { customerId } = req.query;

    const reports = await fiReportService.searchByProjectId(projectId, customerId);

    res.json({
      success: true,
      data: {
        projectId,
        reports: reports.map(report => ({
          reportId: report.reportId,
          customerId: report.customerId,
          customerEmail: report.customerEmail,
          status: report.status,
          generatedAt: report.generatedAt,
          totalFIMatches: report.totalFIMatches,
          projectMatch: report.projectsFound.find(p => p.projectId === projectId)
        }))
      }
    });
  } catch (error) {
    logger.error(`Error searching reports by project ${req.params.projectId}:`, error);
    res.status(500).json({
      success: false,
      error: 'Failed to search reports'
    });
  }
});

/**
 * GET /api/reports/failed
 * Get failed reports for administration
 */
router.get('/failed', async (req, res) => {
  try {
    const { olderThanHours = 1 } = req.query;

    const failedReports = await fiReportService.getFailedReports(parseInt(olderThanHours));

    res.json({
      success: true,
      data: {
        failedReports: failedReports.map(report => ({
          reportId: report.reportId,
          customerId: report.customerId,
          customerEmail: report.customerEmail,
          generatedAt: report.generatedAt,
          lastAttemptAt: report.lastAttemptAt,
          totalDeliveryAttempts: report.totalDeliveryAttempts,
          lastError: report.deliveryAttempts[report.deliveryAttempts.length - 1]?.error
        }))
      }
    });
  } catch (error) {
    logger.error('Error retrieving failed reports:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve failed reports'
    });
  }
});

/**
 * POST /api/reports/archive
 * Archive old reports
 */
router.post('/archive', async (req, res) => {
  try {
    const { daysOld = 90 } = req.body;

    const archivedCount = await fiReportService.archiveOldReports(parseInt(daysOld));

    res.json({
      success: true,
      message: `Archived ${archivedCount} old reports`,
      data: {
        archivedCount,
        daysOld: parseInt(daysOld)
      }
    });
  } catch (error) {
    logger.error('Error archiving old reports:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to archive reports'
    });
  }
});

/**
 * DELETE /api/reports/cleanup
 * Clean up expired reports
 */
router.delete('/cleanup', async (req, res) => {
  try {
    const deletedCount = await fiReportService.cleanupExpiredReports();

    res.json({
      success: true,
      message: `Deleted ${deletedCount} expired reports`,
      data: {
        deletedCount
      }
    });
  } catch (error) {
    logger.error('Error cleaning up expired reports:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to cleanup reports'
    });
  }
});

module.exports = router;