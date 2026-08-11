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
  // How many times this day has been scanned. Incremented on every save.
  //
  // Gap detection treats a day with processedCount 0 as unscanned, because a resume
  // that never re-found its checkpoint marker skips every document and then writes a
  // 0-match result that looks like a completed day. Without this counter a genuinely
  // empty day - a bank holiday, say - would be re-scanned every night forever.
  scanAttempts: {
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
