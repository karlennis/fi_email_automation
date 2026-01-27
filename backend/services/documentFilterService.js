const logger = require('../utils/logger');
const fiDetectionService = require('./fiDetectionService');
const aiVisionService = require('./aiVisionService');

class DocumentFilterService {
  constructor() {
    // Stage 1: Filename patterns for acoustic reports
    this.acousticFilenamePatterns = [
      // Direct acoustic/noise terms
      /acoustic/i,
      /noise/i,
      /sound/i,
      /vibration/i,

      // Report type indicators
      /nia/i,  // Noise Impact Assessment
      /nois.*assess/i,
      /acoust.*assess/i,
      /acoust.*report/i,
      /noise.*report/i,
      /sound.*survey/i,

      // Common acoustic consultant codes/abbreviations
      /\bawn\b/i,  // AWN Consulting
      /aecom.*acoustic/i,
      /arup.*acoustic/i,
      /envir.*noise/i,

      // Technical terms often in acoustic report filenames
      /\bdb(a)?\b/i,  // decibels
      /bs.?4142/i,    // British Standard for industrial noise
      /iso.?1996/i    // ISO standard for environmental noise
    ];

    // Negative patterns that suggest NOT an acoustic report
    this.negativeFilenamePatterns = [
      /construction.*noise.*management/i,  // Construction noise plans (operational, not assessment)
      /appointment.*acoustic/i,             // Appointment letters
      /invoice/i,
      /quote/i,
      /proposal/i
    ];

    // Stage 2: Content-based indicators (will use fiDetectionService gates)
    this.acousticKeywords = [
      'acoustic', 'noise', 'sound level', 'decibel', 'dBA', 'dB(A)',
      'noise impact', 'noise assessment', 'acoustic assessment',
      'BS 4142', 'BS4142', 'ISO 1996', 'WHO guideline',
      'background noise', 'ambient noise', 'noise survey',
      'sound pressure level', 'LAeq', 'LA90', 'LAmax',
      'noise sensitive', 'noise receptor', 'acoustic consultant'
    ];

    // Common acoustic consultancies (helps with confidence scoring)
    this.acousticConsultants = [
      'AWN', 'AECOM', 'Arup', 'RPS', 'AECOM', 'Noise Consultants',
      'Marshall Day', 'Cundall', 'Atkins', 'Entran',
      'Temple Group', 'Vanguardia', 'SLR Consulting'
    ];

    this.stats = {
      stage1Pass: 0,
      stage2Pass: 0,
      stage3Pass: 0,
      totalProcessed: 0,
      visionApiCalls: 0
    };
  }

  /**
   * Main filtering pipeline - determines if document is an acoustic report
   * @param {Object} document - { fileName, filePath, projectId, buffer? }
   * @param {string} extractedText - Pre-extracted text from document (optional)
   * @returns {Promise<{isAcoustic: boolean, confidence: number, stage: string, reason: string, reviewNeeded: boolean}>}
   */
  async filterDocument(document, extractedText = null) {
    this.stats.totalProcessed++;

    logger.info(`🔍 Filtering document: ${document.fileName} (Project: ${document.projectId})`);

    // Stage 1: Filename Analysis (Fast, no API calls)
    const stage1Result = this.stage1FilenameFilter(document.fileName);

    if (stage1Result.reject) {
      logger.info(`❌ Stage 1 REJECT: ${document.fileName} - ${stage1Result.reason}`);
      return {
        isAcoustic: false,
        confidence: 0,
        stage: 'stage1',
        reason: stage1Result.reason,
        reviewNeeded: false
      };
    }

    if (!stage1Result.pass) {
      logger.info(`⚠️  Stage 1 UNCERTAIN: ${document.fileName} - ${stage1Result.reason}`);
      // Continue to next stage for uncertain cases
    } else {
      this.stats.stage1Pass++;
      logger.info(`✅ Stage 1 PASS: ${document.fileName} - ${stage1Result.reason}`);
    }

    // Stage 2: Content Analysis (Uses existing FI detection gates)
    if (extractedText) {
      const stage2Result = await this.stage2ContentFilter(extractedText, document.fileName);

      if (stage2Result.confidence >= 0.8) {
        this.stats.stage2Pass++;
        logger.info(`✅ Stage 2 HIGH CONFIDENCE (${stage2Result.confidence}): ${document.fileName}`);
        return {
          isAcoustic: true,
          confidence: stage2Result.confidence,
          stage: 'stage2',
          reason: stage2Result.reason,
          reviewNeeded: false
        };
      }

      if (stage2Result.confidence >= 0.5) {
        logger.info(`⚠️  Stage 2 MEDIUM CONFIDENCE (${stage2Result.confidence}): ${document.fileName}`);
        // Medium confidence - proceed to AI Vision
      } else if (stage1Result.pass) {
        // Stage 1 passed but Stage 2 low confidence - needs vision check
        logger.info(`🔍 Stage 1 passed but Stage 2 uncertain - proceeding to Vision`);
      } else {
        // Both uncertain - reject
        logger.info(`❌ Stage 1 & 2 uncertain: ${document.fileName}`);
        return {
          isAcoustic: false,
          confidence: stage2Result.confidence,
          stage: 'stage2',
          reason: 'Low confidence in both filename and content analysis',
          reviewNeeded: stage2Result.confidence >= 0.3 // Review if somewhat uncertain
        };
      }
    }

    // Stage 3: AI Vision (Only for uncertain cases, requires document buffer)
    if (document.buffer) {
      this.stats.visionApiCalls++;
      logger.info(`👁️  Stage 3 VISION ANALYSIS: ${document.fileName}`);

      const stage3Result = await aiVisionService.analyzeDocumentType(
        document.buffer,
        document.fileName
      );

      this.stats.stage3Pass += stage3Result.isAcoustic ? 1 : 0;

      return {
        isAcoustic: stage3Result.isAcoustic,
        confidence: stage3Result.confidence,
        stage: 'stage3_vision',
        reason: stage3Result.reason,
        reviewNeeded: stage3Result.confidence < 0.8 && stage3Result.confidence > 0.3,
        reportType: stage3Result.reportType,
        keyIndicators: stage3Result.keyIndicators
      };
    }

    // No buffer provided and uncertain - mark for review
    logger.warn(`⚠️  No buffer provided for uncertain document: ${document.fileName}`);
    return {
      isAcoustic: false,
      confidence: stage1Result.pass ? 0.5 : 0.3,
      stage: 'incomplete',
      reason: 'Uncertain classification, requires manual review or document buffer for Vision analysis',
      reviewNeeded: true
    };
  }

  /**
   * Stage 1: Filename Pattern Matching
   * @returns {{pass: boolean, reject: boolean, confidence: number, reason: string}}
   */
  stage1FilenameFilter(fileName) {
    const lowerFileName = fileName.toLowerCase();

    // Check negative patterns first (hard reject)
    for (const pattern of this.negativeFilenamePatterns) {
      if (pattern.test(fileName)) {
        return {
          pass: false,
          reject: true,
          confidence: 0,
          reason: `Matched negative pattern: ${pattern.source}`
        };
      }
    }

    // Check positive acoustic patterns
    const matchedPatterns = this.acousticFilenamePatterns.filter(pattern =>
      pattern.test(fileName)
    );

    if (matchedPatterns.length >= 2) {
      // Multiple pattern matches = high confidence
      return {
        pass: true,
        reject: false,
        confidence: 0.8,
        reason: `Multiple acoustic indicators in filename: ${matchedPatterns.length} patterns matched`
      };
    }

    if (matchedPatterns.length === 1) {
      // Single pattern match = medium confidence
      return {
        pass: true,
        reject: false,
        confidence: 0.6,
        reason: `Single acoustic indicator in filename`
      };
    }

    // No matches = uncertain (not rejected, but not passed)
    return {
      pass: false,
      reject: false,
      confidence: 0.3,
      reason: 'No acoustic indicators in filename'
    };
  }

  /**
   * Stage 2: Content-based filtering using acoustic keywords
   * @param {string} text - Extracted document text
   * @param {string} fileName - Filename for context
   * @returns {Promise<{confidence: number, reason: string, keywords: string[]}>}
   */
  async stage2ContentFilter(text, fileName) {
    if (!text || text.length < 100) {
      return {
        confidence: 0.1,
        reason: 'Insufficient text for analysis',
        keywords: []
      };
    }

    const lowerText = text.toLowerCase();
    const matchedKeywords = [];
    const matchedConsultants = [];

    // Check for acoustic keywords
    for (const keyword of this.acousticKeywords) {
      if (lowerText.includes(keyword.toLowerCase())) {
        matchedKeywords.push(keyword);
      }
    }

    // Check for known acoustic consultants
    for (const consultant of this.acousticConsultants) {
      if (text.includes(consultant)) {
        matchedConsultants.push(consultant);
      }
    }

    // Calculate confidence based on matches
    let confidence = 0;

    // Base score from keyword density
    const keywordScore = Math.min(matchedKeywords.length / 5, 1.0) * 0.5;
    confidence += keywordScore;

    // Bonus for consultant mention
    if (matchedConsultants.length > 0) {
      confidence += 0.2;
    }

    // Bonus for technical terms (BS 4142, ISO 1996, etc.)
    if (/BS\s*4142|ISO\s*1996/i.test(text)) {
      confidence += 0.2;
    }

    // Bonus for measurement data patterns (e.g., "45 dB(A)", "LAeq 50")
    if (/\d+\s*dB\(A\)|LAeq\s*\d+|LA90\s*\d+/i.test(text)) {
      confidence += 0.1;
    }

    // Cap confidence at 0.95 (reserve 1.0 for Vision API confirmation)
    confidence = Math.min(confidence, 0.95);

    const reason = `Found ${matchedKeywords.length} acoustic keywords` +
      (matchedConsultants.length > 0 ? `, consultant: ${matchedConsultants.join(', ')}` : '');

    return {
      confidence,
      reason,
      keywords: matchedKeywords,
      consultants: matchedConsultants
    };
  }

  /**
   * Batch filter multiple documents
   */
  async filterDocumentBatch(documents, extractedTexts = {}) {
    const results = [];

    for (const doc of documents) {
      try {
        const text = extractedTexts[doc.filePath] || null;
        const result = await this.filterDocument(doc, text);

        results.push({
          ...doc,
          ...result
        });

      } catch (error) {
        logger.error(`Failed to filter ${doc.fileName}:`, error);
        results.push({
          ...doc,
          isAcoustic: false,
          confidence: 0,
          stage: 'error',
          reason: `Filter error: ${error.message}`,
          reviewNeeded: true
        });
      }
    }

    return results;
  }

  /**
   * Get filtering statistics
   */
  getStats() {
    return {
      ...this.stats,
      stage1PassRate: this.stats.totalProcessed > 0
        ? (this.stats.stage1Pass / this.stats.totalProcessed * 100).toFixed(1) + '%'
        : '0%',
      stage2PassRate: this.stats.totalProcessed > 0
        ? (this.stats.stage2Pass / this.stats.totalProcessed * 100).toFixed(1) + '%'
        : '0%',
      stage3PassRate: this.stats.visionApiCalls > 0
        ? (this.stats.stage3Pass / this.stats.visionApiCalls * 100).toFixed(1) + '%'
        : '0%',
      visionApiUsageRate: this.stats.totalProcessed > 0
        ? (this.stats.visionApiCalls / this.stats.totalProcessed * 100).toFixed(1) + '%'
        : '0%'
    };
  }

  /**
   * Reset statistics
   */
  resetStats() {
    this.stats = {
      stage1Pass: 0,
      stage2Pass: 0,
      stage3Pass: 0,
      totalProcessed: 0,
      visionApiCalls: 0
    };
  }
}

module.exports = new DocumentFilterService();
