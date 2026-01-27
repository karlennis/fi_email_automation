const logger = require('../utils/logger');
const DailyRun = require('../models/DailyRun');
const DailyRunItem = require('../models/DailyRunItem');
const { S3Client, ListObjectsV2Command } = require('@aws-sdk/client-s3');

const s3Client = new S3Client({
  region: process.env.AWS_REGION || 'eu-north-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  }
});

const BUCKET = process.env.S3_BUCKET || 'planning-documents-2';
const PREFIX = 'planning-docs/';

class DailyRunService {
  constructor() {
    this.isScanning = false;
  }

  /**
   * Start S3 scan for a run
   * Streams S3 objects and writes matching items to DB immediately
   */
  async startScan(runId) {
    if (this.isScanning) {
      logger.warn(`⚠️ Scan already in progress for another run`);
      return;
    }

    this.isScanning = true;

    try {
      const run = await DailyRun.findOne({ runId });
      if (!run) {
        throw new Error(`Run ${runId} not found`);
      }

      await DailyRun.updateOne(
        { runId },
        { 
          status: 'scanning',
          startedAt: new Date()
        }
      );

      const dayStart = new Date(run.targetDate);
      dayStart.setHours(0, 0, 0, 0);
      const dayEnd = new Date(dayStart);
      dayEnd.setHours(23, 59, 59, 999);

      logger.info(`🔍 Starting S3 scan for run ${runId}, date range: ${dayStart.toISOString()} to ${dayEnd.toISOString()}`);

      const startTime = Date.now();
      let objectsScanned = 0;
      let itemsCreated = 0;
      let continuationToken = run.scanProgress?.continuationToken || null;

      // Memory logging
      const logMemory = () => {
        const mem = process.memoryUsage();
        logger.info(`📊 Memory usage (scan):`, {
          rssMB: Math.round(mem.rss / 1024 / 1024),
          heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
          heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024)
        });
      };

      logMemory();
      const memInterval = setInterval(logMemory, 10000);

      try {
        do {
          const command = new ListObjectsV2Command({
            Bucket: BUCKET,
            Prefix: PREFIX,
            MaxKeys: 1000,
            ContinuationToken: continuationToken || undefined
          });

          const response = await s3Client.send(command);

          if (response.Contents) {
            // Process objects in batches to avoid blocking
            const batchSize = 100;
            for (let i = 0; i < response.Contents.length; i += batchSize) {
              const batch = response.Contents.slice(i, i + batchSize);
              
              const itemsToInsert = [];
              
              for (const obj of batch) {
                objectsScanned++;

                const lastModified = new Date(obj.LastModified);
                
                // Check date range
                if (lastModified >= dayStart && lastModified < dayEnd) {
                  const key = obj.Key;
                  
                  // Skip non-PDF files and folders
                  if (!key.toLowerCase().endsWith('.pdf')) {
                    continue;
                  }

                  // Extract project ID from path: planning-docs/PROJECTID/...
                  const parts = key.split('/');
                  if (parts.length < 3) {
                    continue;
                  }

                  const projectId = parts[1];
                  const fileName = parts[parts.length - 1];

                  itemsToInsert.push({
                    runId,
                    s3Key: key,
                    projectId,
                    fileName,
                    lastModified: obj.LastModified,
                    size: obj.Size || 0,
                    status: 'queued'
                  });
                }
              }

              // Bulk insert items (ignore duplicates)
              if (itemsToInsert.length > 0) {
                try {
                  await DailyRunItem.insertMany(itemsToInsert, { ordered: false });
                  itemsCreated += itemsToInsert.length;
                } catch (error) {
                  // Ignore duplicate key errors (11000)
                  if (error.code !== 11000) {
                    throw error;
                  }
                  // Count successful inserts
                  const successCount = itemsToInsert.length - (error.writeErrors?.length || 0);
                  itemsCreated += successCount;
                }

                // Update run counters
                await DailyRun.updateOne(
                  { runId },
                  {
                    $inc: {
                      'counters.totalItems': itemsToInsert.length,
                      'counters.queued': itemsToInsert.length
                    },
                    $set: {
                      'scanProgress.objectsScanned': objectsScanned,
                      'scanProgress.lastKey': batch[batch.length - 1].Key
                    }
                  }
                );
              }
            }
          }

          continuationToken = response.IsTruncated ? response.NextContinuationToken : null;

          // Save continuation token for restart safety
          if (continuationToken) {
            await DailyRun.updateOne(
              { runId },
              { 'scanProgress.continuationToken': continuationToken }
            );
          }

          if (objectsScanned % 5000 === 0) {
            logger.info(`   Scanned ${objectsScanned.toLocaleString()} objects, created ${itemsCreated} items...`);
          }

        } while (continuationToken);

        clearInterval(memInterval);
        logMemory();

        const duration = ((Date.now() - startTime) / 1000).toFixed(2);

        await DailyRun.updateOne(
          { runId },
          {
            status: 'processing',
            'scanProgress.continuationToken': null
          }
        );

        logger.info(`✅ S3 scan complete for run ${runId}`);
        logger.info(`   📊 Scanned ${objectsScanned.toLocaleString()} objects in ${duration}s`);
        logger.info(`   📄 Created ${itemsCreated} items for processing`);

        return {
          objectsScanned,
          itemsCreated,
          duration
        };

      } catch (error) {
        clearInterval(memInterval);
        throw error;
      }

    } catch (error) {
      logger.error(`❌ Error in S3 scan for run ${runId}:`, error);
      
      await DailyRun.updateOne(
        { runId },
        {
          status: 'error',
          error: error.message,
          completedAt: new Date()
        }
      );

      throw error;
    } finally {
      this.isScanning = false;
    }
  }

  /**
   * Reset stale processing items back to queued
   * Call on startup for restart safety
   */
  async resetStaleItems() {
    try {
      const staleThreshold = new Date(Date.now() - 30 * 60 * 1000); // 30 minutes ago

      const result = await DailyRunItem.updateMany(
        {
          status: 'processing',
          processingStartedAt: { $lt: staleThreshold }
        },
        {
          $set: {
            status: 'queued',
            processingStartedAt: null
          }
        }
      );

      if (result.modifiedCount > 0) {
        logger.info(`♻️ Reset ${result.modifiedCount} stale processing items to queued`);
      }

      return result.modifiedCount;
    } catch (error) {
      logger.error('❌ Error resetting stale items:', error);
      throw error;
    }
  }
}

module.exports = new DailyRunService();
