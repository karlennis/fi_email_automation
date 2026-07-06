const mongoose = require('mongoose');

// Matches whose project metadata could not be found in the BuildingInfo API.
// Held back from delivery and retried on subsequent delivery runs until
// metadata becomes available (RESOLVED) or retries are exhausted (EXPIRED).
const PendingMetadataMatchSchema = new mongoose.Schema({
  jobId: {
    type: String,
    required: true,
    index: true
  },
  projectId: {
    type: String,
    required: true
  },
  fileName: {
    type: String,
    required: true
  },
  filePath: String,
  fiType: String,
  validationQuote: String,
  confidence: Number,
  // Original match timestamp
  timestamp: Date,
  firstSeenAt: {
    type: Date,
    default: Date.now
  },
  lastAttemptAt: Date,
  // Counted per delivery run, not per API call
  retryCount: {
    type: Number,
    default: 1
  },
  status: {
    type: String,
    enum: ['PENDING', 'RESOLVED', 'EXPIRED'],
    default: 'PENDING',
    index: true
  }
}, {
  timestamps: true
});

PendingMetadataMatchSchema.index({ jobId: 1, projectId: 1, fileName: 1 }, { unique: true });

module.exports = mongoose.model('PendingMetadataMatch', PendingMetadataMatchSchema);
