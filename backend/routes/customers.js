const express = require('express');
const router = express.Router();
const Customer = require('../models/Customer');
const emailService = require('../services/emailService');
const Joi = require('joi');

// Validation schemas
const customerSchema = Joi.object({
  name: Joi.string().required().trim().min(2).max(100),
  email: Joi.string().email().required().lowercase().trim(),
  company: Joi.string().trim().max(200),
  phone: Joi.string().trim().max(20),
  reportTypes: Joi.array().items(
    Joi.string().valid('acoustic', 'transport', 'ecological', 'flood', 'heritage', 'arboricultural', 'waste', 'lighting')
  ).min(1).required(),
  emailPreferences: Joi.object({
    instantNotification: Joi.boolean(),
    dailyDigest: Joi.boolean(),
    weeklyDigest: Joi.boolean()
  })
});

const updateCustomerSchema = Joi.object({
  name: Joi.string().trim().min(2).max(100),
  company: Joi.string().trim().max(200),
  phone: Joi.string().trim().max(20),
  reportTypes: Joi.array().items(
    Joi.string().valid('acoustic', 'transport', 'ecological', 'flood', 'heritage', 'arboricultural', 'waste', 'lighting')
  ).min(1),
  isActive: Joi.boolean(),
  emailPreferences: Joi.object({
    instantNotification: Joi.boolean(),
    dailyDigest: Joi.boolean(),
    weeklyDigest: Joi.boolean()
  })
});

/**
 * GET /api/customers
 * Get all customers with filtering and pagination
 */
router.get('/', async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      reportType,
      isActive,
      search,
      sort = '-createdAt'
    } = req.query;

    const filter = {};

    if (reportType) {
      filter.reportTypes = { $in: [reportType] };
    }

    if (isActive !== undefined) {
      filter.isActive = isActive === 'true';
    }

    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
        { company: { $regex: search, $options: 'i' } }
      ];
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [customers, total] = await Promise.all([
      Customer.find(filter)
        .sort(sort)
        .skip(skip)
        .limit(parseInt(limit)),
      Customer.countDocuments(filter)
    ]);

    res.json({
      success: true,
      data: customers,
      pagination: {
        total,
        pages: Math.ceil(total / parseInt(limit)),
        current: parseInt(page),
        limit: parseInt(limit)
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve customers',
      message: error.message
    });
  }
});

/**
 * GET /api/customers/statistics
 * Get customer statistics
 */
router.get('/statistics', async (req, res) => {
  try {
    const totalCustomers = await Customer.countDocuments();
    const activeCustomers = await Customer.countDocuments({ isActive: true });

    // Get customers by report type
    const reportTypeStats = await Customer.aggregate([
      { $unwind: '$reportTypes' },
      { $group: { _id: '$reportTypes', count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]);

    // Get email preferences stats
    const emailPrefsStats = await Customer.aggregate([
      {
        $group: {
          _id: null,
          instantNotification: { $sum: { $cond: ['$emailPreferences.instantNotification', 1, 0] } },
          dailyDigest: { $sum: { $cond: ['$emailPreferences.dailyDigest', 1, 0] } },
          weeklyDigest: { $sum: { $cond: ['$emailPreferences.weeklyDigest', 1, 0] } }
        }
      }
    ]);

    res.json({
      success: true,
      data: {
        total: totalCustomers,
        active: activeCustomers,
        inactive: totalCustomers - activeCustomers,
        byReportType: reportTypeStats,
        emailPreferences: emailPrefsStats[0] || {
          instantNotification: 0,
          dailyDigest: 0,
          weeklyDigest: 0
        }
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve statistics',
      message: error.message
    });
  }
});

/**
 * GET /api/customers/:id
 * Get specific customer
 */
router.get('/:id', async (req, res) => {
  try {
    const customer = await Customer.findById(req.params.id);

    if (!customer) {
      return res.status(404).json({
        success: false,
        error: 'Customer not found'
      });
    }

    res.json({
      success: true,
      data: customer
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve customer',
      message: error.message
    });
  }
});

/**
 * POST /api/customers
 * Create new customer
 */
router.post('/', async (req, res) => {
  try {
    // Validate request body
    const { error, value } = customerSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        error: 'Validation error',
        details: error.details.map(d => d.message)
      });
    }

    // Check if customer with email already exists
    const existingCustomer = await Customer.findOne({ email: value.email });
    if (existingCustomer) {
      return res.status(409).json({
        success: false,
        error: 'Customer with this email already exists'
      });
    }

    // Create new customer
    const customer = new Customer(value);
    await customer.save();

    // Send welcome email
    try {
      await emailService.sendWelcomeEmail(
        customer.email,
        customer.name,
        customer.reportTypes
      );
    } catch (emailError) {
      console.warn('Failed to send welcome email:', emailError.message);
      // Don't fail customer creation if email fails
    }

    res.status(201).json({
      success: true,
      data: customer,
      message: 'Customer created successfully'
    });

  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({
        success: false,
        error: 'Customer with this email already exists'
      });
    }

    res.status(500).json({
      success: false,
      error: 'Failed to create customer',
      message: error.message
    });
  }
});

/**
 * PUT /api/customers/:id
 * Update customer
 */
router.put('/:id', async (req, res) => {
  try {
    // Validate request body
    const { error, value } = updateCustomerSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        error: 'Validation error',
        details: error.details.map(d => d.message)
      });
    }

    const customer = await Customer.findByIdAndUpdate(
      req.params.id,
      value,
      { new: true, runValidators: true }
    );

    if (!customer) {
      return res.status(404).json({
        success: false,
        error: 'Customer not found'
      });
    }

    res.json({
      success: true,
      data: customer,
      message: 'Customer updated successfully'
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to update customer',
      message: error.message
    });
  }
});

/**
 * DELETE /api/customers/:id
 * Delete customer
 */
router.delete('/:id', async (req, res) => {
  try {
    const customer = await Customer.findByIdAndDelete(req.params.id);

    if (!customer) {
      return res.status(404).json({
        success: false,
        error: 'Customer not found'
      });
    }

    res.json({
      success: true,
      message: 'Customer deleted successfully'
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to delete customer',
      message: error.message
    });
  }
});

/**
 * POST /api/customers/:id/toggle-status
 * Toggle customer active status
 */
router.post('/:id/toggle-status', async (req, res) => {
  try {
    const customer = await Customer.findById(req.params.id);

    if (!customer) {
      return res.status(404).json({
        success: false,
        error: 'Customer not found'
      });
    }

    customer.isActive = !customer.isActive;
    await customer.save();

    res.json({
      success: true,
      data: customer,
      message: `Customer ${customer.isActive ? 'activated' : 'deactivated'} successfully`
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to toggle customer status',
      message: error.message
    });
  }
});

/**
 * GET /api/customers/by-report-type/:reportType
 * Get customers subscribed to a specific report type
 */
router.get('/by-report-type/:reportType', async (req, res) => {
  try {
    const { reportType } = req.params;
    const { isActive = true } = req.query;

    const validReportTypes = ['acoustic', 'transport', 'ecological', 'flood', 'heritage', 'arboricultural', 'waste', 'lighting'];

    if (!validReportTypes.includes(reportType)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid report type'
      });
    }

    const filter = {
      reportTypes: { $in: [reportType] }
    };

    if (isActive !== undefined) {
      filter.isActive = isActive === 'true';
    }

    const customers = await Customer.find(filter)
      .select('name email company reportTypes isActive emailPreferences')
      .sort('name');

    res.json({
      success: true,
      data: customers,
      count: customers.length
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve customers',
      message: error.message
    });
  }
});

/**
 * GET /api/customers/:id/fi-history
 * Get FI report history for a specific customer
 */
router.get('/:id/fi-history', async (req, res) => {
  try {
    const customer = await Customer.findById(req.params.id);

    if (!customer) {
      return res.status(404).json({
        success: false,
        error: 'Customer not found'
      });
    }

    const FIRequest = require('../models/FIRequest');

    // Get all FI requests where this customer received notifications
    const fiHistory = await FIRequest.find({
      'notificationsSent.customerEmail': customer.email
    })
    .populate('project', 'title projectId planningAuthority location')
    .sort({ createdAt: -1 })
    .limit(50); // Limit to last 50 reports

    // Transform the data to include only relevant notification details
    const history = fiHistory.map(fiRequest => {
      const customerNotifications = fiRequest.notificationsSent.filter(
        notification => notification.customerEmail === customer.email
      );

      return {
        _id: fiRequest._id,
        projectId: fiRequest.projectId,
        project: fiRequest.project,
        reportType: fiRequest.reportType,
        fileName: fiRequest.fileName,
        status: fiRequest.status,
        confidence: fiRequest.confidence,
        requestDate: fiRequest.requestDate,
        deadline: fiRequest.deadline,
        createdAt: fiRequest.createdAt,
        notifications: customerNotifications
      };
    });

    res.json({
      success: true,
      data: {
        customer: {
          _id: customer._id,
          name: customer.name,
          email: customer.email,
          company: customer.company,
          reportTypes: customer.reportTypes,
          emailCount: customer.emailCount,
          lastEmailSent: customer.lastEmailSent
        },
        fiHistory: history,
        totalReports: history.length
      }
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve customer FI history',
      message: error.message
    });
  }
});

/**
 * GET /api/customers/quick-select
 * Get customers for quick email selection (active customers with recent activity)
 */
router.get('/quick-select', async (req, res) => {
  try {
    const { reportType } = req.query;

    let filter = { isActive: true };

    // If report type specified, filter by that
    if (reportType) {
      filter.reportTypes = { $in: [reportType] };
    }

    const customers = await Customer.find(filter)
      .select('name email company reportTypes emailCount lastEmailSent')
      .sort({ lastEmailSent: -1, emailCount: -1 }) // Recent activity first
      .limit(20); // Limit to top 20 most relevant customers

    res.json({
      success: true,
      data: customers,
      count: customers.length
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve customers for quick select',
      message: error.message
    });
  }
});

/**
 * GET /api/customers/email-suggestions
 * Get email suggestions based on query for autocomplete
 */
router.get('/email-suggestions', async (req, res) => {
  try {
    const { q: query, reportType } = req.query;

    if (!query || query.length < 2) {
      return res.json({
        success: true,
        data: [],
        count: 0
      });
    }

    let filter = {
      isActive: true,
      $or: [
        { email: { $regex: query, $options: 'i' } },
        { name: { $regex: query, $options: 'i' } },
        { company: { $regex: query, $options: 'i' } }
      ]
    };

    if (reportType) {
      filter.reportTypes = { $in: [reportType] };
    }

    const customers = await Customer.find(filter)
      .select('name email company reportTypes emailCount lastEmailSent')
      .sort({ emailCount: -1, lastEmailSent: -1 })
      .limit(10);

    const suggestions = customers.map(customer => ({
      email: customer.email,
      name: customer.name,
      company: customer.company,
      displayText: customer.company
        ? `${customer.name} (${customer.company}) - ${customer.email}`
        : `${customer.name} - ${customer.email}`,
      reportTypes: customer.reportTypes,
      emailCount: customer.emailCount
    }));

    res.json({
      success: true,
      data: suggestions,
      count: suggestions.length
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to get email suggestions',
      message: error.message
    });
  }
});

module.exports = router;
