const express = require('express');
const router = express.Router();
const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const s3Service = require('../services/s3Service');
const buildingInfoService = require('../services/buildingInfoService');
const Customer = require('../models/Customer');
const Project = require('../models/Project');
const emailService = require('../services/emailService');

// Simple console logger to avoid winston issues
const logger = {
  info: (message, meta) => console.log('[INFO]', message, meta || ''),
  error: (message, error) => console.error('[ERROR]', message, error || ''),
  warn: (message, meta) => console.warn('[WARN]', message, meta || '')
};

/**
 * GET /api/documents/local/drives
 * Get available drives (Windows) or root directories (Unix)
 */
router.get('/local/drives', async (req, res) => {
  try {
    const drives = [];

    if (os.platform() === 'win32') {
      // Windows: Get available drives
      for (let i = 65; i <= 90; i++) {
        const drive = String.fromCharCode(i) + ':';
        try {
          await fs.access(drive + '\\');
          drives.push({
            name: drive,
            path: drive + '\\',
            type: 'drive'
          });
        } catch (error) {
          // Drive not available
        }
      }
    } else {
      // Unix/Linux/macOS: Common root directories
      const commonDirs = ['/', '/home', '/Users', '/Documents', '/Desktop'];
      for (const dir of commonDirs) {
        try {
          await fs.access(dir);
          drives.push({
            name: dir,
            path: dir,
            type: 'directory'
          });
        } catch (error) {
          // Directory not available
        }
      }
    }

    // Add user home directory
    const homeDir = os.homedir();
    drives.push({
      name: 'Home',
      path: homeDir,
      type: 'home'
    });

    res.json({
      success: true,
      data: {
        drives,
        platform: os.platform(),
        homeDir
      }
    });

  } catch (error) {
    logger.error('Error getting drives:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get drives',
      message: error.message
    });
  }
});

/**
 * GET /api/documents/local/browse
 * Browse local filesystem
 */
router.get('/local/browse', async (req, res) => {
  try {
    const { path: browsePath = os.homedir() } = req.query;

    // Security check: ensure path is absolute and exists
    const absolutePath = path.resolve(browsePath);

    try {
      await fs.access(absolutePath);
    } catch (error) {
      return res.status(404).json({
        success: false,
        error: 'Path not found or not accessible'
      });
    }

    const items = [];
    const entries = await fs.readdir(absolutePath, { withFileTypes: true });

    // Add parent directory option (except for root)
    const parentDir = path.dirname(absolutePath);
    if (parentDir !== absolutePath) {
      items.push({
        name: '..',
        path: parentDir,
        type: 'parent',
        isDirectory: true
      });
    }

    for (const entry of entries) {
      const fullPath = path.join(absolutePath, entry.name);

      try {
        const stats = await fs.stat(fullPath);

        if (entry.isDirectory()) {
          // Check if directory contains PDF files
          let pdfCount = 0;
          try {
            const subEntries = await fs.readdir(fullPath);
            pdfCount = subEntries.filter(file =>
              file.toLowerCase().endsWith('.pdf')
            ).length;
          } catch (error) {
            // Permission denied or other error
          }

          items.push({
            name: entry.name,
            path: fullPath,
            type: 'directory',
            isDirectory: true,
            pdfCount,
            size: stats.size,
            modified: stats.mtime
          });
        } else if (entry.name.toLowerCase().endsWith('.pdf')) {
          items.push({
            name: entry.name,
            path: fullPath,
            type: 'pdf',
            isDirectory: false,
            size: stats.size,
            modified: stats.mtime
          });
        }
      } catch (error) {
        // Skip files/directories that can't be accessed
        continue;
      }
    }

    // Sort: directories first, then PDFs, alphabetically
    items.sort((a, b) => {
      if (a.type === 'parent') return -1;
      if (b.type === 'parent') return 1;
      if (a.isDirectory && !b.isDirectory) return -1;
      if (!a.isDirectory && b.isDirectory) return 1;
      return a.name.localeCompare(b.name);
    });

    res.json({
      success: true,
      data: {
        currentPath: absolutePath,
        items,
        totalItems: items.length,
        pdfFiles: items.filter(item => item.type === 'pdf').length,
        directories: items.filter(item => item.isDirectory && item.type !== 'parent').length
      }
    });

  } catch (error) {
    logger.error('Error browsing local filesystem:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to browse directory',
      message: error.message
    });
  }
});

/**
 * POST /api/documents-browser/local/scan-projects
 * Scan local directories for project folders (supports downloads_XXXXX or XXXXX naming - fast loading)
 */
router.post('/local/scan-projects', async (req, res) => {
  try {
    const { rootPath } = req.body;

    if (!rootPath) {
      return res.status(400).json({
        success: false,
        error: 'Root path is required'
      });
    }

    const absolutePath = path.resolve(rootPath);

    try {
      await fs.access(absolutePath);
    } catch (error) {
      return res.status(404).json({
        success: false,
        error: 'Root path not found or not accessible'
      });
    }

    const projects = [];
    const entries = await fs.readdir(absolutePath, { withFileTypes: true });

    // First, check if this folder itself contains PDF files
    const folderName = path.basename(absolutePath);

    try {
      const projectFiles = await fs.readdir(absolutePath);
      const pdfFiles = projectFiles.filter(file =>
        file.toLowerCase().endsWith('.pdf')
      );

      if (pdfFiles.length > 0) {
        // Check if it's a numbered project folder, otherwise use folder name
        const numberedMatch = folderName.match(/^(?:downloads_)?(\d+)$/);
        const projectId = numberedMatch ? numberedMatch[1] : folderName;

        projects.push({
          projectId,
          folderName: folderName,
          path: absolutePath,
          pdfCount: pdfFiles.length,
          pdfFiles: pdfFiles.slice(0, 10), // First 10 files for preview
          sampleDocuments: pdfFiles.slice(0, 3), // First 3 for display
          // Fast loading - no metadata calls until FI processing finds matches
          displayName: numberedMatch ? `Project ${projectId}` : `Folder: ${folderName}`,
          hasMetadata: false
        });
      }
    } catch (error) {
      logger.warn(`Error scanning current folder ${folderName}:`, error.message);
    }

    // Then, scan subfolders for any folders containing PDFs
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const subfolderPath = path.join(absolutePath, entry.name);

        try {
          // Count PDF files in the subdirectory
          const subfolderFiles = await fs.readdir(subfolderPath);
          const pdfFiles = subfolderFiles.filter(file =>
            file.toLowerCase().endsWith('.pdf')
          );

          if (pdfFiles.length > 0) {
            // Check if it's a numbered project folder, otherwise use folder name
            const numberedMatch = entry.name.match(/^(?:downloads_)?(\d+)$/);
            const projectId = numberedMatch ? numberedMatch[1] : entry.name;

            projects.push({
              projectId,
              folderName: entry.name,
              path: subfolderPath,
              pdfCount: pdfFiles.length,
              pdfFiles: pdfFiles.slice(0, 10), // First 10 files for preview
              sampleDocuments: pdfFiles.slice(0, 3), // First 3 for display
              // No metadata - will be fetched only when FI processing finds matches
              displayName: numberedMatch ? `Project ${projectId}` : `Folder: ${entry.name}`,
              hasMetadata: false
            });
          }
        } catch (error) {
          logger.warn(`Error scanning subfolder ${entry.name}:`, error.message);
        }
      }
    }

    // Sort by project ID
    projects.sort((a, b) => a.projectId.localeCompare(b.projectId));

    // Determine folder type based on the current folder having PDFs
    const currentFolderHasPDFs = projects.some(p => p.path === absolutePath);

    res.json({
      success: true,
      data: {
        rootPath: absolutePath,
        projects,
        totalProjects: projects.length,
        totalDocuments: projects.reduce((sum, p) => sum + p.pdfCount, 0),
        folderType: currentFolderHasPDFs ? 'individual_project' : 'parent_folder'
      }
    });

  } catch (error) {
    logger.error('Error scanning for projects:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to scan for projects',
      message: error.message
    });
  }
});

/**
 * GET /api/documents-browser/aws/folders
 * List main folders in the S3 bucket
 */
router.get('/aws/folders', async (req, res) => {
  try {
    const folders = await s3Service.listMainFolders();

    res.json({
      success: true,
      data: {
        folders: folders,
        total: folders.length
      }
    });

  } catch (error) {
    logger.error('Error listing AWS folders:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to list AWS folders',
      message: error.message
    });
  }
});

/**
 * GET /api/documents-browser/aws/folders/:folderName/projects
 * List projects within a specific folder (fast loading - no metadata calls)
 */
router.get('/aws/folders/:folderName/projects', async (req, res) => {
  try {
    const { folderName } = req.params;
    const { limit = 50, offset = 0 } = req.query;

    const folderPrefix = folderName + '/';
    const allProjects = await s3Service.listProjectsInFolder(folderPrefix);
    const paginatedProjects = allProjects.slice(offset, offset + parseInt(limit));

    // Get document counts only (no metadata calls)
    const projectsWithCounts = [];

    for (const project of paginatedProjects) {
      try {
        // Only get document count and sample files - no Building Info API calls
        const documents = await s3Service.listProjectDocuments(project.projectId);

        projectsWithCounts.push({
          projectId: project.projectId,
          folderPath: project.folderPath,
          parentFolder: project.parentFolder,
          pdfCount: documents.length,
          sampleDocuments: documents.slice(0, 3).map(doc => doc.fileName),
          // No metadata - will be fetched only when FI processing finds matches
          displayName: `Project ${project.projectId}`,
          hasMetadata: false
        });
      } catch (error) {
        logger.warn(`Error getting documents for project ${project.projectId}:`, error.message);
        projectsWithCounts.push({
          projectId: project.projectId,
          folderPath: project.folderPath,
          parentFolder: project.parentFolder,
          pdfCount: 0,
          sampleDocuments: [],
          displayName: `Project ${project.projectId}`,
          hasMetadata: false
        });
      }
    }

    res.json({
      success: true,
      data: {
        folderName,
        projects: projectsWithCounts,
        pagination: {
          total: allProjects.length,
          offset: parseInt(offset),
          limit: parseInt(limit),
          hasMore: offset + parseInt(limit) < allProjects.length
        }
      }
    });

  } catch (error) {
    logger.error(`Error listing projects in folder ${req.params.folderName}:`, error);
    res.status(500).json({
      success: false,
      error: 'Failed to list projects in folder',
      message: error.message
    });
  }
});

/**
 * GET /api/documents-browser/aws/projects
 * List projects available in AWS S3 (all projects across all folders - fast loading)
 */
router.get('/aws/projects', async (req, res) => {
  try {
    const { limit = 50, offset = 0 } = req.query;

    const allProjects = await s3Service.listAllProjects();
    const paginatedProjects = allProjects.slice(offset, offset + parseInt(limit));

    // Get document counts only (no metadata calls for fast loading)
    const projectsWithCounts = [];

    for (const projectId of paginatedProjects) {
      try {
        // Only get document count - no Building Info API calls
        const documents = await s3Service.listProjectDocuments(projectId);

        projectsWithCounts.push({
          projectId,
          pdfCount: documents.length,
          sampleDocuments: documents.slice(0, 3).map(doc => doc.fileName),
          displayName: `Project ${projectId}`,
          hasMetadata: false
        });
      } catch (error) {
        logger.warn(`Error getting documents for project ${projectId}:`, error.message);
        projectsWithCounts.push({
          projectId,
          pdfCount: 0,
          sampleDocuments: [],
          displayName: `Project ${projectId}`,
          hasMetadata: false
        });
      }
    }

    res.json({
      success: true,
      data: {
        projects: projectsWithCounts,
        pagination: {
          total: allProjects.length,
          offset: parseInt(offset),
          limit: parseInt(limit),
          hasMore: offset + parseInt(limit) < allProjects.length
        }
      }
    });

  } catch (error) {
    logger.error('Error listing AWS projects:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to list AWS projects',
      message: error.message
    });
  }
});

/**
 * GET /api/documents/aws/projects/:projectId
 * Get detailed information about a specific AWS project
 */
router.get('/aws/projects/:projectId', async (req, res) => {
  try {
    const { projectId } = req.params;

    // Get documents and metadata in parallel
    const [documents, metadata] = await Promise.all([
      s3Service.listProjectDocuments(projectId),
      buildingInfoService.getProjectMetadata(projectId)
    ]);

    res.json({
      success: true,
      data: {
        projectId,
        metadata,
        documents,
        documentCount: documents.length,
        totalSize: documents.reduce((sum, doc) => sum + doc.size, 0)
      }
    });

  } catch (error) {
    logger.error(`Error getting AWS project ${req.params.projectId}:`, error);
    res.status(500).json({
      success: false,
      error: 'Failed to get project details',
      message: error.message
    });
  }
});

/**
 * GET /api/documents/aws/stats
 * Get AWS S3 bucket statistics
 */
router.get('/aws/stats', async (req, res) => {
  try {
    const stats = await s3Service.getBucketStats();

    res.json({
      success: true,
      data: stats
    });

  } catch (error) {
    logger.error('Error getting AWS stats:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get AWS statistics',
      message: error.message
    });
  }
});

/**
 * POST /api/documents-browser/aws/process-folder
 * Process entire folder(s) for FI detection (handles thousands of projects)
 */
router.post('/aws/process-folder', async (req, res) => {
  try {
    const {
      folderNames,
      reportTypes,
      customerEmails, // Legacy support
      customers,      // New format with names and emails
      scheduleTime = null
    } = req.body;

    // Support both old and new customer data formats
    let customerData = [];
    if (customers && Array.isArray(customers)) {
      // New format: array of {name, email} objects
      customerData = customers;
    } else if (customerEmails && Array.isArray(customerEmails)) {
      // Legacy format: array of email strings
      customerData = customerEmails.map(email => ({
        email,
        name: email.split('@')[0] // Default name from email prefix
      }));
    }

    if (!folderNames || !Array.isArray(folderNames) || folderNames.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Folder names are required'
      });
    }

    if (!reportTypes || !Array.isArray(reportTypes) || reportTypes.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Report types are required'
      });
    }

    logger.info(`Starting FI processing for ${folderNames.length} folders`);

    // Get all projects from all folders
    const allProjectIds = [];
    for (const folderName of folderNames) {
      try {
        const folderPrefix = folderName + '/';
        const projects = await s3Service.listProjectsInFolder(folderPrefix);
        allProjectIds.push(...projects.map(p => p.projectId));
        logger.info(`Found ${projects.length} projects in folder ${folderName}`);
      } catch (error) {
        logger.error(`Error getting projects from folder ${folderName}:`, error);
      }
    }

    logger.info(`Total projects to process: ${allProjectIds.length}`);

    // Process in batches to handle large numbers
    const batchSize = 50; // Process 50 projects at a time
    const processingResults = [];

    for (let i = 0; i < allProjectIds.length; i += batchSize) {
      const batch = allProjectIds.slice(i, i + batchSize);
      logger.info(`Processing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(allProjectIds.length / batchSize)} (${batch.length} projects)`);

      const batchResults = await processBatch(batch, reportTypes, customerData);
      processingResults.push(...batchResults);

      // Small delay between batches to prevent overwhelming the system
      if (i + batchSize < allProjectIds.length) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    const summary = {
      totalFolders: folderNames.length,
      totalProjects: allProjectIds.length,
      processed: processingResults.filter(r => r.status !== 'error').length,
      errors: processingResults.filter(r => r.status === 'error').length,
      matchesFound: processingResults.filter(r => r.status === 'matches_found').length,
      noMatches: processingResults.filter(r => r.status === 'no_matches').length,
      skipped: processingResults.filter(r => r.status === 'skipped').length
    };

    res.json({
      success: true,
      data: {
        summary,
        results: processingResults,
        processedAt: new Date().toISOString()
      }
    });

  } catch (error) {
    logger.error('Error processing folder FI detection:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to process folder FI detection',
      message: error.message
    });
  }
});

/**
 * POST /api/documents-browser/aws/process-fi
 * Process FI detection for selected projects (with Building Info API calls only for matches)
 */
router.post('/aws/process-fi', async (req, res) => {
  try {
    const {
      projectIds,
      reportTypes,
      customerEmails, // Legacy support
      customers,      // New format with names and emails
      scheduleTime = null
    } = req.body;

    // Support both old and new customer data formats
    let customerData = [];
    if (customers && Array.isArray(customers)) {
      // New format: array of {name, email} objects
      customerData = customers;
    } else if (customerEmails && Array.isArray(customerEmails)) {
      // Legacy format: array of email strings
      customerData = customerEmails.map(email => ({
        email,
        name: email.split('@')[0] // Default name from email prefix
      }));
    }

    if (!projectIds || !Array.isArray(projectIds) || projectIds.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Project IDs are required'
      });
    }

    if (!reportTypes || !Array.isArray(reportTypes) || reportTypes.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Report types are required'
      });
    }

    logger.info(`Starting FI processing for ${projectIds.length} projects`);

    // Process projects
    const processingResults = await processBatch(projectIds, reportTypes, customerData);

    const summary = {
      totalProjects: projectIds.length,
      processed: processingResults.filter(r => r.status !== 'error').length,
      errors: processingResults.filter(r => r.status === 'error').length,
      matchesFound: processingResults.filter(r => r.status === 'matches_found').length,
      noMatches: processingResults.filter(r => r.status === 'no_matches').length,
      skipped: processingResults.filter(r => r.status === 'skipped').length
    };

    res.json({
      success: true,
      data: {
        summary,
        results: processingResults,
        processedAt: new Date().toISOString()
      }
    });

  } catch (error) {
    logger.error('Error processing FI detection:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to process FI detection',
      message: error.message
    });
  }
});

/**
 * POST /api/documents-browser/local/process-folder
 * Process entire local folder(s) for FI detection (supports downloads_XXXXX or XXXXX naming)
 */
router.post('/local/process-folder', async (req, res) => {
  try {
    const {
      folderPaths,
      reportTypes,
      customerEmails, // Legacy support
      customers,      // New format with names and emails
      scheduleTime = null
    } = req.body;

    // Support both old and new customer data formats
    let customerData = [];
    if (customers && Array.isArray(customers)) {
      // New format: array of {name, email} objects
      customerData = customers;
    } else if (customerEmails && Array.isArray(customerEmails)) {
      // Legacy format: array of email strings
      customerData = customerEmails.map(email => ({
        email,
        name: email.split('@')[0] // Default name from email prefix
      }));
    }

    if (!folderPaths || !Array.isArray(folderPaths) || folderPaths.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Folder paths are required'
      });
    }

    if (!reportTypes || !Array.isArray(reportTypes) || reportTypes.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Report types are required'
      });
    }

    logger.info(`Starting local FI processing for ${folderPaths.length} folders`);

    // Get all projects from all folders
    const allProjects = [];
    for (const folderPath of folderPaths) {
      try {
        const absolutePath = path.resolve(folderPath);
        const projects = await getLocalProjectsFromFolder(absolutePath);
        allProjects.push(...projects);
        logger.info(`Found ${projects.length} projects in folder ${folderPath}`);
      } catch (error) {
        logger.error(`Error getting projects from folder ${folderPath}:`, error);
      }
    }

    logger.info(`Total projects to process: ${allProjects.length}`);

    // Process in batches to handle large numbers
    const batchSize = 50; // Process 50 projects at a time
    const processingResults = [];

    for (let i = 0; i < allProjects.length; i += batchSize) {
      const batch = allProjects.slice(i, i + batchSize);
      logger.info(`Processing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(allProjects.length / batchSize)} (${batch.length} projects)`);

      const batchResults = await processLocalBatch(batch, reportTypes, customerData);
      processingResults.push(...batchResults);

      // Small delay between batches to prevent overwhelming the system
      if (i + batchSize < allProjects.length) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    const summary = {
      totalFolders: folderPaths.length,
      totalProjects: allProjects.length,
      processed: processingResults.filter(r => r.status !== 'error').length,
      errors: processingResults.filter(r => r.status === 'error').length,
      matchesFound: processingResults.filter(r => r.status === 'matches_found').length,
      noMatches: processingResults.filter(r => r.status === 'no_matches').length,
      skipped: processingResults.filter(r => r.status === 'skipped').length
    };

    res.json({
      success: true,
      data: {
        summary,
        results: processingResults,
        processedAt: new Date().toISOString()
      }
    });

  } catch (error) {
    logger.error('Error processing local folder FI detection:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to process local folder FI detection',
      message: error.message
    });
  }
});

/**
 * POST /api/documents-browser/local/process-fi
 * Process FI detection for selected local projects (with Building Info API calls only for matches)
 */
router.post('/local/process-fi', async (req, res) => {
  try {
    const {
      projectPaths,
      reportTypes,
      customerEmails, // Legacy support
      customers,      // New format with names and emails
      scheduleTime = null
    } = req.body;

    // Support both old and new customer data formats
    let customerData = [];
    if (customers && Array.isArray(customers)) {
      // New format: array of {name, email} objects
      customerData = customers;
    } else if (customerEmails && Array.isArray(customerEmails)) {
      // Legacy format: array of email strings
      customerData = customerEmails.map(email => ({
        email,
        name: email.split('@')[0] // Default name from email prefix
      }));
    }

    if (!projectPaths || !Array.isArray(projectPaths) || projectPaths.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Project paths are required'
      });
    }

    if (!reportTypes || !Array.isArray(reportTypes) || reportTypes.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Report types are required'
      });
    }

    logger.info(`Starting local FI processing for ${projectPaths.length} projects`);

    // Convert paths to project objects
    const projects = [];
    for (const projectPath of projectPaths) {
      const absolutePath = path.resolve(projectPath);
      const folderName = path.basename(absolutePath);
      const match = folderName.match(/^(?:downloads_)?(\d+)$/);
      const projectId = match ? match[1] : folderName; // Fallback to folder name if no numeric match
      projects.push({
        projectId,
        path: absolutePath
      });
    }

    // Process projects
    const processingResults = await processLocalBatch(projects, reportTypes, customerData);

    const summary = {
      totalProjects: projects.length,
      processed: processingResults.filter(r => r.status !== 'error').length,
      errors: processingResults.filter(r => r.status === 'error').length,
      matchesFound: processingResults.filter(r => r.status === 'matches_found').length,
      noMatches: processingResults.filter(r => r.status === 'no_matches').length,
      skipped: processingResults.filter(r => r.status === 'skipped').length
    };

    res.json({
      success: true,
      data: {
        summary,
        results: processingResults,
        processedAt: new Date().toISOString()
      }
    });

  } catch (error) {
    logger.error('Error processing local FI detection:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to process local FI detection',
      message: error.message
    });
  }
});

// Helper function to get local projects from a folder (supports downloads_XXXXX or XXXXX naming)
async function getLocalProjectsFromFolder(folderPath) {
  const projects = [];

  try {
    await fs.access(folderPath);
    const entries = await fs.readdir(folderPath, { withFileTypes: true });

    // Check if this folder itself is a project folder (downloads_XXXXX or XXXXX pattern)
    const folderName = path.basename(folderPath);
    const directMatch = folderName.match(/^(?:downloads_)?(\d+)$/);

    if (directMatch) {
      // This folder is itself a project folder
      const projectId = directMatch[1];
      const pdfFiles = await fs.readdir(folderPath);
      const pdfCount = pdfFiles.filter(file => file.toLowerCase().endsWith('.pdf')).length;

      if (pdfCount > 0) {
        projects.push({
          projectId,
          path: folderPath,
          pdfCount
        });
      }
    } else {
      // This is a parent folder - look for project subfolders
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const match = entry.name.match(/^(?:downloads_)?(\d+)$/);
          if (match) {
            const projectId = match[1];
            const projectPath = path.join(folderPath, entry.name);

            try {
              const projectFiles = await fs.readdir(projectPath);
              const pdfFiles = projectFiles.filter(file => file.toLowerCase().endsWith('.pdf'));

              if (pdfFiles.length > 0) {
                projects.push({
                  projectId,
                  path: projectPath,
                  pdfCount: pdfFiles.length
                });
              }
            } catch (error) {
              logger.warn(`Error scanning project ${entry.name}:`, error.message);
            }
          }
        }
      }
    }
  } catch (error) {
    logger.error(`Error scanning folder ${folderPath}:`, error);
  }

  return projects;
}

// Helper function to process a batch of local projects
async function processLocalBatch(projects, reportTypes, customerData) {
  const processingResults = [];
  const customerMatches = {}; // Group matches by customer email

  // Initialize customer matches structure
  if (customerData && customerData.length > 0) {
    for (const customer of customerData) {
      customerMatches[customer.email] = {
        email: customer.email,
        name: customer.name || customer.email.split('@')[0], // Use provided name or fallback
        matches: []
      };
    }
  }

  for (const project of projects) {
    try {
      logger.info(`Processing local project ${project.projectId} for FI detection`);

      // Get project documents from local filesystem
      const documents = await getLocalProjectDocuments(project.path);

      if (documents.length === 0) {
        processingResults.push({
          projectId: project.projectId,
          status: 'skipped',
          reason: 'No documents found',
          documentsProcessed: 0
        });
        continue;
      }

      // Run FI detection logic on the local documents
      const fiMatches = await simulateLocalFIDetection(documents, reportTypes);

      if (fiMatches && fiMatches.length > 0) {
        // Only NOW do we call the Building Info API (when we have matches)
        logger.info(`FI matches found for local project ${project.projectId}, fetching metadata`);
        const metadata = await buildingInfoService.getProjectMetadata(project.projectId);

        processingResults.push({
          projectId: project.projectId,
          status: 'matches_found',
          metadata,
          fiMatches,
          documentsProcessed: documents.length,
          matchedDocuments: fiMatches.length,
          projectPath: project.path
        });

        // Create or find the project record
        let projectRecord = await Project.findOne({ projectId: project.projectId });
        if (!projectRecord) {
          projectRecord = new Project({
            projectId: project.projectId,
            title: metadata.planning_title || `Project ${project.projectId}`,
            planningAuthority: metadata.planning_authority || 'Unknown',
            location: metadata.planning_location || '',
            status: 'fi_requested'
          });
          await projectRecord.save();
        }

        // Process each FI match and collect for batch emails
        for (const match of fiMatches) {
          try {
            // Collect matches for each customer (no FI request record needed)
            if (customerData && customerData.length > 0) {
              for (const customerInfo of customerData) {
                // Find or create customer record
                let customer = await Customer.findOne({ email: customerInfo.email });
                if (!customer) {
                  customer = new Customer({
                    name: customerInfo.name || customerInfo.email.split('@')[0],
                    email: customerInfo.email,
                    reportTypes: [match.reportType],
                    isActive: true
                  });
                  await customer.save();
                }

                // Update customer name in matches (use provided name or database name)
                customerMatches[customerInfo.email].name = customerInfo.name || customer.name;

                // Add match to customer's batch
                customerMatches[customerInfo.email].matches.push({
                  projectId: project.projectId,
                  documentName: match.documentName,
                  reportType: match.reportType,
                  confidence: Math.round(match.confidence * 100),
                  matchedText: match.matchedText,
                  projectMetadata: metadata, // ← Fixed: Use the expected structure
                  detectionMethod: 'local_simulation'
                });
              }
            }
          } catch (fiError) {
            logger.error(`Error processing FI match for project ${project.projectId}:`, fiError);
          }
        }
      } else {
        processingResults.push({
          projectId: project.projectId,
          status: 'no_matches',
          documentsProcessed: documents.length,
          matchedDocuments: 0,
          projectPath: project.path
        });
      }

    } catch (error) {
      logger.error(`Error processing local project ${project.projectId}:`, error);
      processingResults.push({
        projectId: project.projectId,
        status: 'error',
        error: error.message,
        documentsProcessed: 0,
        projectPath: project.path
      });
    }
  }

  // Send batch emails to customers
  if (customerData && customerData.length > 0) {
    logger.info(`Sending batch FI notification emails to ${customerData.length} customers`);

    for (const customer of customerData) {
      const customerMatchData = customerMatches[customer.email];

      if (customerMatchData.matches.length > 0) {
        try {
          const emailResult = await emailService.sendBatchFINotification(
            customer.email,
            customerMatchData.name,
            {
              matches: customerMatchData.matches
            }
          );

          // Email sent successfully - no FI request tracking needed

          // Update customer stats
          const customerRecord = await Customer.findOne({ email: customer.email });
          if (customerRecord) {
            await customerRecord.recordEmailSent();
          }

          logger.info(`Batch FI notification sent to ${customer.email} with ${customerMatchData.matches.length} matches`);
        } catch (emailError) {
          logger.error(`Error sending batch FI notification to ${customer.email}:`, emailError);
        }
      }
    }
  }

  return processingResults;
}

// Helper function to get documents from a local project folder
async function getLocalProjectDocuments(projectPath) {
  const documents = [];

  try {
    const files = await fs.readdir(projectPath);

    for (const file of files) {
      if (file.toLowerCase().endsWith('.pdf')) {
        const filePath = path.join(projectPath, file);
        const stats = await fs.stat(filePath);

        documents.push({
          fileName: file,
          filePath: filePath,
          size: stats.size,
          lastModified: stats.mtime
        });
      }
    }
  } catch (error) {
    logger.error(`Error getting documents from ${projectPath}:`, error);
  }

  return documents;
}

// Real FI detection function using OCR and OpenAI (matching rag_pipeline reliability)
async function simulateLocalFIDetection(documents, reportTypes) {
  const detector = require('../services/fiDetectionService');

  const allMatches = [];

  for (const doc of documents) {
    try {
      logger.info(`Processing local document: ${doc.fileName}`);

      // Step 1: OCR if needed
      const ocrPath = await detector.ocrIfNeeded(doc.filePath);

      // Step 2: Extract text
      const text = await detector.extractPdfText(ocrPath);

      if (!text || text.trim().length === 0) {
        logger.warn(`No text extracted from ${doc.fileName}`);
        continue;
      }

      // Step 3: Process each report type
      for (const reportType of reportTypes) {
        // Quick pre-filter
        if (!detector.quickKeywordFilter(text, reportType)) {
          continue;
        }

        // Step 4: Check if document is an FI request
        const isFIRequest = await detector.detectFIRequest(text);

        if (isFIRequest) {
          // Step 5: Check if FI request matches the report type
          const matchesType = await detector.matchFIRequestType(text, reportType);

          if (matchesType) {
            // Step 6: Extract FI details
            const fiDetails = await detector.extractFIRequestInfo(text, doc.fileName);

            allMatches.push({
              documentName: doc.fileName,
              documentPath: doc.filePath,
              reportType: reportType,
              confidence: 0.9, // High confidence for properly detected FI requests
              matchedText: fiDetails.Summary || text.substring(0, 200),
              fiDetails: fiDetails
            });

            logger.info(`FI match found: ${reportType} in ${doc.fileName}`);
          }
        }

        // Delay to avoid API rate limits
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    } catch (error) {
      logger.error(`Error processing document ${doc.fileName}:`, error);
    }
  }

  return allMatches;
}

// Helper function to process a batch of projects (AWS S3)
async function processBatch(projectIds, reportTypes, customerData) {
  const processingResults = [];
  const customerMatches = {}; // Group matches by customer email

  // Initialize customer matches structure
  if (customerData && customerData.length > 0) {
    for (const customer of customerData) {
      customerMatches[customer.email] = {
        email: customer.email,
        name: customer.name || customer.email.split('@')[0], // Use provided name or fallback
        matches: []
      };
    }
  }

  for (const projectId of projectIds) {
    try {
      logger.info(`Processing project ${projectId} for FI detection`);

      // Get project documents
      const documents = await s3Service.listProjectDocuments(projectId);

      if (documents.length === 0) {
        processingResults.push({
          projectId,
          status: 'skipped',
          reason: 'No documents found',
          documentsProcessed: 0
        });
        continue;
      }

      // Run FI detection logic on the documents
      const fiMatches = await simulateFIDetection(documents, reportTypes);

      if (fiMatches && fiMatches.length > 0) {
        // Only NOW do we call the Building Info API (when we have matches)
        logger.info(`FI matches found for project ${projectId}, fetching metadata`);
        const metadata = await buildingInfoService.getProjectMetadata(projectId);

        processingResults.push({
          projectId,
          status: 'matches_found',
          metadata,
          fiMatches,
          documentsProcessed: documents.length,
          matchedDocuments: fiMatches.length
        });

        // Create or find the project record
        let projectRecord = await Project.findOne({ projectId });
        if (!projectRecord) {
          projectRecord = new Project({
            projectId,
            title: metadata.planning_title || `Project ${projectId}`,
            planningAuthority: metadata.planning_authority || 'Unknown',
            location: metadata.planning_location || '',
            status: 'fi_requested'
          });
          await projectRecord.save();
        }

        // Process each FI match and collect for batch emails
        for (const match of fiMatches) {
          try {
            // Collect matches for each customer (no FI request record needed)
            if (customerData && customerData.length > 0) {
              for (const customerInfo of customerData) {
                // Find or create customer record
                let customer = await Customer.findOne({ email: customerInfo.email });
                if (!customer) {
                  customer = new Customer({
                    name: customerInfo.name || customerInfo.email.split('@')[0],
                    email: customerInfo.email,
                    reportTypes: [match.reportType],
                    isActive: true
                  });
                  await customer.save();
                }

                // Update customer name in matches (use provided name or database name)
                customerMatches[customerInfo.email].name = customerInfo.name || customer.name;

                // Add match to customer's batch
                customerMatches[customerInfo.email].matches.push({
                  projectId,
                  documentName: match.documentName,
                  reportType: match.reportType,
                  confidence: Math.round(match.confidence * 100),
                  matchedText: match.matchedText,
                  projectMetadata: metadata, // ← Fixed: Use the expected structure
                  detectionMethod: 'api_simulation'
                });
              }
            }
          } catch (fiError) {
            logger.error(`Error processing FI match for project ${projectId}:`, fiError);
          }
        }
      } else {
        processingResults.push({
          projectId,
          status: 'no_matches',
          documentsProcessed: documents.length,
          matchedDocuments: 0
        });
      }

    } catch (error) {
      logger.error(`Error processing project ${projectId}:`, error);
      processingResults.push({
        projectId,
        status: 'error',
        error: error.message,
        documentsProcessed: 0
      });
    }
  }

  // Send batch emails to customers
  if (customerData && customerData.length > 0) {
    logger.info(`Sending batch FI notification emails to ${customerData.length} customers`);

    for (const customer of customerData) {
      const customerMatchData = customerMatches[customer.email];

      if (customerMatchData.matches.length > 0) {
        try {
          const emailResult = await emailService.sendBatchFINotification(
            customer.email,
            customerMatchData.name,
            {
              matches: customerMatchData.matches
            }
          );

          // Record notifications for all matches
          // Email sent successfully - no FI request tracking needed

          // Update customer stats
          const customerRecord = await Customer.findOne({ email: customer.email });
          if (customerRecord) {
            await customerRecord.recordEmailSent();
          }

          logger.info(`Batch FI notification sent to ${customer.email} with ${customerMatchData.matches.length} matches`);
        } catch (emailError) {
          logger.error(`Error sending batch FI notification to ${customer.email}:`, emailError);
        }
      }
    }
  }

  return processingResults;
}

// Real FI detection function for AWS documents using OCR and OpenAI (matching rag_pipeline reliability)
async function simulateFIDetection(documents, reportTypes) {
  const detector = require('../services/fiDetectionService');

  const allMatches = [];

  for (const doc of documents) {
    try {
      logger.info(`Processing AWS document: ${doc.fileName}`);

      // For AWS S3 documents, we need to download them first
      let documentPath;
      if (doc.downloadUrl) {
        // Download from S3 to temporary location
        const tempPath = path.join(os.tmpdir(), `temp_${Date.now()}_${doc.fileName}`);
        await s3Service.downloadFile(doc.key, tempPath);
        documentPath = tempPath;
      } else {
        logger.warn(`No download URL for AWS document: ${doc.fileName}`);
        continue;
      }

      // Step 1: OCR if needed
      const ocrPath = await detector.ocrIfNeeded(documentPath);

      // Step 2: Extract text
      const text = await detector.extractPdfText(ocrPath);

      if (!text || text.trim().length === 0) {
        logger.warn(`No text extracted from ${doc.fileName}`);
        // Clean up temp file
        try { await fs.unlink(documentPath); } catch {}
        continue;
      }

      // Step 3: Process each report type
      for (const reportType of reportTypes) {
        // Quick pre-filter
        if (!detector.quickKeywordFilter(text, reportType)) {
          continue;
        }

        // Step 4: Check if document is an FI request
        const isFIRequest = await detector.detectFIRequest(text);

        if (isFIRequest) {
          // Step 5: Check if FI request matches the report type
          const matchesType = await detector.matchFIRequestType(text, reportType);

          if (matchesType) {
            // Step 6: Extract FI details
            const fiDetails = await detector.extractFIRequestInfo(text, doc.fileName);

            allMatches.push({
              documentName: doc.fileName,
              documentPath: doc.key, // Use S3 key for AWS documents
              reportType: reportType,
              confidence: 0.9, // High confidence for properly detected FI requests
              matchedText: fiDetails.Summary || text.substring(0, 200),
              fiDetails: fiDetails
            });

            logger.info(`FI match found: ${reportType} in ${doc.fileName}`);
          }
        }

        // Delay to avoid API rate limits
        await new Promise(resolve => setTimeout(resolve, 500));
      }

      // Clean up temp file
      try {
        await fs.unlink(documentPath);
      } catch (cleanupError) {
        logger.warn(`Could not clean up temp file ${documentPath}:`, cleanupError);
      }

    } catch (error) {
      logger.error(`Error processing AWS document ${doc.fileName}:`, error);
    }
  }

  return allMatches;
}

module.exports = router;
