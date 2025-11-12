const mongoose = require('mongoose');

const scheduledJobSchema = new mongoose.Schema({
  // Job identification
  jobId: {
    type: String,
    required: true,
    unique: true,
    default: () => `JOB_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
  },

  // Job type and configuration
  jobType: {
    type: String,
    enum: ['REPORT_GENERATION', 'EMAIL_BATCH', 'FI_DETECTION'],
    required: true
  },

  // Schedule configuration
  schedule: {
    type: {
      type: String,
      enum: ['IMMEDIATE', 'ONCE', 'DAILY', 'WEEKLY', 'MONTHLY', 'CRON'],
      required: true,
      default: 'IMMEDIATE'
    },
    // Cron expression for advanced scheduling (e.g., '0 10 * * 5' = Friday 10 AM)
    cronExpression: {
      type: String,
      required: function() {
        return this.schedule.type === 'CRON';
      }
    },
    // Specific date/time for one-time jobs
    scheduledFor: {
      type: Date,
      required: function() {
        return this.schedule.type === 'ONCE';
      }
    },
    // For weekly: day of week (0-6, Sunday = 0)
    dayOfWeek: {
      type: Number,
      min: 0,
      max: 6
    },
    // For daily/weekly: time in HH:mm format
    timeOfDay: {
      type: String,
      match: /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/
    },
    // Timezone
    timezone: {
      type: String,
      default: 'UTC'
    }
  },

  // Job status
  status: {
    type: String,
    enum: [
      'SCHEDULED',      // Job is scheduled but not yet run
      'PROCESSING',     // Report is being generated
      'CACHED',         // Report generated, waiting for send time
      'SENDING',        // Currently sending emails
      'COMPLETED',      // Successfully completed
      'FAILED',         // Failed execution
      'CANCELLED',      // Manually cancelled
      'PAUSED'          // Temporarily paused
    ],
    required: true,
    default: 'SCHEDULED'
  },

  // Customer associations
  customers: [{
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Customer',
      required: true
    },
    email: {
      type: String,
      required: true
    },
    name: {
      type: String
    },
    // Individual send status
    sendStatus: {
      type: String,
      enum: ['PENDING', 'SENT', 'FAILED', 'BOUNCED'],
      default: 'PENDING'
    },
    sentAt: Date,
    errorMessage: String
  }],

  // Job configuration
  config: {
    // Report types to generate
    reportTypes: [{
      type: String,
      enum: ['acoustic', 'transport', 'ecological', 'flood', 'heritage', 'arboricultural', 'waste', 'lighting']
    }],
    // Project IDs to process
    projectIds: [String],
    // Search criteria for FI detection
    searchCriteria: {
      keywords: [String],
      dateRange: {
        from: Date,
        to: Date
      },
      projectTypes: [String],
      regions: [String]
    },
    // Email template to use
    emailTemplate: {
      type: String,
      default: 'fi-notification'
    },
    // Custom email subject
    customSubject: String,
    // Attach reports as files
    attachReports: {
      type: Boolean,
      default: true
    }
  },

  // Cached results
  cache: {
    // Pre-processed report data (Phase 1 results)
    reportData: {
      customerMatches: [{
        email: String,
        name: String,
        customerId: String,
        matches: [mongoose.Schema.Types.Mixed]
      }],
      totalMatches: Number,
      processedProjects: Number,
      processingTime: Number,
      generatedAt: Date,
      reportSummary: mongoose.Schema.Types.Mixed,
      cacheExpiry: Date
    },
    // Generated report IDs
    reportIds: [String],
    // S3 paths for generated files
    s3Paths: [String],
    // Preview HTML
    previewHtml: String,
    // Generation timestamp
    generatedAt: Date,
    // Cache expiry
    expiresAt: Date
  },

  // Execution tracking
  execution: {
    // Last run time
    lastRunAt: Date,
    // Next scheduled run
    nextRunAt: Date,
    // Total runs
    runCount: {
      type: Number,
      default: 0
    },
    // Success count
    successCount: {
      type: Number,
      default: 0
    },
    // Failure count
    failureCount: {
      type: Number,
      default: 0
    },
    // Average processing time (ms)
    avgProcessingTime: Number,
    // Last error
    lastError: {
      message: String,
      timestamp: Date,
      stack: String
    }
  },

  // Email statistics
  emailStats: {
    totalEmails: {
      type: Number,
      default: 0
    },
    sentEmails: {
      type: Number,
      default: 0
    },
    failedEmails: {
      type: Number,
      default: 0
    },
    bouncedEmails: {
      type: Number,
      default: 0
    }
  },

  // Created by
  createdBy: {
    userId: String,
    username: String
  },

  // Active flag
  isActive: {
    type: Boolean,
    default: true
  },

  // Notes
  notes: String

}, {
  timestamps: true, // Adds createdAt and updatedAt
  toJSON: { virtuals: true }, // Include virtuals when converting to JSON
  toObject: { virtuals: true }
});

// Virtual field for progress percentage
scheduledJobSchema.virtual('progress').get(function() {
  if (!this.emailStats || !this.emailStats.totalEmails || this.emailStats.totalEmails === 0) {
    return 0;
  }
  const completed = (this.emailStats.sentEmails || 0) + (this.emailStats.failedEmails || 0);
  return Math.round((completed / this.emailStats.totalEmails) * 100);
});

// Indexes for efficient querying
scheduledJobSchema.index({ status: 1, 'schedule.type': 1 });
scheduledJobSchema.index({ 'execution.nextRunAt': 1, isActive: 1 });
scheduledJobSchema.index({ 'customers.customerId': 1 });
scheduledJobSchema.index({ jobType: 1, status: 1 });
scheduledJobSchema.index({ createdAt: -1 });

// Methods
scheduledJobSchema.methods.updateStatus = function(newStatus, error = null) {
  this.status = newStatus;
  if (error) {
    this.execution.lastError = {
      message: error.message,
      timestamp: new Date(),
      stack: error.stack
    };
    this.execution.failureCount += 1;
  }
  return this.save();
};

scheduledJobSchema.methods.markCustomerSent = function(customerId, status = 'SENT') {
  const customer = this.customers.find(c => c.customerId.toString() === customerId.toString());
  if (customer && customer.sendStatus === 'PENDING') { // Only update if previously PENDING
    customer.sendStatus = status;
    customer.sentAt = new Date();

    // Update email statistics
    if (status === 'SENT') {
      this.emailStats.sentEmails = (this.emailStats.sentEmails || 0) + 1;
    } else if (status === 'FAILED') {
      this.emailStats.failedEmails = (this.emailStats.failedEmails || 0) + 1;
    } else if (status === 'SKIPPED') {
      // Count skipped as sent for progress calculation
      this.emailStats.sentEmails = (this.emailStats.sentEmails || 0) + 1;
    }

    // Ensure totalEmails is set
    if (!this.emailStats.totalEmails) {
      this.emailStats.totalEmails = this.customers.length;
    }
  }
  return this.save();
};

scheduledJobSchema.methods.markCustomerFailed = function(customerId, errorMessage) {
  const customer = this.customers.find(c => c.customerId.toString() === customerId.toString());
  if (customer && customer.sendStatus === 'PENDING') { // Only update if previously PENDING
    customer.sendStatus = 'FAILED';
    customer.sentAt = new Date();
    customer.errorMessage = errorMessage;

    // Update email statistics
    this.emailStats.failedEmails = (this.emailStats.failedEmails || 0) + 1;

    // Ensure totalEmails is set
    if (!this.emailStats.totalEmails) {
      this.emailStats.totalEmails = this.customers.length;
    }
  }
  return this.save();
};

scheduledJobSchema.methods.cacheReport = function(reportIds, s3Paths, previewHtml, expiryHours = 168) {
  this.cache = {
    reportIds,
    s3Paths,
    previewHtml,
    generatedAt: new Date(),
    expiresAt: new Date(Date.now() + expiryHours * 60 * 60 * 1000)
  };
  this.status = 'CACHED';
  return this.save();
};

scheduledJobSchema.methods.calculateNextRun = function() {
  const schedule = require('node-schedule');

  if (this.schedule.type === 'ONCE') {
    this.execution.nextRunAt = this.schedule.scheduledFor;
  } else if (this.schedule.type === 'CRON') {
    const rule = new schedule.RecurrenceRule();
    // Parse cron expression and calculate next run
    // This is a simplified version - you may want to use a library like 'cron-parser'
    this.execution.nextRunAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // Placeholder
  } else if (this.schedule.type === 'WEEKLY') {
    const now = new Date();
    const [hours, minutes] = (this.schedule.timeOfDay || '10:00').split(':');
    const next = new Date(now);
    next.setHours(parseInt(hours), parseInt(minutes), 0, 0);

    // Calculate days until target day of week
    const currentDay = now.getDay();
    const targetDay = this.schedule.dayOfWeek || 5; // Default Friday
    let daysUntil = targetDay - currentDay;
    if (daysUntil <= 0) daysUntil += 7;

    next.setDate(next.getDate() + daysUntil);
    this.execution.nextRunAt = next;
  } else if (this.schedule.type === 'DAILY') {
    const now = new Date();
    const [hours, minutes] = (this.schedule.timeOfDay || '10:00').split(':');
    const next = new Date(now);
    next.setHours(parseInt(hours), parseInt(minutes), 0, 0);

    if (next <= now) {
      next.setDate(next.getDate() + 1);
    }
    this.execution.nextRunAt = next;
  }

  return this.save();
};

// Virtual for checking if cache is expired
scheduledJobSchema.virtual('isCacheExpired').get(function() {
  if (!this.cache || !this.cache.expiresAt) return true;
  return new Date() > this.cache.expiresAt;
});

const ScheduledJob = mongoose.model('ScheduledJob', scheduledJobSchema);

module.exports = ScheduledJob;
