const jwt = require('jsonwebtoken');
const User = require('../models/User');
const logger = require('../utils/logger');

/**
 * Authentication middleware
 */
const authenticate = async (req, res, next) => {
  try {
    const token = req.header('Authorization')?.replace('Bearer ', '');

    if (!token) {
      return res.status(401).json({
        success: false,
        error: 'Access denied. No token provided.'
      });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.userId).select('-password');

    if (!user || !user.isActive) {
      return res.status(401).json({
        success: false,
        error: 'Invalid token. User not found or inactive.'
      });
    }

    // Domain validation
    if (!user.email.endsWith('@buildinginfo.com')) {
      return res.status(403).json({
        success: false,
        error: 'Domain access restriction'
      });
    }

    // Update last activity
    user.lastActivity = new Date();
    await user.save();

    req.user = user;
    next();
  } catch (error) {
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({
        success: false,
        error: 'Invalid token format'
      });
    }

    logger.error('Authentication error:', error);
    res.status(401).json({
      success: false,
      error: 'Authentication failed'
    });
  }
};

/**
 * Admin role authorization middleware
 */
const requireAdmin = (req, res, next) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({
      success: false,
      error: 'Access denied. Admin role required.'
    });
  }
  next();
};

/**
 * Permission-based authorization middleware
 */
const requirePermission = (permission) => {
  return (req, res, next) => {
    if (!req.user.hasPermission(permission)) {
      return res.status(403).json({
        success: false,
        error: `Access denied. ${permission} permission required.`
      });
    }
    next();
  };
};

/**
 * Optional authentication middleware
 * Adds user to request if token is valid, but doesn't require authentication
 */
const optionalAuth = async (req, res, next) => {
  try {
    const token = req.header('Authorization')?.replace('Bearer ', '');

    if (token) {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const user = await User.findById(decoded.userId).select('-password');

      if (user && user.isActive && user.email.endsWith('@buildinginfo.com')) {
        user.lastActivity = new Date();
        await user.save();
        req.user = user;
      }
    }

    next();
  } catch (error) {
    // Continue without authentication
    next();
  }
};

/**
 * Admin or owner authorization (user can access their own data)
 */
const requireAdminOrOwner = (req, res, next) => {
  const targetUserId = req.params.userId || req.params.id;

  if (req.user.role === 'admin' || req.user._id.toString() === targetUserId) {
    return next();
  }

  return res.status(403).json({
    success: false,
    error: 'Access denied. Admin role or resource ownership required.'
  });
};

module.exports = {
  authenticate,
  requireAdmin,
  requirePermission,
  requireAdminOrOwner,
  optionalAuth
};
