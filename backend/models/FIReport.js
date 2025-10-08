const mongoose = require('mongoose');

const fiReportSchema = new mongoose.Schema({
  // Report identification
  reportId: {
    type: String,
    required: true,
    unique: true,
    default: () => `FI_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
  },

  // Customer information
  customerId: {
    type: String,
    required: true,
    index: true
  },
  customerEmail: {
    type: String,
    required: true
  },
  customerName: {
    type: String,
    required: false
  },

  // Report metadata
  reportType: {
    type: String,
    enum: ['FI_DETECTION', 'BATCH_FI_NOTIFICATION'],
    required: true,
    default: 'FI_DETECTION'
  },
  status: {
    type: String,
    enum: ['GENERATED', 'SENT', 'FAILED', 'RESENT'],
    required: true,
    default: 'GENERATED'
  },

  // Detection parameters
  searchCriteria: {
    keywords: [String],
    dateRange: {
      from: Date,
      to: Date
    },
    projectTypes: [String],
    regions: [String],
    customFilters: mongoose.Schema.Types.Mixed
  },

  // Results data
  projectsFound: [{
    projectId: {
      type: String,
      required: true
    },
    planningTitle: String,
    planningStage: String,
    planningValue: Number,
    planningCounty: String,
    planningRegion: String,
    biiUrl: String,
    fiIndicators: [String],
    matchedKeywords: [String],
    confidence: Number,
    metadata: mongoose.Schema.Types.Mixed
  }],

  totalProjectsScanned: {
    type: Number,
    default: 0
  },
  totalFIMatches: {
    type: Number,
    default: 0
  },

  // Email tracking
  emailData: {
    subject: String,
    htmlContent: String,
    textContent: String,
    attachments: [{
      filename: String,
      path: String,
      contentType: String
    }]
  },

  // Delivery tracking
  deliveryAttempts: [{
    attemptNumber: Number,
    timestamp: Date,
    status: {
      type: String,
      enum: ['SUCCESS', 'FAILED', 'PENDING']
    },
    error: String,
    recipientEmail: String,
    messageId: String
  }],

  // Timing
  generatedAt: {
    type: Date,
    default: Date.now,
    index: true
  },
  sentAt: Date,
  lastAttemptAt: Date,

  // Additional metadata
  processingTime: Number, // in milliseconds
  source: {
    type: String,
    enum: ['MANUAL', 'SCHEDULED', 'API'],
    default: 'MANUAL'
  },
  notes: String,

  // Archive and cleanup
  archived: {
    type: Boolean,
    default: false
  },
  expiresAt: {
    type: Date,
    index: { expireAfterSeconds: 0 }
  }
}, {
  timestamps: true,
  collection: 'fi_reports'
});

// Indexes for efficient querying
fiReportSchema.index({ customerId: 1, generatedAt: -1 });
fiReportSchema.index({ status: 1, generatedAt: -1 });
fiReportSchema.index({ reportType: 1, customerId: 1 });
fiReportSchema.index({ 'projectsFound.projectId': 1 });
fiReportSchema.index({ archived: 1, generatedAt: -1 });

// Virtual for total delivery attempts
fiReportSchema.virtual('totalDeliveryAttempts').get(function() {
  return this.deliveryAttempts ? this.deliveryAttempts.length : 0;
});

// Virtual for last delivery status
fiReportSchema.virtual('lastDeliveryStatus').get(function() {
  if (!this.deliveryAttempts || this.deliveryAttempts.length === 0) {
    return 'NONE';
  }
  return this.deliveryAttempts[this.deliveryAttempts.length - 1].status;
});

// Methods
fiReportSchema.methods.addDeliveryAttempt = function(status, recipientEmail, error = null, messageId = null) {
  const attempt = {
    attemptNumber: this.deliveryAttempts.length + 1,
    timestamp: new Date(),
    status,
    recipientEmail,
    error,
    messageId
  };

  this.deliveryAttempts.push(attempt);
  this.lastAttemptAt = new Date();

  if (status === 'SUCCESS') {
    this.status = 'SENT';
    this.sentAt = new Date();
  } else if (status === 'FAILED') {
    this.status = 'FAILED';
  }

  return this.save();
};

fiReportSchema.methods.markAsResent = function(newRecipientEmail, messageId) {
  this.status = 'RESENT';
  return this.addDeliveryAttempt('SUCCESS', newRecipientEmail, null, messageId);
};

fiReportSchema.methods.canResend = function() {
  return ['GENERATED', 'FAILED', 'SENT'].includes(this.status) && !this.archived;
};

// Static methods
fiReportSchema.statics.findByCustomer = function(customerId, options = {}) {
  const query = { customerId, archived: false };

  if (options.status) {
    query.status = options.status;
  }

  if (options.reportType) {
    query.reportType = options.reportType;
  }

  if (options.dateFrom || options.dateTo) {
    query.generatedAt = {};
    if (options.dateFrom) query.generatedAt.$gte = new Date(options.dateFrom);
    if (options.dateTo) query.generatedAt.$lte = new Date(options.dateTo);
  }

  return this.find(query)
    .sort({ generatedAt: -1 })
    .limit(options.limit || 50);
};

fiReportSchema.statics.findFailedReports = function(olderThanHours = 1) {
  const cutoffTime = new Date(Date.now() - (olderThanHours * 60 * 60 * 1000));

  return this.find({
    status: 'FAILED',
    lastAttemptAt: { $lt: cutoffTime },
    archived: false
  });
};

fiReportSchema.statics.getCustomerStats = function(customerId, days = 30) {
  const startDate = new Date(Date.now() - (days * 24 * 60 * 60 * 1000));

  return this.aggregate([
    {
      $match: {
        customerId,
        generatedAt: { $gte: startDate },
        archived: false
      }
    },
    {
      $group: {
        _id: null,
        totalReports: { $sum: 1 },
        totalProjectsFound: { $sum: '$totalFIMatches' },
        successfulSends: {
          $sum: { $cond: [{ $eq: ['$status', 'SENT'] }, 1, 0] }
        },
        failedSends: {
          $sum: { $cond: [{ $eq: ['$status', 'FAILED'] }, 1, 0] }
        },
        avgProcessingTime: { $avg: '$processingTime' }
      }
    }
  ]);
};

module.exports = mongoose.model('FIReport', fiReportSchema);