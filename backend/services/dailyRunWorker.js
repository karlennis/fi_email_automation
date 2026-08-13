const logger = require('../utils/logger');
const runContext = require('../utils/runContext');
const DailyRun = require('../models/DailyRun');
const DailyRunItem = require('../models/DailyRunItem');
const s3Service = require('./s3Service');
const fiDetectionService = require('./fiDetectionService');
const dailyRunService = require('./dailyRunService');
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
      logger.warn('daily run worker already running');
      return;
    }

    this.isRunning = true;
    this.totalProcessed = 0;
    logger.info('daily run worker started', { concurrency: 1, pollSec: 2 });

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
    logger.info('daily run worker stopped');
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
        logger.warn('daily run worker: high memory usage', memMB);
      } else if (memMB.heapUsed > 1000) {
        logger.debug('daily run worker: memory', memMB);
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
        logger.error('daily run worker: loop error', error);
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

      // Everything this item touches - s3Service, OCR, fiDetectionService - inherits
      // the run's id from here, so a failure can be traced back to the run and the file
      // without either being repeated in the message text.
      return runContext.runWith({ runId: item.runId, file: item.fileName, proj: item.projectId }, async () => {
        logger.debug('daily run: item start');

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

            // Truncate to max size for AI (32000 chars - matches fiDetectionService.MAX_MSG_CHARS)
            if (documentText.length > 32000) {
              documentText = documentText.substring(0, 32000);
            }
          } catch (extractError) {
            logger.debug('daily run: text extraction failed, falling back to OCR');
            try {
              documentText = await fiDetectionService.ocrIfNeeded(tempFilePath);
              if (documentText.length > 32000) {
                documentText = documentText.substring(0, 32000);
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
              // Only mark detected when we have a validated report-type match
              for (const docType of ['acoustic', 'transport', 'flood', 'contamination', 'ecology', 'arboricultural']) {
                const matchResult = await fiDetectionService.matchFIRequestType(documentText, docType);
                const isValidatedMatch = matchResult.matches === true && matchResult.hasValidEvidence === true;

                if (isValidatedMatch) {
                  detectionResult.detected = true;
                  detectionResult.method = 'fi-detection';
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

          logger.debug('daily run: item done', { fi: detectionResult.detected, type: detectionResult.documentType || '-' });

          this.totalProcessed++;

          // Log processing summary every 10 items
          if (this.totalProcessed % 10 === 0) {
            const run = await DailyRun.findOne({ runId: item.runId });
            if (run) {
              logger.info('daily run: progress', { completed: run.counters.completed, total: run.counters.totalItems, failed: run.counters.failed });
            }
          }

          // Check if run is complete
          await this.checkRunCompletion(item.runId);

        } catch (error) {
          logger.error('daily run: item FAILED', { item: String(item._id), err: error.message, stack: error.stack });

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
      });

    } catch (error) {
      logger.error('daily run: processNextItem failed', error);
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

      // Ask the items, not the counters. The stored counters used to be incremented by
      // the full batch length even when duplicates were rejected, so counters.queued
      // could never reach 0 and a run stayed 'processing' forever. This count is served
      // by the { runId: 1, status: 1 } index on DailyRunItem.
      const outstanding = await DailyRunItem.countDocuments({
        runId,
        status: { $in: ['queued', 'processing'] }
      });

      if (outstanding === 0) {
        // Rewrite the counters from the items before reporting, so the completion log
        // and the UI show the real numbers rather than the drifted ones.
        const { after } = await dailyRunService.reconcileCounters(runId);

        const successRate = after.totalItems > 0
          ? ((after.completed / after.totalItems) * 100).toFixed(1)
          : 0;
        logger.info('run end: daily run', { run: runId, succeeded: after.completed, total: after.totalItems, failed: after.failed, successPct: successRate });
      }

    } catch (error) {
      logger.error('daily run: completion check failed', { run: runId, err: error.message, stack: error.stack });
    }
  }
}

module.exports = new DailyRunWorker();
