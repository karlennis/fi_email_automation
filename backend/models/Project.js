const mongoose = require('mongoose');

const projectSchema = new mongoose.Schema({
  projectId: {
    type: String,
    required: true,
    unique: true,
    trim: true
  },
  title: {
    type: String,
    required: true,
    trim: true
  },
  planningAuthority: {
    type: String,
    trim: true
  },
  applicant: {
    name: String,
    email: String,
    address: String
  },
  location: {
    type: String,
    trim: true
  },
  description: {
    type: String,
    trim: true
  },
  status: {
    type: String,
    enum: ['submitted', 'under_review', 'fi_requested', 'approved', 'rejected', 'withdrawn'],
    default: 'submitted'
  },
  submissionDate: {
    type: Date
  },
  lastUpdated: {
    type: Date,
    default: Date.now
  },
  biiUrl: {
    type: String,
    trim: true
  },
  sector: {
    type: String,
    trim: true
  },
  stage: {
    type: String,
    trim: true
  },
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  documents: [{
    fileName: String,
    uploadDate: { type: Date, default: Date.now },
    fileSize: Number,
    mimeType: String,
    processedAt: Date,
    documentType: {
      type: String,
      enum: ['ApplicationForm', 'Drawing', 'Report', 'General', 'FIRequest']
    }
  }],
  fiRequests: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'FIRequest'
  }],
  emailsSent: [{
    recipientEmail: String,
    reportType: String,
    sentAt: { type: Date, default: Date.now },
    fiRequestId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'FIRequest'
    }
  }]
}, {
  timestamps: true
});

// Indexes for efficient querying
projectSchema.index({ projectId: 1 });
projectSchema.index({ status: 1 });
projectSchema.index({ lastUpdated: -1 });
projectSchema.index({ 'applicant.email': 1 });

// Virtual for URL-friendly project identifier
projectSchema.virtual('slug').get(function() {
  return this.projectId.toLowerCase().replace(/[^a-z0-9]/g, '-');
});

// Method to add document
projectSchema.methods.addDocument = function(documentData) {
  this.documents.push(documentData);
  this.lastUpdated = new Date();
  return this.save();
};

// Method to record email sent
projectSchema.methods.recordEmailSent = function(recipientEmail, reportType, fiRequestId) {
  this.emailsSent.push({
    recipientEmail,
    reportType,
    fiRequestId,
    sentAt: new Date()
  });
  return this.save();
};

// Static method to find projects with FI requests for a report type
projectSchema.statics.findWithFIForReportType = function(reportType) {
  return this.aggregate([
    {
      $lookup: {
        from: 'firequests',
        localField: 'fiRequests',
        foreignField: '_id',
        as: 'fiRequestDetails'
      }
    },
    {
      $match: {
        'fiRequestDetails.reportType': reportType
      }
    }
  ]);
};

module.exports = mongoose.model('Project', projectSchema);
