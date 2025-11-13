const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Joi = require('joi');
const { authenticate, requirePermission, requireAdmin } = require('../middleware/auth');
const logger = require('../utils/logger');

// Validation schemas
const registerSchema = Joi.object({
  name: Joi.string().required().trim().min(2).max(50),
  email: Joi.string().email().required().lowercase().trim()
    .pattern(/@buildinginfo\.com$/i)
    .message('Only @buildinginfo.com email addresses are allowed'),
  password: Joi.string().required().min(8).max(128)
    .pattern(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]/)
    .message('Password must contain at least one uppercase letter, one lowercase letter, one number, and one special character'),
  role: Joi.string().valid('admin', 'operator').default('operator'),
  department: Joi.string().optional().trim().max(50),
  jobTitle: Joi.string().optional().trim().max(50)
});

const loginSchema = Joi.object({
  email: Joi.string().email().required().lowercase().trim(),
  password: Joi.string().required()
});

/**
 * POST /api/auth/register
 * Register new user (domain restricted)
 */
router.post('/register', async (req, res) => {
  try {
    // Validate request body
    const { error, value } = registerSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        error: 'Validation error',
        details: error.details.map(d => d.message)
      });
    }

    const { name, email, password, role, department, jobTitle } = value;

    // Additional domain check (redundant but good for security)
    if (!email.endsWith('@buildinginfo.com')) {
      return res.status(403).json({
        success: false,
        error: 'Domain restriction',
        message: 'Only @buildinginfo.com email addresses are allowed to register'
      });
    }

    // Check if user already exists
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(409).json({
        success: false,
        error: 'User with this email already exists'
      });
    }

    // Only admins can create other admin accounts
    if (role === 'admin') {
      // Check if request has valid admin token
      const token = req.headers.authorization?.replace('Bearer ', '');
      if (!token) {
        return res.status(403).json({
          success: false,
          error: 'Admin privileges required to create admin accounts'
        });
      }

      try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const requestingUser = await User.findById(decoded.userId);

        if (!requestingUser || requestingUser.role !== 'admin' || !requestingUser.permissions.canManageUsers) {
          return res.status(403).json({
            success: false,
            error: 'Insufficient privileges to create admin accounts'
          });
        }
      } catch (tokenError) {
        return res.status(403).json({
          success: false,
          error: 'Invalid admin token'
        });
      }
    }

    // Hash password
    const salt = await bcrypt.genSalt(12);
    const hashedPassword = await bcrypt.hash(password, salt);

    // Create user
    const user = new User({
      name,
      email,
      password: hashedPassword,
      role: role || 'operator',
      department,
      jobTitle
    });

    await user.save();

    // Log registration
    logger.info(`New user registered: ${email} (${role})`);

    // Generate JWT token
    const token = jwt.sign(
      {
        userId: user._id,
        email: user.email,
        role: user.role,
        permissions: user.permissions
      },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRE || '7d' }
    );

    res.status(201).json({
      success: true,
      data: {
        user: {
          id: user._id,
          name: user.name,
          email: user.email,
          role: user.role,
          permissions: user.permissions,
          department: user.department,
          jobTitle: user.jobTitle
        },
        token
      },
      message: 'User registered successfully'
    });

  } catch (error) {
    logger.error('Registration error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to register user',
      message: error.message
    });
  }
});

/**
 * POST /api/auth/login
 * User login with domain validation
 */
router.post('/login', async (req, res) => {
  try {
    // Validate request body
    const { error, value } = loginSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        error: 'Validation error',
        details: error.details.map(d => d.message)
      });
    }

    const { email, password } = value;

    // Domain check
    if (!email.endsWith('@buildinginfo.com')) {
      return res.status(403).json({
        success: false,
        error: 'Domain restriction',
        message: 'Only @buildinginfo.com users can access this system'
      });
    }

    // Find user
    const user = await User.findOne({ email, isActive: true });
    if (!user) {
      return res.status(401).json({
        success: false,
        error: 'Invalid credentials'
      });
    }

    // Check password
    const isValidPassword = await bcrypt.compare(password, user.password);
    if (!isValidPassword) {
      return res.status(401).json({
        success: false,
        error: 'Invalid credentials'
      });
    }

    // Update login tracking
    user.lastLogin = new Date();
    user.loginCount = (user.loginCount || 0) + 1;
    user.lastActivity = new Date();
    await user.save();

    // Log successful login
    logger.info(`User login: ${email} (${user.role})`);

    // Generate JWT token with permissions
    const token = jwt.sign(
      {
        userId: user._id,
        email: user.email,
        role: user.role,
        permissions: user.permissions
      },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRE || '7d' }
    );

    res.json({
      success: true,
      data: {
        user: {
          id: user._id,
          name: user.name,
          email: user.email,
          role: user.role,
          permissions: user.permissions,
          department: user.department,
          jobTitle: user.jobTitle,
          lastLogin: user.lastLogin,
          loginCount: user.loginCount
        },
        token
      },
      message: 'Login successful'
    });

  } catch (error) {
    logger.error('Login error:', error);
    res.status(500).json({
      success: false,
      error: 'Login failed',
      message: error.message
    });
  }
});

/**
 * GET /api/auth/me
 * Get current user profile
 */
router.get('/me', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');

    if (!token) {
      return res.status(401).json({
        success: false,
        error: 'No token provided'
      });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.userId).select('-password');

    if (!user || !user.isActive) {
      return res.status(401).json({
        success: false,
        error: 'User not found or inactive'
      });
    }

    // Update last activity
    user.lastActivity = new Date();
    await user.save();

    res.json({
      success: true,
      data: {
        user: {
          id: user._id,
          name: user.name,
          email: user.email,
          role: user.role,
          permissions: user.permissions,
          department: user.department,
          jobTitle: user.jobTitle,
          lastLogin: user.lastLogin,
          lastActivity: user.lastActivity,
          loginCount: user.loginCount,
          createdAt: user.createdAt
        }
      }
    });

  } catch (error) {
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({
        success: false,
        error: 'Invalid token'
      });
    }

    res.status(500).json({
      success: false,
      error: 'Failed to get user profile',
      message: error.message
    });
  }
});

/**
 * GET /api/auth/users
 * Get all users (Admin only)
 */
router.get('/users', authenticate, requirePermission('canManageUsers'), async (req, res) => {
  try {
    const requestingUser = req.user;

    const { page = 1, limit = 20, role, active, search } = req.query;
    const query = {};

    // Filter by role
    if (role && ['admin', 'operator'].includes(role)) {
      query.role = role;
    }

    // Filter by active status
    if (active !== undefined) {
      query.isActive = active === 'true';
    }

    // Search by name or email
    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } }
      ];
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [users, totalCount] = await Promise.all([
      User.find(query)
        .select('-password')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit)),
      User.countDocuments(query)
    ]);

    res.json({
      success: true,
      data: {
        users,
        pagination: {
          currentPage: parseInt(page),
          totalPages: Math.ceil(totalCount / parseInt(limit)),
          totalUsers: totalCount,
          hasNextPage: skip + users.length < totalCount,
          hasPrevPage: parseInt(page) > 1
        }
      }
    });

  } catch (error) {
    logger.error('Error fetching users:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch users',
      message: error.message
    });
  }
});

/**
 * PUT /api/auth/users/:id
 * Update user (Admin only)
 */
router.put('/users/:id', authenticate, requirePermission('canManageUsers'), async (req, res) => {
  try {
    const requestingUser = req.user;
    const targetUserId = req.params.id;

    const allowedUpdates = ['name', 'role', 'isActive', 'department', 'jobTitle'];
    const updates = {};

    // Extract allowed fields
    Object.keys(req.body).forEach(key => {
      if (allowedUpdates.includes(key)) {
        updates[key] = req.body[key];
      }
    });

    // Validate role
    if (updates.role && !['admin', 'operator'].includes(updates.role)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid role specified'
      });
    }

    // Add modification tracking
    updates.modifiedBy = requestingUser._id;

    const updatedUser = await User.findByIdAndUpdate(
      targetUserId,
      updates,
      { new: true, runValidators: true }
    ).select('-password');

    if (!updatedUser) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }

    logger.info(`User updated by ${requestingUser.email}: ${updatedUser.email} (${updatedUser.role})`);

    res.json({
      success: true,
      data: { user: updatedUser },
      message: 'User updated successfully'
    });

  } catch (error) {
    logger.error('Error updating user:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update user',
      message: error.message
    });
  }
});

/**
 * DELETE /api/auth/users/:id
 * Deactivate user (Admin only)
 */
router.delete('/users/:id', authenticate, requirePermission('canManageUsers'), async (req, res) => {
  try {
    const requestingUser = req.user;
    const targetUserId = req.params.id;

    // Prevent self-deactivation
    if (requestingUser._id.toString() === targetUserId) {
      return res.status(400).json({
        success: false,
        error: 'Cannot deactivate your own account'
      });
    }

    const targetUser = await User.findById(targetUserId);
    if (!targetUser) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }

    // Deactivate instead of delete to preserve job history
    targetUser.isActive = false;
    targetUser.modifiedBy = requestingUser._id;
    await targetUser.save();

    logger.info(`User deactivated by ${requestingUser.email}: ${targetUser.email}`);

    res.json({
      success: true,
      message: 'User deactivated successfully'
    });

  } catch (error) {
    logger.error('Error deactivating user:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to deactivate user',
      message: error.message
    });
  }
});

/**
 * POST /api/auth/change-password
 * Change password
 */
router.post('/change-password', authenticate, async (req, res) => {
  try {
    const user = req.user;
    const { currentPassword, newPassword } = req.body;

    // Validate new password strength
    const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/;
    if (!passwordRegex.test(newPassword)) {
      return res.status(400).json({
        success: false,
        error: 'Password must be at least 8 characters long and contain uppercase, lowercase, number, and special character'
      });
    }

    // Verify current password (unless OAuth user)
    if (user.password && !await bcrypt.compare(currentPassword, user.password)) {
      return res.status(400).json({
        success: false,
        error: 'Current password is incorrect'
      });
    }

    // Hash new password
    const salt = await bcrypt.genSalt(12);
    const hashedPassword = await bcrypt.hash(newPassword, salt);

    user.password = hashedPassword;
    await user.save();

    logger.info(`Password changed for user: ${user.email}`);

    res.json({
      success: true,
      message: 'Password changed successfully'
    });

  } catch (error) {
    logger.error('Error changing password:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to change password',
      message: error.message
    });
  }
});

module.exports = router;
