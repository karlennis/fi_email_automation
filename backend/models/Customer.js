const mongoose = require('mongoose');

const customerSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true,
    match: [/^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,3})+$/, 'Please enter a valid email']
  },
  company: {
    type: String,
    trim: true
  },
  phone: {
    type: String,
    trim: true
  },
  projectId: {
    type: String,
    trim: true,
    uppercase: true
  },
  reportTypes: [{
    type: String,
    enum: ['acoustic', 'transport', 'ecological', 'flood', 'heritage', 'arboricultural', 'waste', 'lighting'],
    required: true
  }],
  // Subscription filters - determines which matches the customer receives
  filters: {
    allowedCounties: [{
      type: String,
      trim: true
    }],
    allowedSectors: [{
      type: String,
      trim: true
    }]
  },
  isActive: {
    type: Boolean,
    default: true
  },
  emailPreferences: {
    instantNotification: {
      type: Boolean,
      default: true
    },
    dailyDigest: {
      type: Boolean,
      default: false
    },
    weeklyDigest: {
      type: Boolean,
      default: false
    }
  },
  lastEmailSent: {
    type: Date
  },
  emailCount: {
    type: Number,
    default: 0
  }
}, {
  timestamps: true
});

// Index for efficient querying
customerSchema.index({ email: 1 });
customerSchema.index({ reportTypes: 1 });
customerSchema.index({ isActive: 1 });

// Virtual for full name with company
customerSchema.virtual('displayName').get(function() {
  return this.company ? `${this.name} (${this.company})` : this.name;
});

// Method to check if customer is subscribed to a report type
customerSchema.methods.isSubscribedTo = function(reportType) {
  return this.reportTypes.includes(reportType.toLowerCase());
};

// Method to update last email sent
customerSchema.methods.recordEmailSent = function() {
  this.lastEmailSent = new Date();
  this.emailCount += 1;
  return this.save();
};

module.exports = mongoose.model('Customer', customerSchema);
