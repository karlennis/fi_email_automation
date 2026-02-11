const nodemailer = require('nodemailer');
const handlebars = require('handlebars');
const fs = require('fs').promises;
const path = require('path');
const winston = require('winston');
require('dotenv').config(); // Load environment variables

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console()
  ]
});

class EmailService {
  constructor() {
    this.transporter = null;
    this.templates = new Map();
    this.initializeTransporter();
    this.loadTemplates();
  }

  /**
   * Initialize nodemailer transporter
   */
  initializeTransporter() {
    // Skip SMTP setup if credentials are not configured
    if (!process.env.SMTP_USER || process.env.SMTP_USER === 'your-email@gmail.com') {
      logger.warn('SMTP credentials not configured, email service disabled');
      return;
    }

    this.transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT) || 587,
      secure: false, // true for 465, false for other ports
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });

    // Verify connection configuration
    this.transporter.verify((error, success) => {
      if (error) {
        logger.error('SMTP connection error:', error);
      } else {
        logger.info('SMTP server is ready to take our messages');
      }
    });
  }

  /**
   * Load email templates
   */
  async loadTemplates() {
    try {
      // Register Handlebars helpers
      handlebars.registerHelper('gt', function(a, b) {
        return a > b;
      });

      handlebars.registerHelper('eq', function(a, b) {
        return a === b;
      });

      const templatesDir = path.join(__dirname, '../templates');

      // Ensure templates directory exists
      try {
        await fs.mkdir(templatesDir, { recursive: true });
      } catch (error) {
        // Directory might already exist
      }

      // Load FI notification template
      const fiTemplateContent = await this.loadTemplate('fi-notification');
      this.templates.set('fi-notification', handlebars.compile(fiTemplateContent));

      // Load FI batch notification template
      const fiBatchTemplateContent = await this.loadTemplate('fi-batch-notification');
      this.templates.set('fi-batch-notification', handlebars.compile(fiBatchTemplateContent));

      // Load scan progress template
      const scanProgressTemplateContent = await this.loadTemplate('scan-progress');
      this.templates.set('scan-progress', handlebars.compile(scanProgressTemplateContent));

      // Load welcome email template
      const welcomeTemplateContent = await this.loadTemplate('welcome');
      this.templates.set('welcome', handlebars.compile(welcomeTemplateContent));

      logger.info('Email templates loaded successfully');
    } catch (error) {
      logger.error('Error loading email templates:', error);
    }
  }

  /**
   * Load individual template
   */
  async loadTemplate(templateName) {
    const templatePath = path.join(__dirname, '../templates', `${templateName}.hbs`);

    try {
      return await fs.readFile(templatePath, 'utf8');
    } catch (error) {
      logger.warn(`Template ${templateName} not found, using default`);
      return this.getDefaultTemplate(templateName);
    }
  }

  /**
   * Get default template content
   */
  getDefaultTemplate(templateName) {
    const templates = {
      'fi-batch-notification': `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <title>Further Information Requests Notification</title>
          <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
            .header { background-color: #f4f4f4; padding: 20px; text-align: center; }
            .content { padding: 20px; }
            .summary-box { background-color: #d1ecf1; border: 1px solid #bee5eb; padding: 15px; margin: 15px 0; border-radius: 5px; }
            .project-card-compact { background-color: #f8f9fa; border-left: 4px solid #28a745; padding: 10px 15px; margin: 8px 0; border-radius: 3px; }
            .project-card-compact h4 { margin: 0 0 5px 0; font-size: 1.1em; color: #333; }
            .project-card-compact h4 a { color: #333; text-decoration: none; font-weight: bold; }
            .project-card-compact h4 a:hover { text-decoration: underline; color: #28a745; }
            .project-id { font-weight: normal; color: #666; font-size: 0.9em; }
            .project-meta-compact { font-size: 0.85em; color: #666; }
            .meta-item { display: inline; }
            .meta-separator { margin: 0 8px; color: #999; }
            .view-link { color: #28a745; text-decoration: none; }
            .view-link:hover { text-decoration: underline; }
            .report-type-section { margin: 15px 0; }
            .report-type-section h3 { color: #28a745; margin-bottom: 10px; font-size: 1.2em; }
            .evidence-table { width: 100%; border-collapse: collapse; margin: 15px 0; font-size: 0.9em; }
            .evidence-table th { background-color: #28a745; color: white; padding: 10px; text-align: left; }
            .evidence-table td { padding: 10px; border-bottom: 1px solid #e0e0e0; vertical-align: top; }
            .evidence-table tr:nth-child(even) { background-color: #f8f9fa; }
            .evidence-table .doc-name { font-weight: 500; color: #333; max-width: 250px; word-break: break-word; }
            .evidence-table .quote-text { font-style: italic; color: #555; max-width: 450px; }
            .footer { background-color: #f4f4f4; padding: 20px; text-align: center; font-size: 11px; color: #666; border-top: 1px solid #ddd; line-height: 1.4; }
            .footer strong { color: #333; }
            .footer a { color: #007bff; text-decoration: none; }
            .footer a:hover { text-decoration: underline; }
          </style>
        </head>
        <body>
          <div class="header">
            <h1>Further Information Requests Detected</h1>
          </div>

          <div class="content">
            <p>Hi {{customerName}},</p>

            <div class="summary-box">
              <h3>Processing Summary - {{processingDate}}</h3>
              <p>We detected Further Information requests in <strong>{{totalProjects}}</strong> project{{#if (gt totalProjects 1)}}s{{/if}} for the following report types:</p>
            </div>

            {{#each matchesByType}}
            <div class="report-type-section">
              <h3>{{@key}} Reports ({{this.length}} project{{#if (gt this.length 1)}}s{{/if}})</h3>
              {{#each this}}
              <div class="project-card-compact">
                <h4>{{#if biiUrl}}<a href="{{biiUrl}}" target="_blank" class="view-link" style="text-decoration: none; color: #333;">{{projectTitle}}</a>{{else}}{{projectTitle}}{{/if}} <span class="project-id">(ID: {{projectId}})</span></h4>
                <div class="project-meta-compact">
                  <span class="meta-item">{{planningStage}}</span>
                  <span class="meta-separator">•</span>
                  <span class="meta-item">{{planningSector}}</span>
                </div>
              </div>
              {{/each}}
            </div>
            {{/each}}

            {{#if allMatches.length}}
            <div style="margin-top: 25px;">
              <h3 style="color: #28a745; border-bottom: 2px solid #28a745; padding-bottom: 8px;">Evidence Details</h3>
              <table class="evidence-table">
                <thead>
                  <tr>
                    <th style="width: 15%;">Project ID</th>
                    <th style="width: 30%;">Doc Name</th>
                    <th style="width: 55%;">Validation Quote</th>
                  </tr>
                </thead>
                <tbody>
                  {{#each allMatches}}
                  <tr>
                    <td style="font-family: monospace; font-size: 11px; color: #666;">{{projectId}}</td>
                    <td class="doc-name">{{documentName}}</td>
                    <td class="quote-text">"{{validationQuote}}"</td>
                  </tr>
                  {{/each}}
                </tbody>
              </table>
            </div>
            {{/if}}

            <p>Best regards,<br><strong>Building Info Team</strong></p>
          </div>

          <div class="footer">
            <div style="margin-bottom: 15px;">
              <strong>Building Information Ireland</strong><br>
              Bantry House, Jocelyn St, Dundalk, Co. Louth, A91 T4AE<br>
              Ph: +353 1 9053200 | W: <a href="https://www.buildinginfo.com" target="_blank">www.buildinginfo.com</a>
            </div>

            <div style="margin-bottom: 15px;">
              <a href="https://www.google.com/search?q=building+information+ireland+reviews" target="_blank" style="color: #007bff; text-decoration: none;">
                ⭐ Check out our Google Reviews to see what our customers think
              </a>
            </div>

            <hr style="border: none; border-top: 1px solid #ddd; margin: 15px 0;">

            <div style="font-size: 10px; color: #888; text-align: left;">
              <p><strong>CONFIDENTIALITY NOTICE:</strong></p>
              <p>This email and any files transmitted with it are confidential and intended solely for the use of the individual or entity to whom they are addressed. If you have received this email in error please notify the system manager. This message contains confidential information and is intended only for the individual named. If you are not the named addressee you should not disseminate, distribute or copy this e-mail. Please notify the sender immediately by e-mail if you have received this e-mail by mistake and delete this e-mail from your system. If you are not the intended recipient you are notified that disclosing, copying, distributing or taking any action in reliance on the contents of this information is strictly prohibited.</p>
            </div>
          </div>
        </body>
        </html>
      `,
      'fi-notification': `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <title>Further Information Request Notification</title>
          <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
            .header { background-color: #f4f4f4; padding: 20px; text-align: center; }
            .content { padding: 20px; }
            .fi-details { background-color: #fff3cd; border: 1px solid #ffeaa7; padding: 15px; margin: 15px 0; border-radius: 5px; }
            .footer { background-color: #f4f4f4; padding: 15px; text-text: center; font-size: 12px; }
            .button { display: inline-block; padding: 10px 20px; background-color: #007bff; color: white; text-decoration: none; border-radius: 5px; }
          </style>
        </head>
        <body>
          <div class="header">
            <h1>Further Information Request Detected</h1>
          </div>

          <div class="content">
            <p>Dear {{customerName}},</p>

            <p>We have detected a Further Information (FI) request for <strong>{{reportType}}</strong> in the following project:</p>

            <div class="fi-details">
              <h3>Project Details:</h3>
              <p><strong>Project ID:</strong> {{projectId}}</p>
              <p><strong>Project Title:</strong> {{#if biiUrl}}<a href="{{biiUrl}}" target="_blank" style="color: #333; text-decoration: none;">{{projectTitle}}</a>{{else}}{{projectTitle}}{{/if}}</p>
              <p><strong>Document:</strong> {{documentName}}</p>
              {{#if requestingAuthority}}<p><strong>Requesting Authority:</strong> {{requestingAuthority}}</p>{{/if}}
              {{#if deadline}}<p><strong>Deadline:</strong> {{deadline}}</p>{{/if}}
            </div>

            {{#if summary}}
            <h3>Summary:</h3>
            <p>{{summary}}</p>
            {{/if}}

            {{#if specificRequests}}
            <h3>Specific Requests:</h3>
            <p>{{specificRequests}}</p>
            {{/if}}

            <p>
              <a href="{{dashboardUrl}}" class="button">View in Dashboard</a>
            </p>

            <p>Best regards,<br><strong>Building Info Team</strong></p>
          </div>

          <div class="footer">
            <div style="margin-bottom: 15px;">
              <strong>Building Information Ireland</strong><br>
              Bantry House, Jocelyn St, Dundalk, Co. Louth, A91 T4AE<br>
              Ph: +353 1 9053200 | W: <a href="https://www.buildinginfo.com" target="_blank">www.buildinginfo.com</a>
            </div>

            <div style="margin-bottom: 15px;">
              <a href="https://www.google.com/search?q=building+information+ireland+reviews" target="_blank" style="color: #007bff; text-decoration: none;">
                ⭐ Check out our Google Reviews to see what our customers think
              </a>
            </div>

            <hr style="border: none; border-top: 1px solid #ddd; margin: 15px 0;">

            <div style="font-size: 10px; color: #888; text-align: left;">
              <p><strong>CONFIDENTIALITY NOTICE:</strong></p>
              <p>This email and any files transmitted with it are confidential and intended solely for the use of the individual or entity to whom they are addressed. If you have received this email in error please notify the system manager. This message contains confidential information and is intended only for the individual named. If you are not the named addressee you should not disseminate, distribute or copy this e-mail. Please notify the sender immediately by e-mail if you have received this e-mail by mistake and delete this e-mail from your system. If you are not the intended recipient you are notified that disclosing, copying, distributing or taking any action in reliance on the contents of this information is strictly prohibited.</p>
            </div>
          </div>
        </body>
        </html>
      `,
      'welcome': `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <title>Welcome to FI Email Automation</title>
          <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
            .header { background-color: #f4f4f4; padding: 20px; text-align: center; }
            .content { padding: 20px; }
            .footer { background-color: #f4f4f4; padding: 15px; text-align: center; font-size: 12px; }
          </style>
        </head>
        <body>
          <div class="header">
            <h1>Welcome to FI Email Automation</h1>
          </div>

          <div class="content">
            <p>Dear {{customerName}},</p>

            <p>Welcome to our Further Information Email Automation system! You will now receive automated notifications when FI requests related to your subscribed report types are detected.</p>

            <p><strong>Your subscription details:</strong></p>
            <ul>
              {{#each reportTypes}}
              <li>{{this}}</li>
              {{/each}}
            </ul>

            <p>You can manage your subscription and view the dashboard at: <a href="{{dashboardUrl}}">{{dashboardUrl}}</a></p>

            <p>Best regards,<br><strong>Building Info Team</strong></p>
          </div>

          <div class="footer">
            <div style="margin-bottom: 15px;">
              <strong>Building Information Ireland</strong><br>
              Bantry House, Jocelyn St, Dundalk, Co. Louth, A91 T4AE<br>
              Ph: +353 1 9053200 | W: <a href="https://www.buildinginfo.com" target="_blank">www.buildinginfo.com</a>
            </div>

            <div style="margin-bottom: 15px;">
              <a href="https://www.google.com/search?q=building+information+ireland+reviews" target="_blank" style="color: #007bff; text-decoration: none;">
                ⭐ Check out our Google Reviews to see what our customers think
              </a>
            </div>

            <hr style="border: none; border-top: 1px solid #ddd; margin: 15px 0;">

            <div style="font-size: 10px; color: #888; text-align: left;">
              <p><strong>CONFIDENTIALITY NOTICE:</strong></p>
              <p>This email and any files transmitted with it are confidential and intended solely for the use of the individual or entity to whom they are addressed. If you have received this email in error please notify the system manager. This message contains confidential information and is intended only for the individual named. If you are not the named addressee you should not disseminate, distribute or copy this e-mail. Please notify the sender immediately by e-mail if you have received this e-mail by mistake and delete this e-mail from your system. If you are not the intended recipient you are notified that disclosing, copying, distributing or taking any action in reliance on the contents of this information is strictly prohibited.</p>
            </div>
          </div>
        </body>
        </html>
      `
    };

    return templates[templateName] || '<p>Template not found</p>';
  }

  /**
   * Send batch FI notification email with multiple matches
   */
  async sendBatchFINotification(customerEmail, customerName, batchData) {
    try {
      const template = this.templates.get('fi-batch-notification');

      if (!template) {
        throw new Error('FI batch notification template not loaded');
      }

      // Filter out matches without valid project details from BII
      const invalidTitles = ['Title unavailable', 'Untitled project', 'Error loading data', 'N/A'];
      const validMatches = batchData.matches.filter(match => {
        const title = match.projectMetadata?.planning_title;
        if (!title || invalidTitles.includes(title)) {
          logger.info(`⚠️ Excluding project ${match.projectId} from email - no valid details from BII`);
          return false;
        }
        return true;
      });

      // If no valid matches remain, skip sending the email
      if (validMatches.length === 0) {
        logger.info(`ℹ️ No valid matches for ${customerEmail} after filtering - skipping email`);
        return { success: true, skipped: true, reason: 'No matches with valid project details' };
      }

      // Group matches by report type and deduplicate projects within each type
      const matchesByType = {};
      validMatches.forEach(match => {
        // Capitalize report type
        const reportType = match.reportType.charAt(0).toUpperCase() + match.reportType.slice(1);

        if (!matchesByType[reportType]) {
          matchesByType[reportType] = {};
        }

        // Use project ID as key to prevent duplicates
        if (!matchesByType[reportType][match.projectId]) {
          // Map project metadata fields to template-expected names
          const projectData = {
            ...match,
            projectTitle: match.projectMetadata.planning_title,
            planningStage: match.projectMetadata.planning_stage || 'N/A',
            planningSector: match.projectMetadata.planning_sector || 'N/A',
            planningAuthority: match.projectMetadata.planning_authority || 'N/A',
            biiUrl: match.projectMetadata.bii_url || null
          };

          matchesByType[reportType][match.projectId] = projectData;
        }
      });

      // Convert to arrays for template processing
      const processedMatchesByType = {};
      Object.keys(matchesByType).forEach(reportType => {
        processedMatchesByType[reportType] = Object.values(matchesByType[reportType]);
      });

      // Get unique project count
      const uniqueProjects = new Set(validMatches.map(match => match.projectId));
      const totalProjects = uniqueProjects.size;

      // Prepare all matches with validation quotes for the evidence table
      const allMatches = validMatches.map(match => ({
        documentName: match.documentName || 'Unknown document',
        validationQuote: (match.validationQuote || 'No quote captured').substring(0, 300) + 
          ((match.validationQuote?.length || 0) > 300 ? '...' : ''),
        projectId: match.projectId
      }));

      const html = template({
        customerName,
        totalMatches: validMatches.length,
        totalProjects,
        reportTypes: Object.keys(processedMatchesByType),
        matchesByType: processedMatchesByType,
        allMatches: allMatches,
        processingDate: new Date().toLocaleDateString(),
        dashboardUrl: `${process.env.FRONTEND_URL}/dashboard`
      });

      const subject = `FI Requests Detected - ${Object.keys(processedMatchesByType).join(', ')}`;

      const mailOptions = {
        from: `"Building Info Team" <noreply@buildinginfo.com>`,
        replyTo: process.env.SMTP_USER,
        to: customerEmail,
        subject: subject,
        html: html
      };

      const result = await this.transporter.sendMail(mailOptions);

      logger.info(`Batch FI notification sent to ${customerEmail}`, {
        messageId: result.messageId,
        totalMatches: batchData.matches.length,
        reportTypes: Object.keys(matchesByType)
      });

      return {
        success: true,
        messageId: result.messageId
      };

    } catch (error) {
      logger.error(`Failed to send batch FI notification to ${customerEmail}:`, error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Send FI notification email (single project - deprecated, use batch instead)
   */
  async sendFINotification(customerEmail, customerName, fiData) {
    try {
      const template = this.templates.get('fi-notification');

      if (!template) {
        throw new Error('FI notification template not loaded');
      }

      // Skip if no valid project details from BII
      const invalidTitles = ['Title unavailable', 'Untitled project', 'Error loading data', 'N/A'];
      const projectTitle = fiData.projectMetadata?.planning_title || fiData.projectTitle;
      if (!projectTitle || invalidTitles.includes(projectTitle)) {
        logger.info(`⚠️ Skipping FI notification for project ${fiData.projectId} - no valid details from BII`);
        return { success: true, skipped: true, reason: 'No valid project details' };
      }

      const html = template({
        customerName,
        reportType: fiData.reportType,
        projectId: fiData.projectId,
        projectTitle: projectTitle,
        documentName: fiData.documentName,
        requestingAuthority: fiData.requestingAuthority,
        deadline: fiData.deadline,
        summary: fiData.summary,
        specificRequests: fiData.specificRequests,
        biiUrl: fiData.projectMetadata?.bii_url || null,
        dashboardUrl: `${process.env.FRONTEND_URL}/dashboard`
      });

      const mailOptions = {
        from: `"Building Info Team" <noreply@buildinginfo.com>`,
        replyTo: process.env.SMTP_USER,
        to: customerEmail,
        subject: `FI Request Detected: ${fiData.reportType} - ${projectTitle}`,
        html: html
      };

      const result = await this.transporter.sendMail(mailOptions);

      logger.info(`FI notification sent to ${customerEmail}`, {
        messageId: result.messageId,
        reportType: fiData.reportType,
        projectId: fiData.projectId
      });

      return {
        success: true,
        messageId: result.messageId
      };

    } catch (error) {
      logger.error(`Error sending FI notification to ${customerEmail}:`, error);
      throw error;
    }
  }

  /**
   * Send welcome email
   */
  async sendWelcomeEmail(customerEmail, customerName, reportTypes) {
    try {
      const template = this.templates.get('welcome');

      if (!template) {
        throw new Error('Welcome template not loaded');
      }

      const html = template({
        customerName,
        reportTypes,
        dashboardUrl: `${process.env.FRONTEND_URL}/dashboard`
      });

      const mailOptions = {
        from: `"Building Info Team" <noreply@buildinginfo.com>`,
        replyTo: process.env.SMTP_USER,
        to: customerEmail,
        subject: 'Welcome to FI Email Automation',
        html: html
      };

      const result = await this.transporter.sendMail(mailOptions);

      logger.info(`Welcome email sent to ${customerEmail}`, {
        messageId: result.messageId
      });

      return {
        success: true,
        messageId: result.messageId
      };

    } catch (error) {
      logger.error(`Error sending welcome email to ${customerEmail}:`, error);
      throw error;
    }
  }

  /**
   * Send bulk notifications
   */
  async sendBulkNotifications(notifications) {
    const results = [];
    const errors = [];

    for (const notification of notifications) {
      try {
        const result = await this.sendFINotification(
          notification.email,
          notification.customerName,
          notification.fiData
        );
        results.push({
          email: notification.email,
          result
        });
      } catch (error) {
        errors.push({
          email: notification.email,
          error: error.message
        });
      }

      // Add small delay between emails to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    return {
      successful: results,
      failed: errors,
      summary: {
        total: notifications.length,
        successful: results.length,
        failed: errors.length
      }
    };
  }

  /**
   * Test email configuration
   */
  async testConnection() {
    try {
      await this.transporter.verify();
      return { success: true, message: 'SMTP connection successful' };
    } catch (error) {
      logger.error('SMTP connection test failed:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Send scan progress notification email
   */
  async sendScanProgressEmail(toEmails, progressData) {
    try {
      if (!this.transporter) {
        logger.warn('Email service not configured, skipping progress email');
        return { success: false, reason: 'Email service not configured' };
      }

      const template = this.templates.get('scan-progress');
      if (!template) {
        logger.error('Scan progress template not found');
        return { success: false, reason: 'Template not found' };
      }

      const htmlContent = template({
        jobName: progressData.jobName,
        documentType: progressData.documentType,
        startTime: new Date(progressData.startTime).toLocaleString(),
        processedCount: progressData.processedCount.toLocaleString(),
        totalDocuments: progressData.totalDocuments.toLocaleString(),
        remainingCount: (progressData.totalDocuments - progressData.processedCount).toLocaleString(),
        matchesFound: progressData.matchesFound,
        lastProcessedFile: progressData.lastProcessedFile,
        progressPercentage: Math.round((progressData.processedCount / progressData.totalDocuments) * 100),
        isCheckpoint: progressData.isCheckpoint
      });

      const mailOptions = {
        from: process.env.SMTP_USER,
        to: toEmails.join(', '),
        subject: `Scan Progress: ${progressData.processedCount.toLocaleString()}/${progressData.totalDocuments.toLocaleString()} documents processed`,
        html: htmlContent
      };

      const result = await this.transporter.sendMail(mailOptions);

      logger.info(`📧 Progress email sent to ${toEmails.length} recipients (${progressData.processedCount}/${progressData.totalDocuments} docs)`);

      return {
        success: true,
        messageId: result.messageId,
        recipients: toEmails.length
      };

    } catch (error) {
      logger.error('Error sending progress email:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Send test email
   */
  async sendTestEmail(toEmail) {
    try {
      const mailOptions = {
        from: process.env.SMTP_USER,
        to: toEmail,
        subject: 'FI Email Automation - Test Email',
        html: `
          <h2>Test Email</h2>
          <p>This is a test email from the FI Email Automation system.</p>
          <p>Sent at: ${new Date().toISOString()}</p>
        `
      };

      const result = await this.transporter.sendMail(mailOptions);

      logger.info(`Test email sent to ${toEmail}`, {
        messageId: result.messageId
      });

      return {
        success: true,
        messageId: result.messageId
      };

    } catch (error) {
      logger.error(`Error sending test email to ${toEmail}:`, error);
      throw error;
    }
  }

  /**
   * Send scan summary email (sent at end of run to triggering user)
   * Always sent, even if zero matches found
   */
  async sendScanSummaryEmail(toEmail, summaryData) {
    try {
      if (!this.transporter) {
        logger.warn('Email service not configured, skipping summary email');
        return { success: false, reason: 'Email service not configured' };
      }

      const { jobName, documentType, startTime, endTime, duration, processedCount, totalDocuments, matchesFound, matches } = summaryData;
      
      // Build HTML content for summary email
      let matchesHtml = '';
      if (matches && matches.length > 0) {
        matchesHtml = `
          <h3 style="color: #2e7d32;">✅ FI Requests Found (${matchesFound})</h3>
          <table style="border-collapse: collapse; width: 100%; margin-bottom: 20px;">
            <thead>
              <tr style="background-color: #f5f5f5;">
                <th style="border: 1px solid #ddd; padding: 10px; text-align: left;">File Name</th>
                <th style="border: 1px solid #ddd; padding: 10px; text-align: left;">FI Type</th>
                <th style="border: 1px solid #ddd; padding: 10px; text-align: left;">Validation Quote</th>
              </tr>
            </thead>
            <tbody>
              ${matches.map(m => `
                <tr>
                  <td style="border: 1px solid #ddd; padding: 10px;">${m.fileName}</td>
                  <td style="border: 1px solid #ddd; padding: 10px;">${m.fiType}</td>
                  <td style="border: 1px solid #ddd; padding: 10px; font-style: italic;">"${m.validationQuote}"</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        `;
      } else {
        matchesHtml = `
          <div style="background-color: #fff3e0; border-left: 4px solid #ff9800; padding: 15px; margin: 20px 0;">
            <strong>No further information requests were found.</strong>
            <p style="margin: 5px 0 0 0; color: #666;">All ${processedCount.toLocaleString()} documents were processed. No documents matched the ${documentType} FI request criteria.</p>
          </div>
        `;
      }

      const htmlContent = `
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
            .container { max-width: 800px; margin: 0 auto; padding: 20px; }
            .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 20px; border-radius: 8px 8px 0 0; }
            .content { background: #fff; padding: 20px; border: 1px solid #ddd; border-top: none; border-radius: 0 0 8px 8px; }
            .stats { display: flex; flex-wrap: wrap; gap: 15px; margin: 20px 0; }
            .stat-box { background: #f8f9fa; padding: 15px; border-radius: 8px; flex: 1; min-width: 150px; }
            .stat-value { font-size: 24px; font-weight: bold; color: #667eea; }
            .stat-label { color: #666; font-size: 14px; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1 style="margin: 0;">📋 Scan Complete: ${jobName}</h1>
              <p style="margin: 10px 0 0 0; opacity: 0.9;">Document Type: ${documentType.toUpperCase()}</p>
            </div>
            <div class="content">
              <div class="stats">
                <div class="stat-box">
                  <div class="stat-value">${processedCount.toLocaleString()}</div>
                  <div class="stat-label">Documents Processed</div>
                </div>
                <div class="stat-box">
                  <div class="stat-value">${matchesFound}</div>
                  <div class="stat-label">FI Requests Found</div>
                </div>
                <div class="stat-box">
                  <div class="stat-value">${duration}s</div>
                  <div class="stat-label">Duration</div>
                </div>
              </div>
              
              <p><strong>Start Time:</strong> ${new Date(startTime).toLocaleString()}</p>
              <p><strong>End Time:</strong> ${new Date(endTime).toLocaleString()}</p>
              
              ${matchesHtml}
              
              <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
              <p style="color: #666; font-size: 12px;">
                This is an automated summary from the FI Email Automation system.<br>
                Timestamp: ${new Date().toISOString()}
              </p>
            </div>
          </div>
        </body>
        </html>
      `;

      const mailOptions = {
        from: process.env.SMTP_USER,
        to: toEmail,
        subject: `Scan Complete: ${jobName} - ${matchesFound} FI request${matchesFound !== 1 ? 's' : ''} found (${processedCount.toLocaleString()} docs)`,
        html: htmlContent
      };

      const result = await this.transporter.sendMail(mailOptions);

      logger.info(`📧 Summary email sent to ${toEmail} (${matchesFound} matches from ${processedCount} docs)`);

      return {
        success: true,
        messageId: result.messageId
      };

    } catch (error) {
      logger.error('Error sending summary email:', error);
      return { success: false, error: error.message };
    }
  }
}

module.exports = new EmailService();
