const mongoose = require('mongoose');

const DailyRunItemSchema = new mongoose.Schema({
  runId: {
    type: String,
    required: true,
    index: true
  },
  s3Key: {
    type: String,
    required: true
  },
  projectId: {
    type: String,
    required: true,
    index: true
  },
  fileName: String,
  lastModified: {
    type: Date,
    index: true
  },
  size: Number,
  status: {
    type: String,
    enum: ['queued', 'processing', 'completed', 'failed', 'skipped'],
    default: 'queued',
    index: true
  },
  attempts: {
    type: Number,
    default: 0
  },
  processingStartedAt: Date,
  processingCompletedAt: Date,
  result: {
    fiDetected: Boolean,
    confidence: Number,
    documentType: String,
    method: String
  },
  error: String,
  createdAt: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

// Compound indexes for efficient queries
DailyRunItemSchema.index({ runId: 1, status: 1 });
DailyRunItemSchema.index({ runId: 1, createdAt: 1 });
DailyRunItemSchema.index({ status: 1, processingStartedAt: 1 });

// Unique constraint to prevent duplicate items per run
DailyRunItemSchema.index({ runId: 1, s3Key: 1 }, { unique: true });

module.exports = mongoose.model('DailyRunItem', DailyRunItemSchema);
