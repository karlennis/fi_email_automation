const OpenAI = require('openai');
const fs = require('fs').promises;
const path = require('path');
const { PDFDocument } = require('pdf-lib');
const logger = require('../utils/logger');

class AIVisionService {
  constructor() {
    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });
    this.model = 'gpt-4o-mini'; // Has vision capabilities
  }

  /**
   * Analyze PDF document to determine if it's an acoustic/noise assessment report
   * @param {Buffer} pdfBuffer - PDF file buffer
   * @param {string} fileName - Original filename for context
   * @returns {Promise<{isAcoustic: boolean, confidence: number, reason: string, reportType: string|null}>}
   */
  async analyzeDocumentType(pdfBuffer, fileName) {
    try {
      logger.info(`🔍 AI Vision analyzing document: ${fileName}`);

      // Extract first page as image
      const firstPageImage = await this.extractFirstPageAsImage(pdfBuffer);

      // Prepare the vision prompt
      const prompt = this.buildAcousticDetectionPrompt(fileName);

      // Call OpenAI Vision API
      const response = await this.openai.chat.completions.create({
        model: this.model,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: prompt
              },
              {
                type: 'image_url',
                image_url: {
                  url: `data:image/png;base64,${firstPageImage}`,
                  detail: 'low' // Use 'low' for cost efficiency
                }
              }
            ]
          }
        ],
        max_tokens: 500,
        temperature: 0.1 // Lower temperature for more consistent classification
      });

      const result = response.choices[0].message.content;
      logger.info(`📊 AI Vision result: ${result}`);

      // Parse the structured response
      return this.parseVisionResponse(result);

    } catch (error) {
      logger.error(`❌ AI Vision analysis failed for ${fileName}:`, error);
      return {
        isAcoustic: false,
        confidence: 0,
        reason: `Vision analysis error: ${error.message}`,
        reportType: null
      };
    }
  }

  /**
   * Extract first page of PDF and convert to base64 PNG
   */
  async extractFirstPageAsImage(pdfBuffer) {
    try {
      // Load PDF
      const pdfDoc = await PDFDocument.load(pdfBuffer);

      // Create new PDF with only first page
      const newPdf = await PDFDocument.create();
      const [firstPage] = await newPdf.copyPages(pdfDoc, [0]);
      newPdf.addPage(firstPage);

      // Save as buffer
      const firstPageBuffer = await newPdf.save();

      // Convert PDF to PNG using pdf-to-img library (or similar)
      // For now, we'll use a simplified approach with pdf-lib
      // In production, consider using 'pdf-to-img' or 'pdf2pic' libraries

      // Note: This is a placeholder. You'll need to install and use a PDF-to-image library
      // For example: npm install pdf-to-img
      // const { pdf } = require('pdf-to-img');
      // const pngBuffer = await convertPdfToPng(firstPageBuffer);

      // For now, return the PDF buffer as base64 (OpenAI can handle PDF directly)
      return firstPageBuffer.toString('base64');

    } catch (error) {
      logger.error('Error extracting first page:', error);
      throw error;
    }
  }

  /**
   * Build the prompt for acoustic report detection
   */
  buildAcousticDetectionPrompt(fileName) {
    return `Analyze this document (filename: "${fileName}") and determine if it is one of the following:

1. An ACOUSTIC REPORT or NOISE IMPACT ASSESSMENT (e.g., noise survey, sound level assessment, acoustic study)
2. A FURTHER INFORMATION REQUEST from a planning authority specifically requesting an acoustic/noise assessment
3. Neither of the above

Respond in the following JSON format:
{
  "classification": "ACOUSTIC_REPORT" | "FI_REQUEST_ACOUSTIC" | "OTHER",
  "confidence": 0.0-1.0,
  "reasoning": "brief explanation",
  "keyIndicators": ["list of key terms or elements found"]
}

Consider:
- Document title and headers
- Author/consultant name (common acoustic consultants: AWN, AECOM, Arup, Noise Consultants, etc.)
- Presence of noise measurement data, sound level tables, or acoustic terminology
- References to BS 4142, ISO 1996, WHO guidelines, or Irish noise guidance
- Planning authority letterhead requesting acoustic information
- Professional formatting typical of acoustic assessment reports

Be conservative: only classify as ACOUSTIC_REPORT or FI_REQUEST_ACOUSTIC if you have strong evidence.`;
  }

  /**
   * Parse the AI Vision API response
   */
  parseVisionResponse(responseText) {
    try {
      // Try to extract JSON from response
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('No JSON found in response');
      }

      const parsed = JSON.parse(jsonMatch[0]);

      const isAcoustic = ['ACOUSTIC_REPORT', 'FI_REQUEST_ACOUSTIC'].includes(parsed.classification);
      const reportType = parsed.classification === 'ACOUSTIC_REPORT' ? 'acoustic_report' :
                        parsed.classification === 'FI_REQUEST_ACOUSTIC' ? 'fi_request_acoustic' :
                        null;

      return {
        isAcoustic,
        confidence: parsed.confidence || 0,
        reason: parsed.reasoning || 'No reasoning provided',
        reportType,
        keyIndicators: parsed.keyIndicators || []
      };

    } catch (error) {
      logger.warn('Failed to parse vision response as JSON, attempting text analysis:', error);

      // Fallback: simple text analysis
      const lowerText = responseText.toLowerCase();
      const isAcoustic = lowerText.includes('acoustic') || lowerText.includes('noise');

      return {
        isAcoustic,
        confidence: isAcoustic ? 0.5 : 0.1,
        reason: 'Fallback text analysis: ' + responseText.substring(0, 200),
        reportType: isAcoustic ? 'acoustic_report' : null,
        keyIndicators: []
      };
    }
  }

  /**
   * Batch analyze multiple documents
   */
  async analyzeDocumentBatch(documents) {
    const results = [];

    for (const doc of documents) {
      try {
        const result = await this.analyzeDocumentType(doc.buffer, doc.fileName);
        results.push({
          fileName: doc.fileName,
          projectId: doc.projectId,
          ...result
        });

        // Add small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 1000));

      } catch (error) {
        logger.error(`Failed to analyze ${doc.fileName}:`, error);
        results.push({
          fileName: doc.fileName,
          projectId: doc.projectId,
          isAcoustic: false,
          confidence: 0,
          reason: `Analysis failed: ${error.message}`,
          reportType: null
        });
      }
    }

    return results;
  }
}

module.exports = new AIVisionService();
