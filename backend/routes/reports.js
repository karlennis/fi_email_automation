const express = require('express');
const router = express.Router();
const fiReportService = require('../services/fiReportService');
const emailService = require('../services/emailService');
const Customer = require('../models/Customer');
const logger = require('../utils/logger');

const resolveRecipientName = async (recipientList, fallbackName) => {
  if (!Array.isArray(recipientList) || recipientList.length === 0) {
    return fallbackName || 'there';
  }

  const primaryRecipient = String(recipientList[0]).trim().toLowerCase();
  if (!primaryRecipient) {
    return fallbackName || 'there';
  }

  const customer = await Customer.findOne({ email: primaryRecipient }).select('name').lean();
  if (customer?.name) {
    return customer.name;
  }

  return fallbackName || primaryRecipient.split('@')[0];
};

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
 * GET /api/reports
 * List all reports across customers (for the global reports page)
 */
router.get('/', async (req, res) => {
  try {
    const {
      status,
      reportType,
      dateFrom,
      dateTo,
      search,
      includeArchived,
      limit = 200,
      page = 1
    } = req.query;

    const options = {
      status,
      reportType,
      dateFrom,
      dateTo,
      search,
      includeArchived: includeArchived === 'true' || includeArchived === '1',
      limit: parseInt(limit),
      skip: (parseInt(page) - 1) * parseInt(limit)
    };

    const { reports, total } = await fiReportService.getAllReports(options);

    res.json({
      success: true,
      data: {
        reports: reports.map(report => ({
          reportId: report.reportId,
          customerId: report.customerId,
          customerName: report.customerName,
          customerEmail: report.customerEmail,
          reportType: report.reportType,
          status: report.status,
          generatedAt: report.generatedAt,
          sentAt: report.sentAt,
          totalFIMatches: report.totalFIMatches,
          totalProjectsScanned: report.totalProjectsScanned,
          lastDeliveryStatus: report.lastDeliveryStatus,
          totalDeliveryAttempts: report.totalDeliveryAttempts,
          subject: report.emailData?.subject || null,
          notes: report.notes || null,
          archived: report.archived,
          canResend: report.canResend()
        })),
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total
        }
      }
    });
  } catch (error) {
    logger.error('Error retrieving all reports:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve reports'
    });
  }
});

/**
 * Build a plain-text audit document for a set of reports.
 * Full-detail format: report header + every match with its matching quote.
 */
const buildAuditText = (reports) => {
  const fmtDate = (d) => (d ? new Date(d).toISOString() : '—');
  const line = '='.repeat(72);
  const sub = '-'.repeat(72);

  const parts = [];
  parts.push(line);
  parts.push('FI REPORTS AUDIT EXPORT');
  parts.push(`Generated: ${new Date().toISOString()}`);
  parts.push(`Reports: ${reports.length}`);
  parts.push(line);
  parts.push('');

  reports.forEach((report, idx) => {
    parts.push(`REPORT ${idx + 1} of ${reports.length}`);
    parts.push(`  Report ID:        ${report.reportId || '—'}`);
    parts.push(`  Customer:         ${report.customerName || '—'} <${report.customerEmail || '—'}>`);
    parts.push(`  Type:             ${report.reportType || '—'}`);
    parts.push(`  Status:           ${report.status || '—'}`);
    parts.push(`  Generated:        ${fmtDate(report.generatedAt)}`);
    parts.push(`  Sent:             ${report.sentAt ? fmtDate(report.sentAt) : 'Not sent'}`);
    parts.push(`  Projects scanned: ${report.totalProjectsScanned ?? 0}`);
    parts.push(`  Matches:          ${report.totalFIMatches ?? 0}`);
    parts.push(`  Last delivery:    ${report.lastDeliveryStatus || 'NONE'}`);
    parts.push('');

    const projects = report.projectsFound || [];
    if (projects.length === 0) {
      parts.push('  (no match details stored)');
    } else {
      projects.forEach((p, pIdx) => {
        parts.push(`  Match ${pIdx + 1}: ${p.planningTitle || p.projectId || 'Untitled'}`);
        if (p.projectId) parts.push(`    Project ID:   ${p.projectId}`);
        const meta = [];
        if (p.planningStage) meta.push(`Stage: ${p.planningStage}`);
        if (p.planningCounty) meta.push(`County: ${p.planningCounty}`);
        if (p.planningValue) meta.push(`Value: €${p.planningValue}`);
        if (meta.length) parts.push(`    ${meta.join('  |  ')}`);
        if (p.fiIndicators?.length) parts.push(`    FI indicators: ${p.fiIndicators.join(', ')}`);
        if (p.metadata?.documentName) parts.push(`    Document:     ${p.metadata.documentName}`);
        if (p.biiUrl) parts.push(`    URL:          ${p.biiUrl}`);
        if (p.metadata?.summary) parts.push(`    Summary:      ${p.metadata.summary}`);
        if (p.metadata?.validationQuote) {
          parts.push(`    Matching quote:`);
          parts.push(`      "${p.metadata.validationQuote}"`);
        } else {
          parts.push(`    Matching quote: (none recorded)`);
        }
        parts.push('');
      });
    }

    parts.push(sub);
    parts.push('');
  });

  return parts.join('\n');
};

/**
 * POST /api/reports/export
 * Build a plain-text (.txt) audit file for the selected reports across runs
 */
router.post('/export', async (req, res) => {
  try {
    const { reportIds } = req.body;

    if (!Array.isArray(reportIds) || reportIds.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'reportIds must be a non-empty array'
      });
    }

    if (reportIds.length > 500) {
      return res.status(400).json({
        success: false,
        error: 'Too many reports selected (max 500)'
      });
    }

    const reports = await fiReportService.getReportsByIds(reportIds);

    if (reports.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'No matching reports found'
      });
    }

    const text = buildAuditText(reports);
    const filename = `reports-audit-${new Date().toISOString().slice(0, 10)}.txt`;

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(text);
  } catch (error) {
    logger.error('Error exporting reports:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to export reports'
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
    const { newRecipientEmail, customerId, includedProjectIds, subject } = req.body;

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

    // Optionally restrict the projects included in this send
    let projectsToSend = report.projectsFound || [];
    if (Array.isArray(includedProjectIds) && includedProjectIds.length > 0) {
      const includeSet = new Set(includedProjectIds.map(id => String(id)));
      projectsToSend = projectsToSend.filter(project => includeSet.has(String(project.projectId)));
    }

    if (projectsToSend.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'No matches selected to send'
      });
    }

    // Map stored project data back into the shape the email template expects
    const matches = projectsToSend.map(project => ({
      projectId: project.projectId,
      reportType: (project.fiIndicators && project.fiIndicators[0]) || 'FI',
      documentName: project.metadata?.documentName || 'Unknown document',
      validationQuote: project.metadata?.validationQuote || '',
      summary: project.metadata?.summary || '',
      specificRequests: project.metadata?.specificRequests || '',
      projectMetadata: {
        planning_title: project.planningTitle || 'N/A',
        planning_stage: project.planningStage || 'N/A',
        planning_sector: project.metadata?.planningSector || project.planningRegion || 'N/A',
        planning_authority: project.metadata?.planningAuthority || 'N/A',
        planning_county: project.planningCounty || 'N/A',
        planning_value: project.planningValue || 0,
        bii_url: project.biiUrl || null
      }
    }));

    // Support one or more comma/semicolon separated recipients
    const recipientList = String(newRecipientEmail)
      .split(/[,;]+/)
      .map(email => email.trim())
      .filter(Boolean);

    const recipientName = await resolveRecipientName(recipientList, report.customerName);

    // Send the email
    const emailResult = await emailService.sendBatchFINotification(
      recipientList.join(', '),
      recipientName,
      { matches },
      { subject: subject || undefined }
    );

    // Update delivery status
    if (emailResult.success && !emailResult.skipped) {
      await fiReportService.updateDeliveryStatus(
        reportId,
        'SUCCESS',
        recipientList.join(', '),
        null,
        emailResult.messageId
      );

      res.json({
        success: true,
        message: 'Report resent successfully',
        data: {
          reportId: report.reportId,
          newRecipientEmail: recipientList.join(', '),
          projectsSent: matches.length,
          messageId: emailResult.messageId
        }
      });
    } else if (emailResult.skipped) {
      res.status(400).json({
        success: false,
        error: emailResult.reason || 'Email skipped — no valid project details to send'
      });
    } else {
      await fiReportService.updateDeliveryStatus(
        reportId,
        'FAILED',
        recipientList.join(', '),
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

    // Map stored project data back into the shape the email template expects
    const matches = (report.projectsFound || []).map(project => ({
      projectId: project.projectId,
      reportType: (project.fiIndicators && project.fiIndicators[0]) || 'FI',
      documentName: project.metadata?.documentName || 'Unknown document',
      validationQuote: project.metadata?.validationQuote || '',
      summary: project.metadata?.summary || '',
      specificRequests: project.metadata?.specificRequests || '',
      projectMetadata: {
        planning_title: project.planningTitle || 'N/A',
        planning_stage: project.planningStage || 'N/A',
        planning_sector: project.metadata?.planningSector || project.planningRegion || 'N/A',
        planning_authority: project.metadata?.planningAuthority || 'N/A',
        planning_county: project.planningCounty || 'N/A',
        planning_value: project.planningValue || 0,
        bii_url: project.biiUrl || null
      }
    }));

    // Send the email
    const retryRecipientName = await resolveRecipientName([report.customerEmail], report.customerName);
    const emailResult = await emailService.sendBatchFINotification(
      report.customerEmail,
      retryRecipientName,
      { matches }
    );

    // Update delivery status
    if (emailResult.success && !emailResult.skipped) {
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
    } else if (emailResult.skipped) {
      res.status(400).json({
        success: false,
        error: emailResult.reason || 'Email skipped — no valid project details to send'
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
 * PATCH /api/reports/:reportId
 * Update editable fields of a report (subject, notes, recipient)
 */
router.patch('/:reportId', async (req, res) => {
  try {
    const { reportId } = req.params;
    const { subject, notes, customerEmail } = req.body;

    const report = await fiReportService.updateReport(reportId, { subject, notes, customerEmail });

    res.json({
      success: true,
      message: 'Report updated',
      data: {
        reportId: report.reportId,
        subject: report.emailData?.subject || null,
        notes: report.notes || null,
        customerEmail: report.customerEmail
      }
    });
  } catch (error) {
    logger.error(`Error updating report ${req.params.reportId}:`, error);
    const httpStatus = /not found/i.test(error.message) ? 404 : 500;
    res.status(httpStatus).json({
      success: false,
      error: httpStatus === 404 ? 'Report not found' : 'Failed to update report'
    });
  }
});

/**
 * POST /api/reports/:reportId/archive
 * Archive (or unarchive) a single report
 */
router.post('/:reportId/archive', async (req, res) => {
  try {
    const { reportId } = req.params;
    const archived = req.body.archived !== false; // default true

    const report = await fiReportService.setReportArchived(reportId, archived);

    res.json({
      success: true,
      message: archived ? 'Report archived' : 'Report unarchived',
      data: { reportId: report.reportId, archived: report.archived }
    });
  } catch (error) {
    logger.error(`Error archiving report ${req.params.reportId}:`, error);
    const httpStatus = /not found/i.test(error.message) ? 404 : 500;
    res.status(httpStatus).json({
      success: false,
      error: httpStatus === 404 ? 'Report not found' : 'Failed to archive report'
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

/**
 * DELETE /api/reports/:reportId
 * Permanently delete a single report
 */
router.delete('/:reportId', async (req, res) => {
  try {
    const { reportId } = req.params;

    await fiReportService.deleteReport(reportId);

    res.json({
      success: true,
      message: 'Report deleted',
      data: { reportId }
    });
  } catch (error) {
    logger.error(`Error deleting report ${req.params.reportId}:`, error);
    const httpStatus = /not found/i.test(error.message) ? 404 : 500;
    res.status(httpStatus).json({
      success: false,
      error: httpStatus === 404 ? 'Report not found' : 'Failed to delete report'
    });
  }
});

module.exports = router;