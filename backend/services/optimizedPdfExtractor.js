const winston = require('winston');
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');

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
 * OptimizedPDFExtractor - Zero-copy PDF text extraction
 * Keeps only one page in memory at a time
 * Explicitly nulls out buffers after use
 * Forces GC periodically
 */
class OptimizedPDFExtractor {
  constructor() {
    this.processedDocuments = 0;
    this.GC_INTERVAL = 5; // Force GC every 5 documents
  }

  /**
   * Extract text from PDF - STREAMING approach
   * - Loads PDF metadata only first
   * - Processes one page at a time
   * - Releases each page immediately after processing
   * - Returns combined text but controlled in size
   */
  async extractTextOptimized(fileBuffer, fileName) {
    let pdfDocument = null;
    const pageTexts = [];
    let totalExtractedChars = 0;

    const MAX_TEXT_CHARS = 32000;
    const memBefore = process.memoryUsage();
    logger.info(
      `📄 PDF Processing Start: ${fileName} - ` +
      `Memory: ${(memBefore.rss / 1024 / 1024).toFixed(0)}MB RSS, ` +
      `${(memBefore.heapUsed / 1024 / 1024).toFixed(0)}MB Heap`
    );

    try {
      // Yield before creating Uint8Array
      await new Promise(resolve => setImmediate(resolve));

      // Create Uint8Array from buffer (required by pdfjs)
      const uint8Array = new Uint8Array(fileBuffer);
      
      // Load PDF
      const loadingTask = pdfjsLib.getDocument({
        data: uint8Array,
        useSystemFonts: true,
        standardFontDataUrl: null
      });

      pdfDocument = await loadingTask.promise;
      const numPages = pdfDocument.numPages;

      const memAfterLoad = process.memoryUsage();
      logger.info(
        `📄 PDF Loaded: ${fileName} (${numPages} pages) - ` +
        `Memory: ${(memAfterLoad.rss / 1024 / 1024).toFixed(0)}MB RSS, ` +
        `${(memAfterLoad.heapUsed / 1024 / 1024).toFixed(0)}MB Heap`
      );

      // Process pages one at a time
      for (let pageNum = 1; pageNum <= numPages; pageNum++) {
        // Stop if we've already extracted enough text
        if (totalExtractedChars >= MAX_TEXT_CHARS) {
          logger.debug(`Stopping page processing at ${pageNum}/${numPages} (${totalExtractedChars} chars collected)`);
          break;
        }

        // Yield to event loop
        await new Promise(resolve => setImmediate(resolve));

        try {
          // Get single page
          const page = await pdfDocument.getPage(pageNum);
          
          // Extract text
          const textContent = await page.getTextContent();
          const pageText = textContent.items
            .map(item => item.str)
            .join(' ')
            .trim();

          // Add to result
          if (pageText.length > 0) {
            pageTexts.push(pageText);
            totalExtractedChars += pageText.length + 1; // +1 for newline
          }

          // Explicitly cleanup page
          if (page.cleanup) {
            await page.cleanup();
          }

          // Force GC every 10 pages for large documents
          if (pageNum % 10 === 0 && global.gc) {
            global.gc();
          }

        } catch (pageError) {
          logger.warn(`⚠️ Error extracting page ${pageNum}: ${pageError.message}`);
          // Continue to next page on error
          continue;
        }
      }

      // Combine pages into final text
      let documentText = pageTexts.join('\n');

      // Enforce max size
      if (documentText.length > MAX_TEXT_CHARS) {
        documentText = documentText.substring(0, MAX_TEXT_CHARS);
      }

      const memAfterText = process.memoryUsage();
      logger.info(
        `📄 PDF Text Extracted: ${fileName} (${documentText.length} chars) - ` +
        `Memory: ${(memAfterText.rss / 1024 / 1024).toFixed(0)}MB RSS, ` +
        `${(memAfterText.heapUsed / 1024 / 1024).toFixed(0)}MB Heap`
      );

      // Cleanup before returning
      await pdfDocument.destroy();
      pdfDocument = null;

      // Explicitly null out arrays
      pageTexts.length = 0;
      
      // Clear uint8Array
      uint8Array.fill(0);
      uint8Array = null;

      // Track processed documents
      this.processedDocuments++;

      // Force GC periodically
      if (this.processedDocuments % this.GC_INTERVAL === 0 && global.gc) {
        global.gc();
        logger.debug(
          `🗑️ Forced GC after ${this.processedDocuments} documents - ` +
          `Memory: ${(process.memoryUsage().rss / 1024 / 1024).toFixed(0)}MB RSS`
        );
      }

      const memAfterCleanup = process.memoryUsage();
      logger.info(
        `📄 PDF Cleanup Complete: ${fileName} - ` +
        `Memory: ${(memAfterCleanup.rss / 1024 / 1024).toFixed(0)}MB RSS, ` +
        `${(memAfterCleanup.heapUsed / 1024 / 1024).toFixed(0)}MB Heap`
      );

      return {
        text: documentText,
        charCount: documentText.length,
        success: true
      };

    } catch (error) {
      logger.error(`❌ Error extracting PDF text from ${fileName}: ${error.message}`);

      // Cleanup on error
      if (pdfDocument) {
        try {
          await pdfDocument.destroy();
        } catch (e) {
          logger.debug(`Error destroying PDF on error cleanup: ${e.message}`);
        }
      }

      return {
        text: '',
        charCount: 0,
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Extract text from DOCX without loading entire file
   */
  async extractDocxOptimized(fileBuffer, fileName) {
    const mammoth = require('mammoth');
    
    const memBefore = process.memoryUsage();
    logger.info(
      `📄 DOCX Processing Start: ${fileName} - ` +
      `Memory: ${(memBefore.rss / 1024 / 1024).toFixed(0)}MB RSS`
    );

    try {
      await new Promise(resolve => setImmediate(resolve));

      const result = await mammoth.extractRawText({ buffer: fileBuffer });
      let documentText = result.value;

      // Enforce max size
      const MAX_TEXT_CHARS = 32000;
      if (documentText.length > MAX_TEXT_CHARS) {
        documentText = documentText.substring(0, MAX_TEXT_CHARS);
      }

      const memAfter = process.memoryUsage();
      logger.info(
        `📄 DOCX Text Extracted: ${fileName} (${documentText.length} chars) - ` +
        `Memory: ${(memAfter.rss / 1024 / 1024).toFixed(0)}MB RSS`
      );

      // Cleanup
      fileBuffer = null;

      this.processedDocuments++;
      if (this.processedDocuments % this.GC_INTERVAL === 0 && global.gc) {
        global.gc();
        logger.debug(`🗑️ Forced GC after ${this.processedDocuments} documents`);
      }

      return {
        text: documentText,
        charCount: documentText.length,
        success: true
      };

    } catch (error) {
      logger.error(`❌ Error extracting DOCX text from ${fileName}: ${error.message}`);
      fileBuffer = null;

      return {
        text: '',
        charCount: 0,
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Get memory usage summary
   */
  getMemorySummary() {
    const mem = process.memoryUsage();
    return {
      rss: `${(mem.rss / 1024 / 1024).toFixed(0)}MB`,
      heapUsed: `${(mem.heapUsed / 1024 / 1024).toFixed(0)}MB`,
      heapTotal: `${(mem.heapTotal / 1024 / 1024).toFixed(0)}MB`,
      processedDocuments: this.processedDocuments
    };
  }

  /**
   * Force cleanup and GC
   */
  forceCleanup() {
    if (global.gc) {
      global.gc();
      logger.info(`🗑️ Manual GC triggered - Memory: ${this.getMemorySummary().rss}`);
    }
  }
}

module.exports = new OptimizedPDFExtractor();
