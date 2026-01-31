const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

const execFileAsync = promisify(execFile);

/**
 * OCR Service - Falls back to Tesseract when PDF text extraction is insufficient
 * Used for scanned documents that contain images instead of text
 */
class OCRService {
    constructor() {
        this.minCharThreshold = parseInt(process.env.OCR_MIN_CHAR_THRESHOLD || '100');
        this.tesseractPath = process.env.TESSERACT_PATH || 'tesseract';
    }

    /**
     * Check if text extraction looks insufficient (likely a scanned image)
     * @param {string} extractedText - Text extracted from PDF
     * @returns {boolean} True if OCR should be attempted
     */
    shouldUseOCR(extractedText) {
        if (!extractedText) return true;
        
        const charCount = extractedText.trim().length;
        const lineCount = extractedText.split('\n').length;
        
        // Use OCR if:
        // 1. Very little text was extracted
        // 2. Or suspiciously few lines (likely image-based)
        const needsOCR = charCount < this.minCharThreshold || (lineCount < 3 && charCount < 500);
        
        if (needsOCR && charCount > 0) {
            logger.debug(`📸 OCR suggested: ${charCount} chars, ${lineCount} lines (threshold: ${this.minCharThreshold})`);
        }
        
        return needsOCR;
    }

    /**
     * Extract text from PDF using Tesseract OCR
     * @param {string} pdfPath - Path to PDF file
     * @param {number} maxPages - Maximum pages to OCR (cost control)
     * @returns {Promise<string>} Extracted text
     */
    async extractTextViaOCR(pdfPath, maxPages = 10) {
        try {
            // SAFETY CHECK: Skip OCR if low on memory
            const memUsage = process.memoryUsage();
            const rssMemMB = memUsage.rss / 1024 / 1024;
            const heapUsedMB = memUsage.heapUsed / 1024 / 1024;
            const minFreeMemMB = 512; // Require 512MB free for OCR safety
            const totalMemMB = 4096; // System total (adjust if needed)
            const estimatedFreeMB = totalMemMB - rssMemMB;

            if (estimatedFreeMB < minFreeMemMB) {
                logger.warn(`📸 Skipping OCR: Low memory (${rssMemMB.toFixed(0)}MB RSS, only ${estimatedFreeMB.toFixed(0)}MB free)`);
                return '';
            }

            if (!fs.existsSync(pdfPath)) {
                throw new Error(`PDF file not found: ${pdfPath}`);
            }

            const fileName = path.basename(pdfPath);
            logger.info(`📸 Running Tesseract OCR on ${fileName} (${estimatedFreeMB.toFixed(0)}MB free, max ${maxPages} pages)`);

            // Tesseract command: convert PDF to text
            // Using input directly without page range (Tesseract handles multi-page PDFs)
            const { stdout, stderr } = await execFileAsync(
                this.tesseractPath,
                [pdfPath, 'stdout', '-l', 'eng', '--psm', '3'],
                { maxBuffer: 10 * 1024 * 1024, timeout: 60000 } // 10MB buffer, 60s timeout
            );

            if (stderr && stderr.includes('Error')) {
                logger.warn(`⚠️ Tesseract warning: ${stderr.substring(0, 200)}`);
            }

            const ocrText = (stdout || '').trim();
            const charCount = ocrText.length;

            if (charCount === 0) {
                logger.warn(`📸 OCR returned no text from ${fileName}`);
                return '';
            }

            logger.info(`📸 OCR extracted ${charCount} chars from ${fileName}`);
            return ocrText;
        } catch (error) {
            logger.warn(`📸 OCR failed on ${pdfPath}: ${error.message}`);
            return ''; // Return empty string on failure, don't crash
        }
    }

    /**
     * Intelligently extract text: try normal extraction first, fallback to OCR
     * @param {string} extractedText - Text from normal PDF extraction
     * @param {string} pdfPath - Path to PDF for OCR fallback
     * @returns {Promise<string>} Best available text
     */
    async extractWithFallback(extractedText, pdfPath) {
        // If normal extraction got good text, use it
        if (extractedText && extractedText.trim().length >= this.minCharThreshold) {
            return extractedText;
        }

        // Otherwise try OCR
        logger.info(`🔄 Normal extraction insufficient (${(extractedText || '').length} chars), trying OCR...`);
        const ocrText = await this.extractTextViaOCR(pdfPath);

        // Return OCR text if successful, otherwise return original (even if short)
        return ocrText || extractedText || '';
    }

    /**
     * Check if Tesseract is available on system
     * @returns {Promise<boolean>}
     */
    async isAvailable() {
        try {
            await execFileAsync(this.tesseractPath, ['--version']);
            logger.info('✅ Tesseract OCR is available');
            return true;
        } catch (error) {
            logger.warn('⚠️ Tesseract OCR not available - skipping OCR features');
            return false;
        }
    }
}

module.exports = new OCRService();
