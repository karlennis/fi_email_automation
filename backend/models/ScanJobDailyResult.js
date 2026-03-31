const mongoose = require('mongoose');

const ScanJobDailyResultSchema = new mongoose.Schema({
  jobId: {
    type: String,
    required: true,
    index: true
  },
  // The date this scan covers (normalised to midnight UTC, represents yesterday's documents)
  scanDate: {
    type: Date,
    required: true,
    index: true
  },
  scanStartDate: Date,
  scanEndDate: Date,
  // Summary match records — enough to reconstruct customer emails on delivery day
  matches: [{
    projectId: String,
    fileName: String,
    filePath: String,
    fiType: String,
    validationQuote: String,
    confidence: Number,
    timestamp: Date
  }],
  processedCount: {
    type: Number,
    default: 0
  },
  eligibleCount: {
    type: Number,
    default: 0
  },
  skippedBaseline: {
    type: Number,
    default: 0
  },
  baselinedProjects: {
    type: Number,
    default: 0
  },
  // Set to true once results have been included in a customer delivery
  delivered: {
    type: Boolean,
    default: false
  },
  deliveredAt: Date
}, {
  timestamps: true
});

// Prevent duplicate daily records per job
ScanJobDailyResultSchema.index({ jobId: 1, scanDate: 1 }, { unique: true });

module.exports = mongoose.model('ScanJobDailyResult', ScanJobDailyResultSchema);
