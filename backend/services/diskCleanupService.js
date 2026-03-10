/**
 * Disk Cleanup Service
 * 
 * Automatically cleans up temp files and manages log rotation
 * to prevent disk space issues.
 */

const fs = require('fs').promises;
const path = require('path');
const logger = require('../utils/logger');

const TEMP_DIR = path.join(__dirname, '..', 'temp');
const LOG_DIR = '/var/log/fi_email';

// Max age for temp files (1 hour - they should be deleted immediately after processing)
const TEMP_MAX_AGE_MS = 60 * 60 * 1000;

// Max log file size (100MB per file)
const MAX_LOG_SIZE_BYTES = 100 * 1024 * 1024;

// Cleanup interval (every 30 minutes)
const CLEANUP_INTERVAL_MS = 30 * 60 * 1000;

class DiskCleanupService {
  constructor() {
    this.cleanupInterval = null;
    this.isRunning = false;
  }

  /**
   * Initialize the cleanup service with periodic runs
   */
  async initialize() {
    logger.info('🧹 Initializing Disk Cleanup Service...');

    // Run immediate cleanup on startup
    await this.runCleanup();

    // Schedule periodic cleanup
    this.cleanupInterval = setInterval(async () => {
      await this.runCleanup();
    }, CLEANUP_INTERVAL_MS);

    logger.info('✅ Disk Cleanup Service initialized (runs every 30 minutes)');
  }

  /**
   * Run all cleanup tasks
   */
  async runCleanup() {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;
    const startTime = Date.now();

    try {
      const tempResult = await this.cleanupTempFiles();
      const logResult = await this.cleanupLogs();

      const duration = Date.now() - startTime;
      
      if (tempResult.deleted > 0 || logResult.truncated > 0) {
        logger.info(`🧹 Cleanup complete (${duration}ms): ${tempResult.deleted} temp files, ${logResult.truncated} logs truncated`);
      }
    } catch (error) {
      logger.error('Cleanup error:', error.message);
    } finally {
      this.isRunning = false;
    }
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
        logger.warn('Temp cleanup error:', error.message);
      }
    }

    return result;
  }

  /**
   * Truncate log files that exceed max size
   */
  async cleanupLogs() {
    const result = { truncated: 0, errors: 0 };

    try {
      const files = await fs.readdir(LOG_DIR);

      for (const file of files) {
        if (!file.endsWith('.log')) continue;

        try {
          const filePath = path.join(LOG_DIR, file);
          const stats = await fs.stat(filePath);

          // Truncate files larger than max size
          if (stats.size > MAX_LOG_SIZE_BYTES) {
            // Keep last 10MB of logs
            const keepBytes = 10 * 1024 * 1024;
            const content = await fs.readFile(filePath, 'utf8');
            const truncatedContent = content.slice(-keepBytes);
            await fs.writeFile(filePath, truncatedContent);
            result.truncated++;
            logger.info(`📝 Truncated ${file} (${(stats.size / 1024 / 1024).toFixed(1)}MB → ${(keepBytes / 1024 / 1024).toFixed(1)}MB)`);
          }
        } catch (err) {
          result.errors++;
        }
      }
    } catch (error) {
      // Log directory might not exist or not be accessible
      if (error.code !== 'ENOENT' && error.code !== 'EACCES') {
        logger.warn('Log cleanup error:', error.message);
      }
    }

    return result;
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
   * Force immediate cleanup (for manual trigger)
   */
  async forceCleanup() {
    logger.info('🧹 Force cleanup triggered');
    
    // Delete ALL temp files
    try {
      const files = await fs.readdir(TEMP_DIR);
      for (const file of files) {
        await fs.unlink(path.join(TEMP_DIR, file)).catch(() => {});
      }
      logger.info(`🧹 Deleted ${files.length} temp files`);
    } catch (error) {}

    // Truncate all logs
    try {
      const files = await fs.readdir(LOG_DIR);
      for (const file of files) {
        if (file.endsWith('.log')) {
          await fs.truncate(path.join(LOG_DIR, file), 0).catch(() => {});
        }
      }
      logger.info('🧹 Truncated all log files');
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
