/**
 * Disk Cleanup Service
 *
 * Cleans up orphaned temp files and keeps the log directory from filling the disk.
 *
 * Log handling has two halves, and they must not be confused:
 *
 *  - app-DATE.log / debug-DATE.log / error-DATE.log are written by utils/logger.js and
 *    rotated by date. winston-daily-rotate-file already enforces their retention, so
 *    this service must NEVER truncate them - cutting the live app-<today>.log in half
 *    destroys the very run someone is trying to diagnose. It only sweeps up dated files
 *    that outlived their window, which happens when the process was down at rotation
 *    time.
 *
 *  - PM2's own *-out.log / *-error.log / *-combined.log capture crash output that never
 *    reaches winston. They have no date rotation of their own, so they are size-capped
 *    here: keep the tail, drop the head, always on a line boundary.
 */

const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const runContext = require('../utils/runContext');

const TEMP_DIR = path.join(__dirname, '..', 'temp');
const LOG_DIR = logger.logDir;

// Max age for temp files (1 hour - they should be deleted immediately after processing)
const TEMP_MAX_AGE_MS = 60 * 60 * 1000;

// Max size for a PM2 capture file before its head is dropped (100MB), and how much of
// the tail to keep (10MB).
const MAX_LOG_SIZE_BYTES = 100 * 1024 * 1024;
const KEEP_TAIL_BYTES = 10 * 1024 * 1024;

// Backstop retention for the dated files, a few days beyond what the logger itself
// enforces, so this only ever catches what rotation missed.
const DATED_LOG_MAX_AGE_DAYS = { app: 21, debug: 7, error: 45 };

// Cleanup interval (every 30 minutes)
const CLEANUP_INTERVAL_MS = 30 * 60 * 1000;

// app-2026-08-13.log, debug-2026-08-13.log.1, error-2026-08-13.log
const DATED_LOG_RE = /^(app|debug|error)-(\d{4}-\d{2}-\d{2})\.log(\.\d+)?$/;

/**
 * True for anything utils/logger.js owns - the dated files and the hidden -audit.json
 * bookkeeping winston-daily-rotate-file keeps beside them.
 */
function isLoggerOwned(fileName) {
  return DATED_LOG_RE.test(fileName) || /-audit\.json$/.test(fileName);
}

class DiskCleanupService {
  constructor() {
    this.cleanupInterval = null;
    this.isRunning = false;
  }

  /**
   * Initialize the cleanup service with periodic runs
   */
  async initialize() {
    // Run immediate cleanup on startup
    await this.runCleanup();

    // Schedule periodic cleanup
    this.cleanupInterval = setInterval(async () => {
      await this.runCleanup();
    }, CLEANUP_INTERVAL_MS);

    logger.info('disk cleanup ready', { everyMin: CLEANUP_INTERVAL_MS / 60000, logDir: LOG_DIR });
  }

  /**
   * Run all cleanup tasks
   */
  async runCleanup() {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;

    return runContext.runWith({ runId: runContext.newRunId('CLEANUP') }, async () => {
      const startTime = Date.now();

      try {
        const tempResult = await this.cleanupTempFiles();
        const logResult = await this.cleanupLogs();

        // Silent when there was nothing to do - this fires 48 times a day.
        if (tempResult.deleted > 0 || logResult.trimmed > 0 || logResult.expired > 0) {
          logger.info('disk cleanup done', {
            tempDeleted: tempResult.deleted,
            logsTrimmed: logResult.trimmed,
            logsExpired: logResult.expired,
            ms: Date.now() - startTime
          });
        }
      } catch (error) {
        logger.error('disk cleanup failed', error);
      } finally {
        this.isRunning = false;
      }
    });
  }

  /**
   * Clean up old temp files (orphaned from failed processing)
   */
  async cleanupTempFiles() {
    const result = { deleted: 0, errors: 0 };

    try {
      // Ensure temp directory exists
      await fs.mkdir(TEMP_DIR, { recursive: true });

      const files = await fs.readdir(TEMP_DIR);
      const now = Date.now();

      for (const file of files) {
        try {
          const filePath = path.join(TEMP_DIR, file);
          const stats = await fs.stat(filePath);

          // Delete files older than max age
          if (now - stats.mtimeMs > TEMP_MAX_AGE_MS) {
            await fs.unlink(filePath);
            result.deleted++;
          }
        } catch (err) {
          result.errors++;
        }
      }
    } catch (error) {
      // Directory might not exist, that's OK
      if (error.code !== 'ENOENT') {
        logger.warn('temp cleanup error', { err: error.message });
      }
    }

    return result;
  }

  /**
   * Expire dated logs rotation missed; size-cap PM2's capture files.
   */
  async cleanupLogs() {
    const result = { trimmed: 0, expired: 0, errors: 0 };

    try {
      const files = await fs.readdir(LOG_DIR);

      for (const file of files) {
        try {
          const dated = DATED_LOG_RE.exec(file);

          if (dated) {
            const maxAgeDays = DATED_LOG_MAX_AGE_DAYS[dated[1]];
            const ageDays = (Date.now() - Date.parse(`${dated[2]}T00:00:00Z`)) / 86400000;
            if (ageDays > maxAgeDays) {
              await fs.unlink(path.join(LOG_DIR, file));
              result.expired++;
            }
            continue;
          }

          // The logger's own bookkeeping - leave it alone.
          if (isLoggerOwned(file)) continue;
          if (!file.endsWith('.log')) continue;

          const filePath = path.join(LOG_DIR, file);
          const stats = await fs.stat(filePath);

          if (stats.size > MAX_LOG_SIZE_BYTES) {
            await this.trimToTail(filePath, stats.size);
            result.trimmed++;
            logger.info('log trimmed', {
              file,
              fromMB: Math.round(stats.size / 1048576),
              toMB: Math.round(KEEP_TAIL_BYTES / 1048576)
            });
          }
        } catch (err) {
          result.errors++;
        }
      }
    } catch (error) {
      // Log directory might not exist or not be accessible
      if (error.code !== 'ENOENT' && error.code !== 'EACCES') {
        logger.warn('log cleanup error', { err: error.message });
      }
    }

    return result;
  }

  /**
   * Keep the last KEEP_TAIL_BYTES of a file, discarding everything before it.
   *
   * Streamed rather than readFile -> slice -> writeFile: the old implementation
   * allocated the entire 100MB+ file as a JS string inside a worker capped at 1536MB of
   * heap, which is a memory spike at exactly the moment the box is already under
   * pressure. The first partial line is dropped so the result still parses line by line.
   */
  async trimToTail(filePath, size) {
    const tmpPath = `${filePath}.trim.${process.pid}`;

    await new Promise((resolve, reject) => {
      const read = fsSync.createReadStream(filePath, { start: size - KEEP_TAIL_BYTES });
      const write = fsSync.createWriteStream(tmpPath);

      let atLineStart = false;
      read.on('data', (chunk) => {
        if (atLineStart) {
          write.write(chunk);
          return;
        }
        const nl = chunk.indexOf(0x0a);
        if (nl === -1) return; // still inside the partial first line
        atLineStart = true;
        write.write(chunk.subarray(nl + 1));
      });

      read.on('error', reject);
      write.on('error', reject);
      read.on('end', () => write.end());
      write.on('finish', resolve);
    });

    await fs.rename(tmpPath, filePath);
  }

  /**
   * Get current disk usage stats
   */
  async getDiskStats() {
    const stats = {
      tempFiles: 0,
      tempSizeBytes: 0,
      logSizeBytes: 0
    };

    try {
      const tempFiles = await fs.readdir(TEMP_DIR);
      stats.tempFiles = tempFiles.length;

      for (const file of tempFiles) {
        try {
          const filePath = path.join(TEMP_DIR, file);
          const fileStats = await fs.stat(filePath);
          stats.tempSizeBytes += fileStats.size;
        } catch (err) {}
      }
    } catch (error) {}

    try {
      const logFiles = await fs.readdir(LOG_DIR);
      for (const file of logFiles) {
        if (file.endsWith('.log')) {
          try {
            const filePath = path.join(LOG_DIR, file);
            const fileStats = await fs.stat(filePath);
            stats.logSizeBytes += fileStats.size;
          } catch (err) {}
        }
      }
    } catch (error) {}

    return {
      tempFiles: stats.tempFiles,
      tempSizeMB: (stats.tempSizeBytes / 1024 / 1024).toFixed(1),
      logSizeMB: (stats.logSizeBytes / 1024 / 1024).toFixed(1)
    };
  }

  /**
   * Force immediate cleanup (for manual trigger).
   *
   * Reachable from the CLI (document-register/index.js). It deletes every temp file
   * outright, including ones a scan is actively writing - that hazard predates this
   * change and is unrelated to logging.
   */
  async forceCleanup() {
    logger.info('disk cleanup: force triggered');

    // Delete ALL temp files
    try {
      const files = await fs.readdir(TEMP_DIR);
      for (const file of files) {
        await fs.unlink(path.join(TEMP_DIR, file)).catch(() => {});
      }
      logger.info('disk cleanup: temp files deleted', { count: files.length });
    } catch (error) {}

    // Truncate PM2's capture files only. The dated app/debug/error logs are the record
    // of what the system has been doing, and "free some disk" is never a good enough
    // reason to erase this morning's run.
    try {
      const files = await fs.readdir(LOG_DIR);
      let truncated = 0;
      for (const file of files) {
        if (!file.endsWith('.log') || isLoggerOwned(file)) continue;
        await fs.truncate(path.join(LOG_DIR, file), 0).catch(() => {});
        truncated++;
      }
      logger.info('disk cleanup: PM2 capture logs truncated', { count: truncated });
    } catch (error) {}
  }

  /**
   * Stop the cleanup service
   */
  stop() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }
}

module.exports = new DiskCleanupService();
