const express = require('express');
const router = express.Router();
const Project = require('../models/Project');

/**
 * GET /api/projects
 * Get all projects with filtering and pagination
 */
router.get('/', async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      status,
      search,
      sort = '-lastUpdated'
    } = req.query;

    const filter = {};

    if (status) {
      filter.status = status;
    }

    if (search) {
      filter.$or = [
        { projectId: { $regex: search, $options: 'i' } },
        { title: { $regex: search, $options: 'i' } },
        { planningAuthority: { $regex: search, $options: 'i' } },
        { location: { $regex: search, $options: 'i' } }
      ];
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [projects, total] = await Promise.all([
      Project.find(filter)
        .populate('fiRequests', 'reportType status createdAt')
        .sort(sort)
        .skip(skip)
        .limit(parseInt(limit)),
      Project.countDocuments(filter)
    ]);

    res.json({
      success: true,
      data: projects,
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
      error: 'Failed to retrieve projects',
      message: error.message
    });
  }
});

/**
 * GET /api/projects/:id
 * Get specific project with full details
 */
router.get('/:id', async (req, res) => {
  try {
    const project = await Project.findById(req.params.id)
      .populate('fiRequests');

    if (!project) {
      return res.status(404).json({
        success: false,
        error: 'Project not found'
      });
    }

    res.json({
      success: true,
      data: project
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve project',
      message: error.message
    });
  }
});

module.exports = router;
