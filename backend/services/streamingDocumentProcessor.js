const fs = require('fs').promises;
const path = require('path');
const winston = require('winston');
const { Readable } = require('stream');
const ocrService = require('./ocrService');

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
 * StreamingDocumentProcessor - Memory-efficient document processing
 * 
 * Key Design Principles:
 * 1. Process documents in chunks, never loading entire file into memory
 * 2. Stream pages one at a time from PDFs
 * 3. Release buffers immediately after use
 * 4. Use generators for lazy evaluation
 * 5. Process text in segments for AI analysis
 */
class StreamingDocumentProcessor {
  constructor(options = {}) {
    this.maxChunkSize = options.maxChunkSize || 4096;
    this.maxTextChars = options.maxTextChars || 10000;
    this.chunkOverlap = options.chunkOverlap || 200; // Overlap between chunks for context
    this.gcInterval = options.gcInterval || 10; // Force GC every N documents
    this.processedCount = 0;
  }

  /**
   * Extract text from PDF in streaming chunks
   * Yields page text one page at a time
   * Never loads entire document into memory
   */
  async *streamPdfPages(pdfPath) {
    const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
    let pdfDocument = null;
    
    try {
      const fileStream = fs.createReadStream(pdfPath);
      const chunks = [];
      let totalSize = 0;

      // Read file in chunks instead of loading all at once
      for await (const chunk of fileStream) {
        chunks.push(chunk);
        totalSize += chunk.length;
        
        // If chunk buffer gets too large, process what we have
        if (totalSize > 5 * 1024 * 1024) { // 5MB chunks
          logger.warn(`Large PDF detected: ${pdfPath} (${totalSize / 1024 / 1024}MB), processing in segments`);
          break;
        }
      }

      // Combine chunks into single buffer
      const uint8Array = new Uint8Array(Buffer.concat(chunks));
      chunks.length = 0; // Clear chunks array

      // Load PDF
      const loadingTask = pdfjsLib.getDocument({
        data: uint8Array,
        useSystemFonts: true,
        standardFontDataUrl: null
      });

      pdfDocument = await loadingTask.promise;
      const numPages = pdfDocument.numPages;

      logger.info(`📄 PDF Loaded: ${path.basename(pdfPath)} (${numPages} pages)`);

      // Stream pages one at a time
      for (let pageNum = 1; pageNum <= numPages; pageNum++) {
        try {
          // Yield to event loop
          await new Promise(resolve => setImmediate(resolve));

          const page = await pdfDocument.getPage(pageNum);
          const textContent = await page.getTextContent();
          const pageText = textContent.items
            .map(item => item.str)
            .join(' ')
            .trim();

          // Clean up page object
          await page.cleanup?.();

          yield {
            pageNum,
            text: pageText,
            isLast: pageNum === numPages
          };

          // Force GC every 20 pages for large documents
          if (pageNum % 20 === 0 && global.gc) {
            global.gc();
          }
        } catch (pageError) {
          logger.warn(`Error extracting page ${pageNum}: ${pageError.message}`);
          yield {
            pageNum,
            text: '',
            error: pageError.message,
            isLast: pageNum === numPages
          };
        }
      }

      // Cleanup
      await pdfDocument.destroy();
      uint8Array = null;

    } catch (error) {
      logger.error(`Error streaming PDF pages from ${pdfPath}:`, error);
      throw error;
    }
  }

  /**
   * Extract text from PDF with streaming + chunking
   * Returns text in manageable chunks suitable for AI processing
   * Memory usage stays constant regardless of PDF size
   */
  async *streamPdfTextChunks(pdfPath) {
    let accumulatedText = '';
    let pageCount = 0;

    try {
      for await (const pageData of this.streamPdfPages(pdfPath)) {
        if (pageData.error) {
          logger.warn(`Page ${pageData.pageNum} failed: ${pageData.error}`);
          continue;
        }

        accumulatedText += pageData.text + '\n';
        pageCount++;

        // When accumulated text reaches chunk size, yield it
        while (accumulatedText.length > this.maxChunkSize) {
          const chunk = accumulatedText.substring(0, this.maxChunkSize);
          
          // Find last complete word to avoid breaking mid-word
          const lastSpace = chunk.lastIndexOf(' ');
          if (lastSpace > 0) {
            const completeChunk = chunk.substring(0, lastSpace);
            accumulatedText = 
              accumulatedText.substring(lastSpace + 1);

            yield {
              text: completeChunk,
              pageNum: pageCount,
              isComplete: false
            };
          } else {
            break;
          }

          // Yield to event loop
          await new Promise(resolve => setImmediate(resolve));
        }
      }

      // Yield final chunk
      if (accumulatedText.length > 0) {
        yield {
          text: accumulatedText,
          pageNum: pageCount,
          isComplete: true
        };
      }

      logger.info(`✅ Extracted ${pageCount} pages from ${path.basename(pdfPath)}`);

    } catch (error) {
      logger.error(`Error streaming PDF chunks from ${pdfPath}:`, error);
      throw error;
    }
  }

  /**
   * Extract full text with memory limits
   * Combines chunks into final text without exceeding maxTextChars
   */
  async extractTextWithStreamingAndLimits(pdfPath, maxChars = this.maxTextChars) {
    let fullText = '';
    let truncated = false;

    try {
      for await (const chunkData of this.streamPdfTextChunks(pdfPath)) {
        if (fullText.length + chunkData.text.length > maxChars) {
          // Only add what fits
          const remaining = maxChars - fullText.length;
          if (remaining > 0) {
            fullText += chunkData.text.substring(0, remaining);
          }
          truncated = true;
          break;
        }

        fullText += chunkData.text;

        // Yield periodically
        if (chunkData.isComplete) {
          await new Promise(resolve => setImmediate(resolve));
        }
      }

      if (truncated) {
        logger.warn(`Text truncated to ${maxChars} chars for ${path.basename(pdfPath)}`);
      }

      // OCR FALLBACK: If text extraction insufficient, try OCR
      if (ocrService.shouldUseOCR(fullText)) {
        logger.info(`📸 Streaming extraction insufficient (${fullText.length} chars), attempting OCR fallback...`);
        try {
          const ocrText = await ocrService.extractTextViaOCR(pdfPath);
          if (ocrText && ocrText.length > fullText.length) {
            logger.info(`📸 OCR recovered ${ocrText.length} chars (vs ${fullText.length} from PDF streaming)`);
            fullText = ocrText;
            if (fullText.length > maxChars) {
              fullText = fullText.substring(0, maxChars);
            }
          }
        } catch (ocrError) {
          logger.debug(`📸 OCR fallback failed: ${ocrError.message}`);
        }
      }

      return {
        text: fullText,
        charCount: fullText.length,
        truncated,
        isValid: fullText.length >= 100
      };

    } catch (error) {
      logger.error(`Error extracting text from ${pdfPath}:`, error);
      return {
        text: '',
        charCount: 0,
        error: error.message,
        isValid: false
      };
    }
  }

  /**
   * Process document with memory cleanup
   * Call this after processing each document to clean up
   */
  async processDocument(pdfPath, processor) {
    try {
      const result = await processor(pdfPath);
      
      this.processedCount++;

      // Force GC periodically
      if (this.processedCount % this.gcInterval === 0 && global.gc) {
        global.gc();
        logger.debug(`🗑️ Forced GC after ${this.processedCount} documents`);
      }

      return result;
    } catch (error) {
      logger.error(`Error processing document ${pdfPath}:`, error);
      throw error;
    }
  }

  /**
   * Extract metadata from PDF without loading full content
   * Useful for quick checks before full processing
   */
  async getMetadata(pdfPath) {
    const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');

    try {
      const stat = await fs.stat(pdfPath);
      const fileSize = stat.size;

      // Only read first few KB for metadata
      const buffer = Buffer.alloc(Math.min(fileSize, 50 * 1024));
      const fd = await fs.open(pdfPath, 'r');
      await fd.read(buffer, 0, buffer.length, 0);
      await fd.close();

      const uint8Array = new Uint8Array(buffer);
      const loadingTask = pdfjsLib.getDocument({
        data: uint8Array,
        useSystemFonts: true,
        standardFontDataUrl: null
      });

      const pdfDocument = await loadingTask.promise;
      const metadata = await pdfDocument.getMetadata();
      const numPages = pdfDocument.numPages;

      await pdfDocument.destroy();
      buffer.fill(0);
      uint8Array.fill(0);

      return {
        numPages,
        fileSize,
        metadata: metadata?.metadata || {}
      };
    } catch (error) {
      logger.error(`Error getting metadata for ${pdfPath}:`, error);
      return {
        numPages: 0,
        fileSize: 0,
        error: error.message
      };
    }
  }
}

module.exports = StreamingDocumentProcessor;
