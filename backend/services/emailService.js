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

      // Group matches by report type and deduplicate projects within each type
      const matchesByType = {};
      batchData.matches.forEach(match => {
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
            projectTitle: match.projectMetadata?.planning_title || 'Title unavailable',
            planningStage: match.projectMetadata?.planning_stage || 'N/A',
            planningSector: match.projectMetadata?.planning_sector || 'N/A',
            planningAuthority: match.projectMetadata?.planning_authority || 'N/A',
            biiUrl: match.projectMetadata?.bii_url || null // Don't create fallback URLs
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
      const uniqueProjects = new Set(batchData.matches.map(match => match.projectId));
      const totalProjects = uniqueProjects.size;

      const html = template({
        customerName,
        totalMatches: batchData.matches.length,
        totalProjects,
        reportTypes: Object.keys(processedMatchesByType),
        matchesByType: processedMatchesByType,
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

      const html = template({
        customerName,
        reportType: fiData.reportType,
        projectId: fiData.projectId,
        projectTitle: fiData.projectMetadata?.planning_title || fiData.projectTitle || 'Title unavailable',
        documentName: fiData.documentName,
        requestingAuthority: fiData.requestingAuthority,
        deadline: fiData.deadline,
        summary: fiData.summary,
        specificRequests: fiData.specificRequests,
        biiUrl: fiData.projectMetadata?.bii_url || null, // Don't create fallback URLs
        dashboardUrl: `${process.env.FRONTEND_URL}/dashboard`
      });

      const projectTitle = fiData.projectMetadata?.planning_title || fiData.projectTitle || 'Title unavailable';

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
}

module.exports = new EmailService();
