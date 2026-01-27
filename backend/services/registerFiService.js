const logger = require('../utils/logger');
const documentRegisterService = require('./documentRegisterService');
const documentFilterService = require('./documentFilterService');
const documentProcessor = require('./documentProcessor');
const s3Service = require('./s3Service');
const Customer = require('../models/Customer');

class RegisterFiService {
  constructor() {
    this.processingState = {
      lastProcessedTimestamp: null,
      isProcessing: false,
      currentScan: null
    };

    this.confidenceThreshold = 0.8; // Auto-process threshold
    this.reviewThreshold = 0.5;     // Queue for review threshold
  }

  /**
   * Scan document register for acoustic reports from a specific date range
   * @param {Object} options - { from: Date, to: Date, projectIds: string[] }
   * @returns {Promise<Object>} - Scan results with detected acoustic reports
   */
  async scanForAcousticReports(options = {}) {
    if (this.processingState.isProcessing) {
      throw new Error('A scan is already in progress');
    }

    try {
      this.processingState.isProcessing = true;

      const scanId = `scan_${Date.now()}`;
      const startTime = Date.now();

      // Set default date range (yesterday if not specified)
      const to = options.to || new Date();
      const from = options.from || new Date(Date.now() - 24 * 60 * 60 * 1000); // Yesterday

      logger.info(`🚀 Starting acoustic report scan: ${scanId}`, {
        from: from.toISOString(),
        to: to.toISOString(),
        projectIds: options.projectIds?.length || 'all'
      });

      // Initialize scan state
      this.processingState.currentScan = {
        scanId,
        startTime,
        from,
        to,
        status: 'scanning_register',
        stats: {
          documentsScanned: 0,
          projectsScanned: 0,
          acousticReportsFound: 0,
          highConfidence: 0,
          mediumConfidence: 0,
          lowConfidence: 0,
          reviewQueue: 0
        }
      };

      // Step 1: Scan document register for recent documents
      const recentDocuments = await this.getRecentDocuments(from, to, options.projectIds);

      this.processingState.currentScan.status = 'filtering_documents';
      this.processingState.currentScan.stats.documentsScanned = recentDocuments.length;
      this.processingState.currentScan.stats.projectsScanned =
        new Set(recentDocuments.map(d => d.projectId)).size;

      logger.info(`📊 Found ${recentDocuments.length} documents from ${this.processingState.currentScan.stats.projectsScanned} projects`);

      // Step 2: Filter documents through multi-stage pipeline
      const filteredResults = await this.filterDocumentsForAcoustic(recentDocuments);

      // Step 3: Categorize results by confidence
      const categorized = this.categorizeResults(filteredResults);

      // Step 4: Get customer subscriptions for acoustic reports
      const customers = await this.getAcousticCustomers();

      // Update scan stats
      this.processingState.currentScan.stats.acousticReportsFound = categorized.highConfidence.length + categorized.mediumConfidence.length;
      this.processingState.currentScan.stats.highConfidence = categorized.highConfidence.length;
      this.processingState.currentScan.stats.mediumConfidence = categorized.mediumConfidence.length;
      this.processingState.currentScan.stats.lowConfidence = categorized.lowConfidence.length;
      this.processingState.currentScan.stats.reviewQueue = categorized.reviewQueue.length;

      // Update processing timestamp
      this.processingState.lastProcessedTimestamp = to;
      this.processingState.currentScan.status = 'completed';
      this.processingState.currentScan.endTime = Date.now();
      this.processingState.currentScan.duration = Date.now() - startTime;

      const result = {
        scanId,
        status: 'completed',
        dateRange: { from, to },
        stats: this.processingState.currentScan.stats,
        results: {
          highConfidence: categorized.highConfidence,
          mediumConfidence: categorized.mediumConfidence,
          reviewQueue: categorized.reviewQueue
        },
        customers: customers.map(c => ({
          customerId: c._id,
          email: c.email,
          name: c.name,
          company: c.company
        })),
        duration: this.processingState.currentScan.duration,
        filterStats: documentFilterService.getStats()
      };

      logger.info(`✅ Scan completed: ${scanId}`, {
        duration: `${(result.duration / 1000).toFixed(1)}s`,
        acousticReports: result.stats.acousticReportsFound,
        customers: customers.length
      });

      return result;

    } catch (error) {
      logger.error('❌ Acoustic report scan failed:', error);

      if (this.processingState.currentScan) {
        this.processingState.currentScan.status = 'failed';
        this.processingState.currentScan.error = error.message;
      }

      throw error;

    } finally {
      this.processingState.isProcessing = false;
    }
  }

  /**
   * Get recent documents from the register
   */
  async getRecentDocuments(from, to, projectIds = null) {
    try {
      // Load the register metadata to get document list
      const metadata = documentRegisterService.loadMetadata();

      if (!metadata.lastScanDate) {
        logger.warn('⚠️  Document register not initialized. Run register scan first.');
        return [];
      }

      // Filter documents by date range
      const allDocuments = []; // We need to load actual document data

      // For now, we'll scan the register again to get fresh data
      // In production, consider using the pre-generated register files
      logger.info('📂 Scanning S3 for recent documents...');
      const documents = await documentRegisterService.scanAllDocuments();

      // Filter by date range
      const filtered = documents.filter(doc => {
        const docDate = new Date(doc.lastModified);
        const inRange = docDate >= from && docDate <= to;
        const inProjects = !projectIds || projectIds.includes(doc.projectId);
        return inRange && inProjects;
      });

      logger.info(`🔍 Filtered to ${filtered.length} documents in date range`);

      return filtered;

    } catch (error) {
      logger.error('Error getting recent documents:', error);
      throw error;
    }
  }

  /**
   * Filter documents through the multi-stage acoustic detection pipeline
   */
  async filterDocumentsForAcoustic(documents) {
    const results = [];

    logger.info(`🔬 Processing ${documents.length} documents through filter pipeline`);

    // Process in batches to avoid overwhelming the system
    const batchSize = 50;

    for (let i = 0; i < documents.length; i += batchSize) {
      const batch = documents.slice(i, i + batchSize);
      logger.info(`Processing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(documents.length / batchSize)}`);

      for (const doc of batch) {
        try {
          // Stage 1 & 2: Fast filtering (filename + content)
          // Only download document if Stage 1 passes
          const stage1Result = documentFilterService.stage1FilenameFilter(doc.fileName);

          if (stage1Result.reject) {
            // Skip documents that clearly aren't acoustic reports
            continue;
          }

          let filterResult;

          if (stage1Result.pass && stage1Result.confidence >= 0.8) {
            // High confidence from filename alone
            filterResult = {
              ...doc,
              isAcoustic: true,
              confidence: stage1Result.confidence,
              stage: 'stage1',
              reason: stage1Result.reason,
              reviewNeeded: false
            };
          } else {
            // Need content analysis - download and extract text
            const docBuffer = await s3Service.getDocumentBuffer(doc.filePath);
            const processedDoc = await documentProcessor.processDocumentFromMemory(
              docBuffer.buffer,
              doc.fileName
            );

            // Run full filter pipeline
            filterResult = await documentFilterService.filterDocument(
              {
                ...doc,
                buffer: docBuffer.buffer
              },
              processedDoc.text
            );
          }

          if (filterResult.isAcoustic || filterResult.reviewNeeded) {
            results.push(filterResult);
          }

        } catch (error) {
          logger.error(`Failed to process ${doc.fileName}:`, error);
          // Add to review queue on error
          results.push({
            ...doc,
            isAcoustic: false,
            confidence: 0,
            stage: 'error',
            reason: `Processing error: ${error.message}`,
            reviewNeeded: true
          });
        }
      }

      // Small delay between batches
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    return results;
  }

  /**
   * Categorize results by confidence level
   */
  categorizeResults(results) {
    return {
      highConfidence: results.filter(r =>
        r.isAcoustic && r.confidence >= this.confidenceThreshold
      ),
      mediumConfidence: results.filter(r =>
        r.isAcoustic && r.confidence >= this.reviewThreshold && r.confidence < this.confidenceThreshold
      ),
      lowConfidence: results.filter(r =>
        !r.isAcoustic && r.confidence > 0.2 && r.confidence < this.reviewThreshold
      ),
      reviewQueue: results.filter(r => r.reviewNeeded)
    };
  }

  /**
   * Get all customers subscribed to acoustic reports
   */
  async getAcousticCustomers() {
    try {
      const customers = await Customer.find({
        reportTypes: 'acoustic',
        isActive: true
      });

      logger.info(`👥 Found ${customers.length} customers subscribed to acoustic reports`);

      return customers;

    } catch (error) {
      logger.error('Error fetching acoustic customers:', error);
      return [];
    }
  }

  /**
   * Run daily scan (scans yesterday's documents)
   */
  async runDailyScan() {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const today = new Date();

    yesterday.setHours(0, 0, 0, 0);
    today.setHours(0, 0, 0, 0);

    return await this.scanForAcousticReports({
      from: yesterday,
      to: today
    });
  }

  /**
   * Get current scan status
   */
  getScanStatus() {
    return {
      isProcessing: this.processingState.isProcessing,
      lastProcessedTimestamp: this.processingState.lastProcessedTimestamp,
      currentScan: this.processingState.currentScan
    };
  }

  /**
   * Update confidence thresholds
   */
  updateThresholds(confidence, review) {
    if (confidence !== undefined && confidence >= 0 && confidence <= 1) {
      this.confidenceThreshold = confidence;
      logger.info(`Updated confidence threshold: ${confidence}`);
    }

    if (review !== undefined && review >= 0 && review <= 1) {
      this.reviewThreshold = review;
      logger.info(`Updated review threshold: ${review}`);
    }
  }

  /**
   * Get processing configuration
   */
  getConfig() {
    return {
      confidenceThreshold: this.confidenceThreshold,
      reviewThreshold: this.reviewThreshold,
      lastProcessedTimestamp: this.processingState.lastProcessedTimestamp
    };
  }
}

module.exports = new RegisterFiService();
