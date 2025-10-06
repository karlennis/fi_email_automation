const fs = require('fs').promises;
const path = require('path');
const pdf = require('pdf-parse');
const winston = require('winston');
const { spawn } = require('child_process');
const crypto = require('crypto');

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

class DocumentProcessor {
  constructor() {
    this.ocrDir = process.env.TMP_OCR_DIR || './temp/ocr';
    this.maxTextChars = 8000;
    this.ocrTimeout = parseInt(process.env.OCR_TIMEOUT) || 1000;
    this.ensureDirectories();
  }

  async ensureDirectories() {
    try {
      await fs.mkdir(this.ocrDir, { recursive: true });
    } catch (error) {
      logger.error('Error creating OCR directory:', error);
    }
  }

  /**
   * Generate SHA256 hash for file content
   */
  generateFileHash(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
  }

  /**
   * OCR PDF if needed, with caching
   */
  async ocrIfNeeded(pdfPath) {
    try {
      const pdfBuffer = await fs.readFile(pdfPath);
      const digest = this.generateFileHash(pdfBuffer);
      const ocrPath = path.join(this.ocrDir, `${digest}.pdf`);

      // Check if OCR'd version already exists
      try {
        await fs.access(ocrPath);
        logger.info(`Using cached OCR version: ${ocrPath}`);
        return ocrPath;
      } catch {
        // OCR'd version doesn't exist, create it
        logger.info(`Creating OCR version for: ${path.basename(pdfPath)}`);
      }

      const tmpPath = ocrPath + '.tmp';

      try {
        // Run OCR using ocrmypdf
        await this.runOCR(pdfPath, tmpPath);
        await fs.rename(tmpPath, ocrPath);
        logger.info(`OCR completed: ${ocrPath}`);
        return ocrPath;
      } catch (ocrError) {
        logger.warn(`OCR failed for ${pdfPath}, using original:`, ocrError.message);
        // If OCR fails, copy original file
        await fs.copyFile(pdfPath, ocrPath);
        return ocrPath;
      } finally {
        // Clean up temp file if it exists
        try {
          await fs.unlink(tmpPath);
        } catch {}
      }
    } catch (error) {
      logger.error('Error in OCR process:', error);
      throw error;
    }
  }

  /**
   * Run OCR using ocrmypdf
   */
  runOCR(inputPath, outputPath) {
    return new Promise((resolve, reject) => {
      const args = [
        '--skip-text',
        '--output-type', 'pdf',
        '-q',
        inputPath,
        outputPath
      ];

      const child = spawn('ocrmypdf', args, {
        timeout: this.ocrTimeout * 1000
      });

      let stderr = '';

      child.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      child.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`OCR process exited with code ${code}: ${stderr}`));
        }
      });

      child.on('error', (error) => {
        reject(new Error(`Failed to start OCR process: ${error.message}`));
      });
    });
  }

  /**
   * Extract text from PDF
   */
  async extractTextFromPDF(pdfPath) {
    try {
      const pdfBuffer = await fs.readFile(pdfPath);
      const data = await pdf(pdfBuffer);

      // Limit text length to prevent token overflow
      const text = data.text.slice(0, this.maxTextChars);

      logger.info(`Extracted ${text.length} characters from ${path.basename(pdfPath)}`);
      return text;
    } catch (error) {
      logger.error(`Error extracting text from ${pdfPath}:`, error);
      throw error;
    }
  }

  /**
   * Process a single document
   */
  async processDocument(filePath, fileName = null) {
    try {
      const name = fileName || path.basename(filePath);
      logger.info(`Processing document: ${name}`);

      // Step 1: OCR if needed
      const ocrPath = await this.ocrIfNeeded(filePath);

      // Step 2: Extract text
      const text = await this.extractTextFromPDF(ocrPath);

      return {
        fileName: name,
        originalPath: filePath,
        ocrPath: ocrPath,
        text: text,
        textLength: text.length,
        processedAt: new Date().toISOString()
      };

    } catch (error) {
      logger.error(`Error processing document ${fileName || filePath}:`, error);
      throw error;
    }
  }

  /**
   * Process document from buffer (streaming approach - no disk write for original)
   */
  async processDocumentFromBuffer(buffer, fileName) {
    try {
      logger.info(`📄 Processing document from buffer: ${fileName}`);

      // Create temporary file for processing (still needed for OCR)
      const tempPath = path.join(this.ocrDir, `temp_${Date.now()}_${fileName}`);
      await fs.writeFile(tempPath, buffer);

      try {
        // Step 1: OCR if needed
        const ocrPath = await this.ocrIfNeeded(tempPath);

        // Step 2: Extract text
        const text = await this.extractTextFromPDF(ocrPath);

        return {
          fileName: fileName,
          originalPath: null, // No original path since we used buffer
          ocrPath: ocrPath,
          text: text,
          textLength: text.length,
          processedAt: new Date().toISOString(),
          processedFromBuffer: true
        };

      } finally {
        // Clean up temporary file
        try {
          await fs.unlink(tempPath);
        } catch (cleanupError) {
          logger.warn(`Error cleaning up temp file ${tempPath}:`, cleanupError);
        }
      }

    } catch (error) {
      logger.error(`Error processing document buffer ${fileName}:`, error);
      throw error;
    }
  }

  /**
   * Process multiple documents
   */
  async processDocuments(filePaths) {
    const results = [];
    const errors = [];

    for (const filePath of filePaths) {
      try {
        const result = await this.processDocument(filePath);
        results.push(result);
      } catch (error) {
        logger.error(`Failed to process ${filePath}:`, error);
        errors.push({
          filePath,
          error: error.message
        });
      }
    }

    return {
      processed: results,
      errors: errors,
      summary: {
        total: filePaths.length,
        successful: results.length,
        failed: errors.length
      }
    };
  }

  /**
   * Clean up old OCR files (older than 7 days)
   */
  async cleanupOCRCache(maxAgeInDays = 7) {
    try {
      const files = await fs.readdir(this.ocrDir);
      const maxAge = maxAgeInDays * 24 * 60 * 60 * 1000; // Convert to milliseconds
      const now = Date.now();

      let cleanedCount = 0;

      for (const file of files) {
        const filePath = path.join(this.ocrDir, file);
        try {
          const stats = await fs.stat(filePath);
          if (now - stats.mtime.getTime() > maxAge) {
            await fs.unlink(filePath);
            cleanedCount++;
          }
        } catch (error) {
          logger.warn(`Error checking/removing file ${filePath}:`, error);
        }
      }

      logger.info(`OCR cache cleanup completed. Removed ${cleanedCount} old files.`);
      return cleanedCount;
    } catch (error) {
      logger.error('Error during OCR cache cleanup:', error);
      throw error;
    }
  }

  /**
   * Get cache statistics
   */
  async getCacheStats() {
    try {
      const files = await fs.readdir(this.ocrDir);
      let totalSize = 0;

      for (const file of files) {
        try {
          const stats = await fs.stat(path.join(this.ocrDir, file));
          totalSize += stats.size;
        } catch (error) {
          // Ignore errors for individual files
        }
      }

      return {
        fileCount: files.length,
        totalSizeBytes: totalSize,
        totalSizeMB: Math.round(totalSize / (1024 * 1024) * 100) / 100,
        cacheDir: this.ocrDir
      };
    } catch (error) {
      logger.error('Error getting cache stats:', error);
      return {
        fileCount: 0,
        totalSizeBytes: 0,
        totalSizeMB: 0,
        cacheDir: this.ocrDir,
        error: error.message
      };
    }
  }
}

module.exports = new DocumentProcessor();
