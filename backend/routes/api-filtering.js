const express = require('express');
const router = express.Router();

// Clear cache for development
delete require.cache[require.resolve('../services/buildingInfoService')];
delete require.cache[require.resolve('../services/dropdownDataService')];
delete require.cache[require.resolve('../services/fiDetectionService')];

const buildingInfoService = require('../services/buildingInfoService');
const dropdownDataService = require('../services/dropdownDataService');
const fiDetectionService = require('../services/fiDetectionService');
const winston = require('winston');

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console()
  ]
});

/**
 * GET /api/api-filtering/dropdown-data
 * Get all dropdown options for API filtering
 */
router.get('/dropdown-data', async (req, res) => {
  try {
    // Force reload the service to pick up changes
    delete require.cache[require.resolve('../services/dropdownDataService')];
    const dropdownDataService = require('../services/dropdownDataService');

    const dropdownData = dropdownDataService.getAllDropdownData();

    res.json({
      success: true,
      data: dropdownData
    });

  } catch (error) {
    logger.error('Error getting dropdown data:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get dropdown data',
      message: error.message
    });
  }
});

/**
 * GET /api/api-filtering/subcategories/:categoryId
 * Get subcategories for a specific category
 */
router.get('/subcategories/:categoryId', async (req, res) => {
  try {
    const categoryId = parseInt(req.params.categoryId);
    const subcategories = dropdownDataService.getSubCategories(categoryId);

    res.json({
      success: true,
      data: subcategories
    });

  } catch (error) {
    logger.error('Error getting subcategories:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get subcategories',
      message: error.message
    });
  }
});

/**
 * POST /api/api-filtering/validate-params
 * Validate filter parameters
 */
router.post('/validate-params', async (req, res) => {
  try {
    const params = req.body;
    const validation = dropdownDataService.validateParams(params);

    if (validation.valid) {
      const summary = dropdownDataService.buildFilterSummary(params);
      res.json({
        success: true,
        valid: true,
        errors: [],
        warnings: validation.warnings || [],
        summary: summary
      });
    } else {
      res.json({
        success: true,
        valid: false,
        errors: validation.errors,
        warnings: validation.warnings || []
      });
    }

  } catch (error) {
    logger.error('Error validating parameters:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to validate parameters',
      message: error.message
    });
  }
});

/**
 * POST /api/api-filtering/preview-projects
 * Preview how many projects match the filters (without processing documents)
 */
router.post('/preview-projects', async (req, res) => {
  try {
    const { apiParams = {} } = req.body;

    // Debug logging - let's see what we're receiving
    logger.info('🔍 Frontend sent preview-projects request body:', JSON.stringify(req.body, null, 2));
    logger.info('🔍 Extracted apiParams:', JSON.stringify(apiParams, null, 2));

    // Validate parameters
    const validation = dropdownDataService.validateParams(apiParams);
    if (!validation.valid) {
      return res.status(400).json({
        success: false,
        error: 'Invalid filter parameters',
        details: validation.errors
      });
    }

    // Get project count from API
    logger.info('Getting project preview with filters:', apiParams);
    const result = await buildingInfoService.getProjectsByParams(apiParams);

    const summary = dropdownDataService.buildFilterSummary(apiParams);

    res.json({
      success: true,
      data: {
        projects: result.projectData.slice(0, 10).map(project => ({
          projectId: project.planning_id,
          title: project.planning_title,
          category: project.planning_category || 'Unknown',
          subcategory: project.planning_subcategory || 'Unknown',
          county: project.planning_county || 'Unknown',
          stage: project.planning_stage || 'Unknown',
          type: project.planning_type || 'Unknown',
          planningAuthority: project.planning_authority || 'Unknown'
        })),
        totalCount: result.totalCount,
        limit: 10,
        offset: 0,
        filters: apiParams
      }
    });

  } catch (error) {
    logger.error('Error previewing projects:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to preview projects',
      message: error.message
    });
  }
});

/**
 * POST /api/api-filtering/process-fi-with-filters
 * Process FI detection with API-based project filtering
 */
router.post('/process-fi-with-filters', async (req, res) => {
  try {
    // Debug logging - let's see the entire request body
    logger.info('🔍 Process FI request body received:', JSON.stringify(req.body, null, 2));

    const {
      reportTypes = [],
      filters = {}, // Changed from apiParams to filters to match frontend
      customers = [],
      scheduleTime = null
    } = req.body;

    // More detailed logging
    logger.info('🔍 Extracted parameters:');
    logger.info('  - reportTypes:', reportTypes);
    logger.info('  - filters:', JSON.stringify(filters, null, 2));
    logger.info('  - customers:', customers.length);
    logger.info('  - scheduleTime:', scheduleTime);

    // Use filters as apiParams for the FI detection service
    const apiParams = filters;

    // Validate inputs
    if (!reportTypes || reportTypes.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'At least one report type is required'
      });
    }

    // Validate API parameters
    if (Object.keys(apiParams).length > 0) {
      logger.info('🔍 Validating apiParams with dropdownDataService:', JSON.stringify(apiParams, null, 2));
      const validation = dropdownDataService.validateParams(apiParams);
      logger.info('🔍 Validation result:', JSON.stringify(validation, null, 2));

      if (!validation.valid) {
        logger.error('❌ API parameter validation failed:', validation.errors);
        return res.status(400).json({
          success: false,
          error: 'Invalid API filter parameters',
          details: validation.errors
        });
      }
    }

    // Validate customer data
    const customerData = customers.map(customer => ({
      email: customer.email || customer,
      name: customer.name || customer.email?.split('@')[0] || customer
    }));

    if (scheduleTime) {
      // Schedule the job for later processing
      const jobSchedulerService = require('../services/jobSchedulerService');

      const jobId = await jobSchedulerService.scheduleFilteredFIDetection({
        reportTypes,
        apiParams,
        customerData,
        scheduleTime
      });

      res.json({
        success: true,
        scheduled: true,
        jobId: jobId,
        scheduleTime: scheduleTime,
        message: 'FI detection job scheduled successfully'
      });

    } else {
      // Process immediately
      logger.info('Starting immediate FI detection with API filtering');
      logger.info('Report types:', reportTypes);
      logger.info('API params:', apiParams);
      logger.info('Customer count:', customerData.length);

      const result = await fiDetectionService.processFIRequestWithFiltering(
        reportTypes,
        apiParams,
        customerData
      );

      if (result.success && result.results.length > 0) {
        // Send emails if customers provided
        if (customerData.length > 0 && result.customerMatches.length > 0) {
          const emailService = require('../services/emailService');

          for (const customerMatch of result.customerMatches) {
            if (customerMatch.matches.length > 0) {
              await emailService.sendBatchFINotification(
                customerMatch.email,
                customerMatch.name,
                {
                  matches: customerMatch.matches,
                  reportTypes: reportTypes
                }
              );

              logger.info(`Email sent to ${customerMatch.email} with ${customerMatch.matches.length} matches`);
            }
          }
        }
      }

      res.json({
        success: result.success,
        data: {
          totalMatches: result.results?.length || 0,
          customerMatches: result.customerMatches || [],
          processingStats: result.processingStats,
          apiFilter: result.apiFilter,
          cacheStats: result.cacheStats
        },
        message: result.message || `Found ${result.results?.length || 0} FI matches`
      });
    }

  } catch (error) {
    logger.error('Error processing FI with filters:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to process FI detection with filters',
      message: error.message
    });
  }
});

/**
 * GET /api/api-filtering/cache-stats
 * Get cache statistics for monitoring
 */
router.get('/cache-stats', async (req, res) => {
  try {
    const fiCacheStats = fiDetectionService.getCacheStats();
    const buildingInfoCacheStats = buildingInfoService.getCacheStats();

    res.json({
      success: true,
      data: {
        fiDetection: fiCacheStats,
        buildingInfo: buildingInfoCacheStats
      }
    });

  } catch (error) {
    logger.error('Error getting cache stats:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get cache statistics',
      message: error.message
    });
  }
});

/**
 * POST /api/api-filtering/check-filter-impact
 * Check how many documents would be processed with given filters (diagnostic)
 */
router.post('/check-filter-impact', async (req, res) => {
  try {
    const { apiParams = {} } = req.body;

    logger.info('🔍 Checking filter impact with params:', apiParams);

    // Get filtered project IDs
    let filteredProjectIds = [];
    if (Object.keys(apiParams).length > 0) {
      const apiResult = await buildingInfoService.getProjectsByParams(apiParams);
      filteredProjectIds = apiResult.projectIds;
    } else {
      const s3Service = require('../services/s3Service');
      const planningDocsProjects = await s3Service.listPlanningDocsProjects();
      filteredProjectIds = planningDocsProjects.map(p => p.projectId);
    }

    // Get document count for these projects
    const s3Service = require('../services/s3Service');
    const documents = await s3Service.listFilteredProjectDocuments(filteredProjectIds.slice(0, 50)); // Limit to first 50 projects for analysis

    // Group by project to show distribution
    const docsByProject = {};
    documents.forEach(doc => {
      docsByProject[doc.projectId] = (docsByProject[doc.projectId] || 0) + 1;
    });

    const projectStats = Object.entries(docsByProject)
      .map(([projectId, docCount]) => ({ projectId, docCount }))
      .sort((a, b) => b.docCount - a.docCount);

    const estimatedProcessingMinutes = Math.ceil((documents.length * 3 * 15) / 60); // Assume 3 report types, 15 sec per doc

    res.json({
      success: true,
      data: {
        appliedFilters: apiParams,
        totalFilteredProjects: filteredProjectIds.length,
        totalDocuments: documents.length,
        analyzedProjects: Math.min(50, filteredProjectIds.length),
        averageDocsPerProject: Math.round(documents.length / Math.min(50, filteredProjectIds.length)),
        estimatedProcessingTime: `${estimatedProcessingMinutes} minutes`,
        topProjectsByDocCount: projectStats.slice(0, 10),
        projectsWithMostDocs: projectStats.filter(p => p.docCount > 20).length
      }
    });

  } catch (error) {
    logger.error('Error checking filter impact:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to check filter impact',
      message: error.message
    });
  }
});

module.exports = router;