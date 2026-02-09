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
     * Tesseract cannot read PDFs directly - must convert to images first using pdftoppm
     * @param {string} pdfPath - Path to PDF file
     * @param {number} maxPages - Maximum pages to OCR (cost control)
     * @returns {Promise<string>} Extracted text
     */
    async extractTextViaOCR(pdfPath, maxPages = 10) {
        const tempImages = [];
        try {
            // SAFETY CHECK: Skip OCR if low on memory
            const memUsage = process.memoryUsage();
            const rssMemMB = memUsage.rss / 1024 / 1024;
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
            const tempDir = path.dirname(pdfPath);
            const baseName = path.basename(pdfPath, '.pdf');
            const imagePrefix = path.join(tempDir, `ocr_${baseName}`);
            
            logger.info(`📸 Running OCR on ${fileName} (${estimatedFreeMB.toFixed(0)}MB free, max ${maxPages} pages)`);

            // Step 1: Convert PDF to PNG images using pdftoppm (from poppler-utils)
            // -png: output PNG images
            // -r 150: 150 DPI (balance between quality and speed)
            // -l maxPages: limit to first N pages
            try {
                await execFileAsync(
                    'pdftoppm',
                    ['-png', '-r', '150', '-l', String(maxPages), pdfPath, imagePrefix],
                    { timeout: 60000 } // 60s timeout for conversion
                );
            } catch (pdfError) {
                // pdftoppm not available or failed - skip OCR gracefully
                logger.warn(`📸 PDF to image conversion failed: ${pdfError.message.substring(0, 100)}`);
                return '';
            }

            // Step 2: Find all generated images
            const files = fs.readdirSync(tempDir);
            const imageFiles = files
                .filter(f => f.startsWith(`ocr_${baseName}`) && f.endsWith('.png'))
                .sort()
                .map(f => path.join(tempDir, f));
            
            if (imageFiles.length === 0) {
                logger.warn(`📸 No images generated from ${fileName}`);
                return '';
            }

            tempImages.push(...imageFiles);
            logger.debug(`📸 Converted ${fileName} to ${imageFiles.length} images`);

            // Step 3: Run Tesseract on each image and combine results
            let combinedText = '';
            for (let i = 0; i < imageFiles.length; i++) {
                try {
                    const { stdout } = await execFileAsync(
                        this.tesseractPath,
                        [imageFiles[i], 'stdout', '-l', 'eng', '--psm', '3'],
                        { maxBuffer: 10 * 1024 * 1024, timeout: 30000 } // 30s per page
                    );
                    combinedText += (stdout || '') + '\n';
                } catch (tessError) {
                    logger.warn(`📸 OCR failed on page ${i + 1}: ${tessError.message.substring(0, 50)}`);
                }
            }

            const ocrText = combinedText.trim();
            const charCount = ocrText.length;

            if (charCount === 0) {
                logger.warn(`📸 OCR returned no text from ${fileName}`);
                return '';
            }

            logger.info(`📸 OCR extracted ${charCount} chars from ${fileName} (${imageFiles.length} pages)`);
            return ocrText;
        } catch (error) {
            logger.warn(`📸 OCR failed on ${pdfPath}: ${error.message}`);
            return ''; // Return empty string on failure, don't crash
        } finally {
            // Clean up temp images
            for (const img of tempImages) {
                try {
                    if (fs.existsSync(img)) fs.unlinkSync(img);
                } catch (e) { /* ignore cleanup errors */ }
            }
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
