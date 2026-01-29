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
    enum: ['ACTIVE', 'PAUSED', 'STOPPED', 'RUNNING'],
    default: 'PAUSED'
  },
  config: {
    confidenceThreshold: {
      type: Number,
      default: 0.8,
      min: 0,
      max: 1
    },
    reviewThreshold: {
      type: Number,
      default: 0.5,
      min: 0,
      max: 1
    },
    autoProcess: {
      type: Boolean,
      default: true
    },
    enableVisionAPI: {
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
    }
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
