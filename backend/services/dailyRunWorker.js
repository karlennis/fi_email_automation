const logger = require('../utils/logger');
const DailyRun = require('../models/DailyRun');
const DailyRunItem = require('../models/DailyRunItem');
const s3Service = require('./s3Service');
const fiDetectionService = require('./fiDetectionService');
const path = require('path');
const fs = require('fs').promises;

class DailyRunWorker {
  constructor() {
    this.isRunning = false;
    this.concurrency = 1; // Single worker for memory safety
    this.pollInterval = 2000; // 2 seconds
    this.memoryLogInterval = null;
    this.totalProcessed = 0; // Track total items processed
  }

  /**
   * Start the worker loop
   */
  start() {
    if (this.isRunning) {
      logger.warn('⚠️ Worker already running');
      return;
    }

    this.isRunning = true;
    this.totalProcessed = 0;
    logger.info('🚀 Daily run worker started (concurrency: 1, polling every 2s)');

    // Start memory monitoring
    this.startMemoryMonitoring();

    // Start worker loop
    this.processLoop();
  }

  /**
   * Stop the worker loop
   */
  stop() {
    this.isRunning = false;
    if (this.memoryLogInterval) {
      clearInterval(this.memoryLogInterval);
    }
    logger.info('🛑 Daily run worker stopped');
  }

  /**
   * Memory monitoring every 10 seconds
   */
  startMemoryMonitoring() {
    this.memoryLogInterval = setInterval(() => {
      const mem = process.memoryUsage();
      const memMB = {
        rss: Math.round(mem.rss / 1024 / 1024),
        heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
        heapTotal: Math.round(mem.heapTotal / 1024 / 1024)
      };

      if (memMB.heapUsed > 1500) {
        logger.warn('🚨 High memory usage (worker):', memMB);
      } else if (memMB.heapUsed > 1000) {
        logger.info('📊 Memory usage (worker):', memMB);
      }
    }, 10000);
  }

  /**
   * Main processing loop
   */
  async processLoop() {
    while (this.isRunning) {
      try {
        await this.processNextItem();
      } catch (error) {
        logger.error('❌ Error in worker loop:', error);
      }

      // Wait before next iteration
      await new Promise(resolve => setTimeout(resolve, this.pollInterval));
    }
  }

  /**
   * Process next queued item
   */
  async processNextItem() {
    try {
      // Find next queued item from any active run
      const item = await DailyRunItem.findOneAndUpdate(
        { status: 'queued' },
        {
          $set: {
            status: 'processing',
            processingStartedAt: new Date()
          },
          $inc: { attempts: 1 }
        },
        { new: true, sort: { createdAt: 1 } }
      );

      if (!item) {
        // No items to process
        return;
      }

      // Update run counter
      await DailyRun.updateOne(
        { runId: item.runId },
        {
          $inc: {
            'counters.queued': -1,
            'counters.processing': 1
          }
        }
      );

      logger.info(`⚙️ [RUN ${item.runId.slice(-8)}] Processing: ${item.projectId}/${item.fileName}`);

      try {
        // Download file using s3Service
        const downloadResult = await s3Service.downloadDocument(item.s3Key);
        
        if (!downloadResult || !downloadResult.localPath) {
          throw new Error('Failed to download file from S3');
        }

        const tempFilePath = downloadResult.localPath;

        // Extract text from PDF
        let documentText = '';
        try {
          documentText = await fiDetectionService.extractPdfText(tempFilePath);
          
          // Truncate to max size for AI (8000 chars)
          if (documentText.length > 8000) {
            documentText = documentText.substring(0, 8000);
          }
        } catch (extractError) {
          logger.warn(`⚠️ Failed to extract text from ${item.fileName}, trying OCR...`);
          try {
            documentText = await fiDetectionService.ocrIfNeeded(tempFilePath);
            if (documentText.length > 8000) {
              documentText = documentText.substring(0, 8000);
            }
          } catch (ocrError) {
            throw new Error(`Text extraction failed: ${ocrError.message}`);
          }
        }

        // Run FI detection
        let detectionResult = {
          detected: false,
          confidence: 0,
          documentType: null,
          method: 'none'
        };

        if (documentText.length > 100) {
          const isFIRequest = await fiDetectionService.detectFIRequest(documentText);
          
          if (isFIRequest) {
            detectionResult.detected = true;
            detectionResult.method = 'fi-detection';
            detectionResult.confidence = 0.8;

            // Try to match specific FI types
            for (const docType of ['acoustic', 'transport', 'flood', 'contamination', 'ecology', 'arboricultural']) {
              const matchResult = await fiDetectionService.matchFIRequestType(documentText, docType);
              if (matchResult.matches) {
                detectionResult.documentType = docType;
                detectionResult.confidence = 0.95;
                break;
              }
            }
          }
        }

        // Clean up temp file
        try {
          await fs.unlink(tempFilePath);
        } catch (err) {
          // Ignore cleanup errors
        }

        // Update item with result
        await DailyRunItem.updateOne(
          { _id: item._id },
          {
            $set: {
              status: 'completed',
              processingCompletedAt: new Date(),
              result: {
                fiDetected: detectionResult.detected || false,
                confidence: detectionResult.confidence,
                documentType: detectionResult.documentType,
                method: detectionResult.method
              }
            }
          }
        );

        // Update run counters
        await DailyRun.updateOne(
          { runId: item.runId },
          {
            $inc: {
              'counters.processing': -1,
              'counters.completed': 1
            }
          }
        );

        logger.info(`✅ Completed: ${item.fileName} (FI: ${detectionResult.detected})`);

        this.totalProcessed++;

        // Log processing summary every 10 items
        if (this.totalProcessed % 10 === 0) {
          const run = await DailyRun.findOne({ runId: item.runId });
          if (run) {
            logger.info(`📊 [RUN ${item.runId.slice(-8)}] Progress: ${run.counters.completed}/${run.counters.totalItems} completed, ${run.counters.failed} failed`);
          }
        }

        // Check if run is complete
        await this.checkRunCompletion(item.runId);

      } catch (error) {
        logger.error(`❌ Error processing item ${item._id}:`, error);

        // Update item as failed
        await DailyRunItem.updateOne(
          { _id: item._id },
          {
            $set: {
              status: 'failed',
              processingCompletedAt: new Date(),
              error: error.message
            }
          }
        );

        // Update run counters
        await DailyRun.updateOne(
          { runId: item.runId },
          {
            $inc: {
              'counters.processing': -1,
              'counters.failed': 1
            }
          }
        );
      }

    } catch (error) {
      logger.error('❌ Error in processNextItem:', error);
    }
  }

  /**
   * Check if run is complete and update status
   */
  async checkRunCompletion(runId) {
    try {
      const run = await DailyRun.findOne({ runId });

      if (!run || run.status === 'completed') {
        return;
      }

      // Check if all items are processed
      const { queued, processing } = run.counters;

      if (queued === 0 && processing === 0) {
        await DailyRun.updateOne(
          { runId },
          {
            status: 'completed',
            completedAt: new Date()
          }
        );

        const successRate = run.counters.totalItems > 0 
          ? ((run.counters.completed / run.counters.totalItems) * 100).toFixed(1)
          : 0;
        logger.info(`🎉 [RUN ${runId.slice(-8)}] COMPLETE: ${run.counters.completed}/${run.counters.totalItems} succeeded (${successRate}%), ${run.counters.failed} failed`);
      }

    } catch (error) {
      logger.error(`❌ Error checking run completion for ${runId}:`, error);
    }
  }
}

module.exports = new DailyRunWorker();
