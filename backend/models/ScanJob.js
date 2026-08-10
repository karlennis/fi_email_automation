const mongoose = require('mongoose');

const ScanJobSchema = new mongoose.Schema({
  jobId: {
    type: String,
    unique: true
    // Don't set required: true - let pre-save hook generate it
  },
  name: {
    type: String,
    required: true
  },
  documentType: {
    type: String,
    required: true,
    enum: ['acoustic', 'transport', 'flood', 'contamination', 'ecology', 'arboricultural', 'other']
  },
  status: {
    type: String,
    enum: ['ACTIVE', 'PAUSED', 'STOPPED', 'RUNNING', 'CANCELLING'],
    default: 'PAUSED'
  },
  config: {
    autoProcess: {
      type: Boolean,
      default: true
    },
    checkpointTimestamp: Date
  },
  checkpoint: {
    lastProcessedIndex: {
      type: Number,
      default: 0
    },
    lastProcessedFile: String,
    lastProcessedPath: String,
    totalDocuments: {
      type: Number,
      default: 0
    },
    processedCount: {
      type: Number,
      default: 0
    },
    matchesFound: {
      type: Number,
      default: 0
    },
    scanStartTime: Date,
    lastCheckpointTime: Date,
    isResuming: {
      type: Boolean,
      default: false
    },
    // The fields below were written by scanJobProcessor but absent from this schema, so
    // Mongoose strict mode silently discarded them on every save. Two consequences:
    //
    //   - allMatchDetails was lost on every crash, so a resumed scan persisted only the
    //     matches found after the resume.
    //   - scanStartDate never survived, which made the resume branch in processJob dead
    //     code: a resumed job re-derived "yesterday" from the resume time and therefore
    //     scanned a different day than the one it had been part-way through.
    //
    // Documents in the S3 window for a given day, carried across a restart.
    allMatchDetails: [{
      projectId: String,
      fileName: String,
      filePath: String,
      fiType: String,
      validationQuote: String,
      confidence: Number,
      timestamp: Date
    }],
    // Boundaries of the window being scanned, so a resume continues the same day.
    // Written as ISO strings by processJob, so typed loosely.
    scanStartDate: mongoose.Schema.Types.Mixed,
    scanEndDate: mongoose.Schema.Types.Mixed,
    triggeredBy: {
      email: String,
      name: String,
      timestamp: Date
    },
    totalDocumentsRaw: Number
  },
  customers: [{
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Customer'
    },
    email: String,
    company: String
  }],
  schedule: {
    type: {
      type: String,
      enum: ['DAILY', 'WEEKLY', 'MONTHLY', 'CUSTOM'],
      default: 'DAILY'
    },
    timeOfDay: {
      type: String,
      default: '09:00'
    },
    daysOfWeek: [Number],
    // How many days to look back when scanning
    lookbackDays: {
      type: Number,
      default: 1, // Default: scan documents from yesterday
      min: 1,
      max: 365
    },
    // Store original target date for manual jobs (YYYY-MM-DD format)
    targetDate: {
      type: String,
      default: null
    },
    // Day of month for MONTHLY delivery (1-31; capped at 28 in UI to work every month)
    dayOfMonth: {
      type: Number,
      min: 1,
      max: 31,
      default: 1
    }
  },
  statistics: {
    totalScans: {
      type: Number,
      default: 0
    },
    totalDocumentsProcessed: {
      type: Number,
      default: 0
    },
    totalMatches: {
      type: Number,
      default: 0
    },
    totalEmailsSent: {
      type: Number,
      default: 0
    },
    lastScanDate: Date,
    lastMatchDate: Date
  },
  deliveryState: {
    pendingForDate: {
      type: String,
      default: null
    },
    pendingAnchorDate: {
      type: String,
      default: null
    },
    readyAt: Date,
    sentForDate: {
      type: String,
      default: null
    },
    sentAt: Date,
    lastAttemptAt: Date
  },
  createdBy: {
    userId: String,
    email: String,
    name: String
  },
  lastModifiedBy: {
    userId: String,
    email: String,
    name: String,
    timestamp: Date
  }
}, {
  timestamps: true
});

// Generate unique job ID
ScanJobSchema.pre('save', function(next) {
  if (!this.jobId) {
    this.jobId = `SCAN-${this.documentType.toUpperCase()}-${Date.now()}`;
  }
  next();
});

module.exports = mongoose.model('ScanJob', ScanJobSchema);
