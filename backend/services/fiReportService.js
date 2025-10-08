require('dotenv').config();
const FIReport = require('../models/FIReport');
const logger = require('../utils/logger');

class FIReportService {
  constructor() {
    this.logger = logger;
  }

  /**
   * Create a new FI report
   * @param {Object} reportData - The report data
   * @returns {Promise<Object>} Created report
   */
  async createReport(reportData) {
    try {
      const startTime = Date.now();

      // Calculate processing time if not provided
      if (!reportData.processingTime && reportData.startTime) {
        reportData.processingTime = Date.now() - reportData.startTime;
      }

      // Set expiration (default 90 days)
      if (!reportData.expiresAt) {
        reportData.expiresAt = new Date(Date.now() + (90 * 24 * 60 * 60 * 1000));
      }

      const report = new FIReport(reportData);
      const savedReport = await report.save();

      this.logger.info(`📊 FI Report created: ${savedReport.reportId} for customer ${savedReport.customerId}`, {
        reportId: savedReport.reportId,
        customerId: savedReport.customerId,
        projectsFound: savedReport.totalFIMatches,
        processingTime: savedReport.processingTime
      });

      return savedReport;
    } catch (error) {
      this.logger.error('❌ Error creating FI report:', error);
      throw error;
    }
  }

  /**
   * Get reports for a specific customer
   * @param {string} customerId - Customer ID
   * @param {Object} options - Query options
   * @returns {Promise<Array>} Customer reports
   */
  async getCustomerReports(customerId, options = {}) {
    try {
      const reports = await FIReport.findByCustomer(customerId, options);

      this.logger.info(`📋 Retrieved ${reports.length} reports for customer ${customerId}`, {
        customerId,
        reportCount: reports.length,
        options
      });

      return reports;
    } catch (error) {
      this.logger.error(`❌ Error retrieving reports for customer ${customerId}:`, error);
      throw error;
    }
  }

  /**
   * Get a specific report by ID
   * @param {string} reportId - Report ID
   * @param {string} customerId - Customer ID (for authorization)
   * @returns {Promise<Object>} Report data
   */
  async getReport(reportId, customerId = null) {
    try {
      const query = { reportId };
      if (customerId) {
        query.customerId = customerId;
      }

      const report = await FIReport.findOne(query);

      if (!report) {
        throw new Error(`Report ${reportId} not found`);
      }

      this.logger.info(`📄 Retrieved report: ${reportId}`, {
        reportId,
        customerId: report.customerId,
        status: report.status
      });

      return report;
    } catch (error) {
      this.logger.error(`❌ Error retrieving report ${reportId}:`, error);
      throw error;
    }
  }

  /**
   * Update report delivery status
   * @param {string} reportId - Report ID
   * @param {string} status - Delivery status
   * @param {string} recipientEmail - Recipient email
   * @param {string} error - Error message (if failed)
   * @param {string} messageId - Email message ID
   * @returns {Promise<Object>} Updated report
   */
  async updateDeliveryStatus(reportId, status, recipientEmail, error = null, messageId = null) {
    try {
      const report = await FIReport.findOne({ reportId });

      if (!report) {
        throw new Error(`Report ${reportId} not found`);
      }

      await report.addDeliveryAttempt(status, recipientEmail, error, messageId);

      this.logger.info(`📧 Delivery status updated for report ${reportId}`, {
        reportId,
        status,
        recipientEmail,
        attemptNumber: report.deliveryAttempts.length,
        error: error ? error.substring(0, 100) : null
      });

      return report;
    } catch (error) {
      this.logger.error(`❌ Error updating delivery status for report ${reportId}:`, error);
      throw error;
    }
  }

  /**
   * Resend a report to a different email
   * @param {string} reportId - Report ID
   * @param {string} newRecipientEmail - New recipient email
   * @param {string} customerId - Customer ID (for authorization)
   * @returns {Promise<Object>} Updated report
   */
  async resendReport(reportId, newRecipientEmail, customerId) {
    try {
      const report = await this.getReport(reportId, customerId);

      if (!report.canResend()) {
        throw new Error(`Report ${reportId} cannot be resent (status: ${report.status}, archived: ${report.archived})`);
      }

      // The actual email resending will be handled by the email service
      // This just marks the report as ready for resend
      report.status = 'GENERATED';
      report.customerEmail = newRecipientEmail;
      await report.save();

      this.logger.info(`🔄 Report ${reportId} prepared for resend to ${newRecipientEmail}`, {
        reportId,
        newRecipientEmail,
        customerId
      });

      return report;
    } catch (error) {
      this.logger.error(`❌ Error preparing report ${reportId} for resend:`, error);
      throw error;
    }
  }

  /**
   * Get failed reports for retry
   * @param {number} olderThanHours - Only get reports older than this many hours
   * @returns {Promise<Array>} Failed reports
   */
  async getFailedReports(olderThanHours = 1) {
    try {
      const failedReports = await FIReport.findFailedReports(olderThanHours);

      this.logger.info(`🔍 Found ${failedReports.length} failed reports for retry`, {
        count: failedReports.length,
        olderThanHours
      });

      return failedReports;
    } catch (error) {
      this.logger.error('❌ Error retrieving failed reports:', error);
      throw error;
    }
  }

  /**
   * Get customer statistics
   * @param {string} customerId - Customer ID
   * @param {number} days - Number of days to look back
   * @returns {Promise<Object>} Customer stats
   */
  async getCustomerStats(customerId, days = 30) {
    try {
      const stats = await FIReport.getCustomerStats(customerId, days);
      const result = stats.length > 0 ? stats[0] : {
        totalReports: 0,
        totalProjectsFound: 0,
        successfulSends: 0,
        failedSends: 0,
        avgProcessingTime: 0
      };

      // Calculate success rate
      result.successRate = result.totalReports > 0
        ? Math.round((result.successfulSends / result.totalReports) * 100)
        : 0;

      this.logger.info(`📊 Retrieved stats for customer ${customerId}`, {
        customerId,
        days,
        ...result
      });

      return result;
    } catch (error) {
      this.logger.error(`❌ Error retrieving stats for customer ${customerId}:`, error);
      throw error;
    }
  }

  /**
   * Archive old reports
   * @param {number} daysOld - Archive reports older than this many days
   * @returns {Promise<number>} Number of archived reports
   */
  async archiveOldReports(daysOld = 90) {
    try {
      const cutoffDate = new Date(Date.now() - (daysOld * 24 * 60 * 60 * 1000));

      const result = await FIReport.updateMany(
        {
          generatedAt: { $lt: cutoffDate },
          archived: false
        },
        {
          $set: { archived: true }
        }
      );

      this.logger.info(`📦 Archived ${result.modifiedCount} old reports`, {
        daysOld,
        archivedCount: result.modifiedCount
      });

      return result.modifiedCount;
    } catch (error) {
      this.logger.error('❌ Error archiving old reports:', error);
      throw error;
    }
  }

  /**
   * Delete expired reports
   * @returns {Promise<number>} Number of deleted reports
   */
  async cleanupExpiredReports() {
    try {
      const result = await FIReport.deleteMany({
        expiresAt: { $lt: new Date() }
      });

      this.logger.info(`🗑️ Deleted ${result.deletedCount} expired reports`, {
        deletedCount: result.deletedCount
      });

      return result.deletedCount;
    } catch (error) {
      this.logger.error('❌ Error cleaning up expired reports:', error);
      throw error;
    }
  }

  /**
   * Search reports by project ID
   * @param {string} projectId - Project ID to search for
   * @param {string} customerId - Optional customer ID filter
   * @returns {Promise<Array>} Reports containing the project
   */
  async searchByProjectId(projectId, customerId = null) {
    try {
      const query = {
        'projectsFound.projectId': projectId,
        archived: false
      };

      if (customerId) {
        query.customerId = customerId;
      }

      const reports = await FIReport.find(query)
        .sort({ generatedAt: -1 })
        .limit(20);

      this.logger.info(`🔍 Found ${reports.length} reports containing project ${projectId}`, {
        projectId,
        customerId,
        reportCount: reports.length
      });

      return reports;
    } catch (error) {
      this.logger.error(`❌ Error searching reports by project ${projectId}:`, error);
      throw error;
    }
  }

  /**
   * Get report summary for dashboard
   * @param {string} customerId - Customer ID
   * @returns {Promise<Object>} Dashboard summary
   */
  async getDashboardSummary(customerId) {
    try {
      const [recentReports, stats] = await Promise.all([
        this.getCustomerReports(customerId, { limit: 5 }),
        this.getCustomerStats(customerId, 7) // Last 7 days
      ]);

      const summary = {
        recentReports: recentReports.map(report => ({
          reportId: report.reportId,
          generatedAt: report.generatedAt,
          status: report.status,
          totalFIMatches: report.totalFIMatches,
          reportType: report.reportType
        })),
        weeklyStats: stats,
        hasFailedReports: recentReports.some(r => r.status === 'FAILED')
      };

      this.logger.info(`📊 Generated dashboard summary for customer ${customerId}`, {
        customerId,
        recentReportsCount: summary.recentReports.length,
        hasFailedReports: summary.hasFailedReports
      });

      return summary;
    } catch (error) {
      this.logger.error(`❌ Error generating dashboard summary for customer ${customerId}:`, error);
      throw error;
    }
  }
}

module.exports = new FIReportService();