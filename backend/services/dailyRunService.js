const logger = require('../utils/logger');
const DailyRun = require('../models/DailyRun');
const DailyRunItem = require('../models/DailyRunItem');
const { S3Client, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const { getBucket, getRegion } = require('../utils/awsConfig');
const { withLock } = require('./jobLock');

const s3Client = new S3Client({
  region: getRegion(),
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  }
});

const BUCKET = getBucket();
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

    // This is reachable from POST /api/runs/daily, which PM2 load-balances across both
    // cluster instances - so the in-process isScanning flag on one fork says nothing
    // about the other. Two concurrent scans of the same run would double every counter.
    const outcome = await withLock(
      'daily-run-scan',
      {
        ttlMs: 120 * 60 * 1000,
        heartbeat: true,
        meta: { runId },
        skipMessage: `⏭️ Daily run scan held by another process, skipping run ${runId}`
      },
      () => this.executeScan(runId)
    );

    return outcome.ran ? outcome.result : undefined;
  }

  async executeScan(runId) {
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
                  
                  // Skip non-PDF/DOCX files and folders
                  const keyLower = key.toLowerCase();
                  if (!keyLower.endsWith('.pdf') && !keyLower.endsWith('.docx')) {
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
                // Count what ACTUALLY inserted, not what we attempted. The counters used
                // to be incremented by the raw batch length regardless of duplicates, so
                // counters.queued overshot by the duplicate count and could never drain
                // to 0 - leaving the run stuck in 'processing' forever, because
                // checkRunCompletion waits for queued === 0 && processing === 0.
                let insertedCount = 0;
                try {
                  const inserted = await DailyRunItem.insertMany(itemsToInsert, { ordered: false });
                  insertedCount = inserted.length;
                } catch (error) {
                  // Ignore duplicate key errors (11000)
                  if (error.code !== 11000 && !error.writeErrors) {
                    throw error;
                  }
                  insertedCount = Array.isArray(error.insertedDocs)
                    ? error.insertedDocs.length
                    : itemsToInsert.length - (error.writeErrors?.length || 0);
                }

                itemsCreated += insertedCount;

                // scanProgress must be written even when every item was a duplicate -
                // it is what a restart resumes from.
                const update = {
                  $set: {
                    'scanProgress.objectsScanned': objectsScanned,
                    'scanProgress.lastKey': batch[batch.length - 1].Key
                  }
                };

                if (insertedCount > 0) {
                  update.$inc = {
                    'counters.totalItems': insertedCount,
                    'counters.queued': insertedCount
                  };
                }

                await DailyRun.updateOne({ runId }, update);
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
            logger.info(`📊 [RUN ${runId.slice(-8)}] Progress: ${objectsScanned.toLocaleString()} objects scanned, ${itemsCreated} items queued`);
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

        logger.info(`✅ [RUN ${runId.slice(-8)}] Scan complete: ${itemsCreated} items queued from ${objectsScanned.toLocaleString()} objects (${duration}s)`);

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
   * Rebuild a run's counters from its items, which are the source of truth.
   *
   * Needed because the counters drifted for as long as the $inc bug above was live: any
   * run whose scan hit a duplicate key has counters.queued permanently above the real
   * outstanding count, so checkRunCompletion never fires and the run sits in 'processing'
   * forever. Also useful after any bulk status change (retry-failed, resetStaleItems).
   *
   * @returns {Promise<{before: object, after: object, drifted: boolean, completed: boolean}>}
   */
  async reconcileCounters(runId) {
    const run = await DailyRun.findOne({ runId });
    if (!run) {
      throw new Error(`Run ${runId} not found`);
    }

    const grouped = await DailyRunItem.aggregate([
      { $match: { runId } },
      { $group: { _id: '$status', n: { $sum: 1 } } }
    ]);

    const actual = { totalItems: 0, queued: 0, processing: 0, completed: 0, failed: 0 };
    for (const row of grouped) {
      actual.totalItems += row.n;
      if (Object.prototype.hasOwnProperty.call(actual, row._id)) {
        actual[row._id] = row.n;
      }
    }

    const before = {
      totalItems: run.counters?.totalItems || 0,
      queued: run.counters?.queued || 0,
      processing: run.counters?.processing || 0,
      completed: run.counters?.completed || 0,
      failed: run.counters?.failed || 0
    };

    const drifted = Object.keys(actual).some(key => actual[key] !== before[key]);

    const update = { $set: { counters: actual } };

    // A run whose items are all resolved but whose stale counters kept it 'processing'
    // is exactly the stuck case this method exists to clear.
    const outstanding = actual.queued + actual.processing;
    const completed = outstanding === 0 && ['scanning', 'processing'].includes(run.status);
    if (completed) {
      update.$set.status = 'completed';
      update.$set.completedAt = new Date();
    }

    await DailyRun.updateOne({ runId }, update);

    if (drifted) {
      logger.info(
        `♻️ Reconciled counters for run ${runId}: ` +
        `queued ${before.queued}→${actual.queued}, processing ${before.processing}→${actual.processing}, ` +
        `completed ${before.completed}→${actual.completed}, failed ${before.failed}→${actual.failed}, ` +
        `total ${before.totalItems}→${actual.totalItems}`
      );
    }
    if (completed) {
      logger.info(`🎉 Run ${runId} marked complete during reconciliation (no outstanding items)`);
    }

    return { before, after: actual, drifted, completed };
  }

  /**
   * Reset stale processing items back to queued
   * Call on startup for restart safety
   */
  async resetStaleItems() {
    try {
      const staleThreshold = new Date(Date.now() - 30 * 60 * 1000); // 30 minutes ago
      const staleFilter = { status: 'processing', processingStartedAt: { $lt: staleThreshold } };

      // Collect the affected runs BEFORE the update - afterwards the filter matches
      // nothing and there is no way to tell which runs need reconciling.
      const runIds = await DailyRunItem.distinct('runId', staleFilter);

      const result = await DailyRunItem.updateMany(
        staleFilter,
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

      // Moving items between statuses invalidates the stored counters either way.
      for (const runId of runIds) {
        try {
          await this.reconcileCounters(runId);
        } catch (error) {
          logger.error(`❌ Could not reconcile counters for run ${runId}:`, error);
        }
      }

      return { modifiedCount: result.modifiedCount, runIds };
    } catch (error) {
      logger.error('❌ Error resetting stale items:', error);
      throw error;
    }
  }
}

module.exports = new DailyRunService();
