const mongoose = require('mongoose');

const DailyRunSchema = new mongoose.Schema({
  runId: {
    type: String,
    required: true,
    unique: true,
    default: () => `RUN_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
  },
  targetDate: {
    type: Date,
    required: true,
    index: true
  },
  status: {
    type: String,
    enum: ['queued', 'scanning', 'processing', 'completed', 'error'],
    default: 'queued',
    index: true
  },
  counters: {
    totalItems: { type: Number, default: 0 },
    queued: { type: Number, default: 0 },
    processing: { type: Number, default: 0 },
    completed: { type: Number, default: 0 },
    failed: { type: Number, default: 0 }
  },
  scanProgress: {
    objectsScanned: { type: Number, default: 0 },
    continuationToken: String,
    lastKey: String
  },
  createdAt: {
    type: Date,
    default: Date.now,
    index: true
  },
  startedAt: Date,
  completedAt: Date,
  error: String
}, {
  timestamps: true
});

// Index for efficient queries
DailyRunSchema.index({ targetDate: -1, createdAt: -1 });
DailyRunSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model('DailyRun', DailyRunSchema);
