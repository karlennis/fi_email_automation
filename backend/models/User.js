const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true,
    maxlength: 50
  },
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true,
    validate: {
      validator: function(email) {
        // Domain restriction: only @buildinginfo.com emails allowed
        const emailRegex = /^[^\s@]+@buildinginfo\.com$/i;
        return emailRegex.test(email);
      },
      message: 'Only @buildinginfo.com email addresses are allowed'
    }
  },
  password: {
    type: String,
    required: function() {
      // Password required unless using OAuth
      return !this.oauthProvider;
    },
    minlength: 6
  },
  role: {
    type: String,
    enum: ['admin', 'operator'],
    default: 'operator'
  },
  permissions: {
    // Granular permissions for role-based access control
    canManageUsers: {
      type: Boolean,
      default: false
    },
    canManageJobs: {
      type: Boolean,
      default: true
    },
    canViewAllJobs: {
      type: Boolean,
      default: false
    },
    canManageSystem: {
      type: Boolean,
      default: false
    }
  },
  isActive: {
    type: Boolean,
    default: true
  },
  lastLogin: {
    type: Date
  },
  // OAuth integration fields
  oauthProvider: {
    type: String,
    enum: ['google', null],
    default: null
  },
  oauthId: {
    type: String,
    sparse: true // Allows null values but ensures uniqueness when present
  },
  // Profile information
  profilePicture: String,
  department: String,
  jobTitle: String,
  // Activity tracking
  lastActivity: {
    type: Date,
    default: Date.now
  },
  loginCount: {
    type: Number,
    default: 0
  },
  // Account management
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  modifiedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
}, {
  timestamps: true
});

// Indexes for efficient querying
userSchema.index({ email: 1 });
userSchema.index({ role: 1 });
userSchema.index({ isActive: 1 });
userSchema.index({ oauthId: 1 }, { sparse: true });

// Pre-save middleware to set admin permissions
userSchema.pre('save', function(next) {
  if (this.role === 'admin') {
    this.permissions.canManageUsers = true;
    this.permissions.canManageJobs = true;
    this.permissions.canViewAllJobs = true;
    this.permissions.canManageSystem = true;
  } else if (this.role === 'operator') {
    this.permissions.canManageUsers = false;
    this.permissions.canManageJobs = true;
    this.permissions.canViewAllJobs = false;
    this.permissions.canManageSystem = false;
  }
  next();
});

// Static method to create the primary admin
userSchema.statics.ensurePrimaryAdmin = async function() {
  const adminEmail = 'afatogun@buildinginfo.com';

  try {
    const existingAdmin = await this.findOne({ email: adminEmail });

    if (!existingAdmin) {
      const bcrypt = require('bcryptjs');
      const salt = await bcrypt.genSalt(10);
      const defaultPassword = await bcrypt.hash('AdminPass123!', salt);

      const primaryAdmin = new this({
        name: 'Afolabi Fatogun',
        email: adminEmail,
        password: defaultPassword,
        role: 'admin',
        department: 'Administration',
        jobTitle: 'Primary Administrator'
      });

      await primaryAdmin.save();
      console.log(`Primary admin created: ${adminEmail}`);
      console.log('Default password: AdminPass123! (Please change immediately)');
      return primaryAdmin;
    }

    return existingAdmin;
  } catch (error) {
    console.error('Error ensuring primary admin:', error);
    throw error;
  }
};

// Instance method to check permissions
userSchema.methods.hasPermission = function(permission) {
  if (!this.isActive) return false;
  return this.permissions[permission] === true;
};

// Instance method to update activity
userSchema.methods.updateActivity = function() {
  this.lastActivity = new Date();
  return this.save();
};

const User = mongoose.model('User', userSchema);

module.exports = User;
