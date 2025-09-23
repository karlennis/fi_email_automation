const { OpenAI } = require('openai');
const fs = require('fs').promises;
const path = require('path');
const { execSync } = require('child_process');
const crypto = require('crypto');
const pdf = require('pdf-parse');
const winston = require('winston');

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

class FIDetectionService {
  constructor() {
    this.client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      timeout: 60000,
      maxRetries: 0
    });

    // Configuration matching rag_pipeline
    this.config = {
      ocrTimeout: 1000,
      maxTextChars: 8000,
      maxMsgChars: 32000,
      model: "gpt-4o-mini",
      temperature: 0.0,
      topP: 0.0,
      maxRetries: 6,
      baseDelay: 2.0
    };

    // Set class properties from config
    this.MAX_RETRIES = this.config.maxRetries;
    this.MAX_MSG_CHARS = this.config.maxMsgChars;
    this.MODEL = this.config.model;
    this.TEMPERATURE = this.config.temperature;
    this.TOP_P = this.config.topP;

    // Create OCR cache directory
    this.ocrCacheDir = path.join(process.cwd(), '.ocr_cache');
    this.ensureOcrCacheDir();

    // Initialize result cache for FI detection
    this.fiResultCache = new Map();
    this.cacheStats = {
      hits: 0,
      misses: 0,
      saves: 0
    };
  }

  /**
   * Ensure OCR cache directory exists
   */
  ensureOcrCacheDir() {
    try {
      const fs = require('fs');
      if (!fs.existsSync(this.ocrCacheDir)) {
        fs.mkdirSync(this.ocrCacheDir, { recursive: true });
        logger.info(`Created OCR cache directory: ${this.ocrCacheDir}`);
      }
    } catch (error) {
      logger.error('Error creating OCR cache directory:', error);
    }
  }

  /**
   * System prompts - directly from your RAG pipeline
   */
  get SYSTEM_FI_DETECT() {
    return `You detect if a document is a formal Further Information (FI) request from a planning authority to an applicant.
    Look for FORMAL REQUEST LANGUAGE such as:
    'The applicant is requested to', 'The applicant is invited to', 'The applicant should',
    'A [report type] needs should be provided', 'should be submitted', 'carry out a full',
    'address the concerns raised', 'provide a proposal for', 'submit a full'.
    Also look for STRUCTURAL INDICATORS:
    - Numbered or lettered items (1., 2., (a), (b), etc.)
    - References to council departments or officers
    - Phrases like 'for this application', 'in relation to this request'
    - Council letterhead or formal government formatting
    IMPORTANT: This should be a REQUEST FROM the council TO the applicant, not a submission BY the applicant.
    If the document appears to be an applicant's response or submission, mark as isFIRequest=false.
    Return JSON for detect_fi_request – isFIRequest true/false.`;
  }

  get SYSTEM_FI_MATCH() {
    return `You are given a formal Further Information request from a planning authority and a target report type.
    Your job is to determine if this FI request asks for SPECIFIC information related to the target report type.
    Look for these specific connections:
    - 'acoustic': noise impact assessment, acoustic assessment/report/survey, sound measurements, noise monitoring, decibel readings, acoustic mitigation
    - 'transport': transport assessment/statement, traffic impact assessment, parking survey, highway assessment, travel plan, access arrangements
    - 'ecological': ecological assessment/survey/report, biodiversity survey, habitat assessment, species survey, ecological mitigation, wildlife impact
    - 'flood': flood risk assessment, drainage strategy, surface water management, SUDS scheme, hydrology report, flood mitigation
    - 'heritage': heritage assessment, archaeological survey/report, historic impact assessment, conservation report, cultural heritage study
    - 'lighting': lighting assessment/report, light pollution study, artificial lighting impact, illumination scheme, lighting design

    IMPORTANT MATCHING RULES:
    1. Only mark as TRUE if there is a CLEAR, SPECIFIC request for the target report type
    2. Generic mentions without specific requests should return FALSE
    3. If the request asks for multiple different report types, only match the specific types mentioned
    4. Look for formal request language like "provide a [type] assessment", "submit a [type] report", "carry out a [type] survey"
    5. When in doubt, be SELECTIVE rather than inclusive - only match clear, unambiguous requests

    Return JSON for match_fi_request – requestsReportType true/false.`;
  }

  get SYSTEM_EXTRACT_FI_REQUEST() {
    return `You extract key information from Further Information (FI) requests from planning authorities.
    Focus on:

    • **RequestingAuthority** – the planning authority or officer making the request
    • **RequestDate** – date of the request if mentioned
    • **Summary** – ≤ 60 words summary of what information is being requested
    • **SpecificRequests** – detailed breakdown of what is being asked for
    • **Deadline** – any deadline mentioned for response
    • **ReferenceNumbers** – any planning application or case reference numbers

    Return **JSON only** for the provided function; do **not** add any commentary outside JSON.`;
  }

  /**
   * Function schemas - directly from your RAG pipeline
   */
  get FI_DETECT_FUNCTION() {
    return {
      name: "detect_fi_request",
      parameters: {
        type: "object",
        properties: { isFIRequest: { type: "boolean" } },
        required: ["isFIRequest"]
      }
    };
  }

  get FI_MATCH_FUNCTION() {
    return {
      name: "match_fi_request",
      parameters: {
        type: "object",
        properties: { requestsReportType: { type: "boolean" } },
        required: ["requestsReportType"]
      }
    };
  }

  get EXTRACTION_FUNCTION() {
    return {
      name: "extract_fi_request",
      parameters: {
        type: "object",
        properties: {
          fileName: { type: "string" },
          docType: { type: "string" },
          RequestingAuthority: { type: "string" },
          RequestDate: { type: "string" },
          Summary: { type: "string" },
          SpecificRequests: { type: "string" },
          Deadline: { type: "string" },
          ReferenceNumbers: { type: "string" }
        }
      }
    };
  }

  /**
   * Robust OpenAI API call with retries - from your RAG pipeline
   */
  async runChat(messages, functions, functionName, maxAttempts = this.MAX_RETRIES) {
    // Ensure plain-string content & length clamp
    const safeMessages = messages.map(m => ({
      ...m,
      content: String(m.content || '').slice(0, this.MAX_MSG_CHARS)
    }));

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const response = await this.client.chat.completions.create({
          model: this.MODEL,
          temperature: this.TEMPERATURE,
          top_p: this.TOP_P,
          messages: safeMessages,
          functions: functions,
          function_call: { name: functionName }
        });

        return JSON.parse(response.choices[0].message.function_call.arguments);

      } catch (error) {
        if (error.name === 'APITimeoutError' || error.code === 'ECONNRESET') {
          const wait = 2.0 * (2 ** (attempt - 1)) + Math.random() * 0.3;
          logger.warn(`${error.constructor.name} – retry ${attempt}/${maxAttempts} in ${wait.toFixed(1)}s`);
          await new Promise(resolve => setTimeout(resolve, wait * 1000));
          continue;
        }

        if (error instanceof SyntaxError && error.message.includes('JSON')) {
          logger.warn(`JSON parse failed (${error.message}); retry ${attempt}/${maxAttempts}`);
          await new Promise(resolve => setTimeout(resolve, 1000));
          continue;
        }

        throw error;
      }
    }

    throw new Error(`runChat: giving up after ${maxAttempts} attempts on ${functionName}`);
  }

  /**
   * OCR processing if needed - from rag_pipeline
   */
  async ocrIfNeeded(filePath) {
    try {
      logger.info(`Starting OCR processing for: ${filePath}`);

      // Check if we have OCR cached
      const cacheKey = `ocr_${path.basename(filePath)}`;
      if (this._ocrCache && this._ocrCache[cacheKey]) {
        logger.info('Using cached OCR result');
        return this._ocrCache[cacheKey];
      }

      const { execSync } = require('child_process');
      const outputPath = filePath.replace(/\.pdf$/i, '_ocr.pdf');

      try {
        // Run OCR using ocrmypdf
        execSync(`ocrmypdf "${filePath}" "${outputPath}"`, {
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 120000 // 2 minute timeout
        });

        logger.info(`OCR completed successfully: ${outputPath}`);

        // Cache the result
        if (!this._ocrCache) this._ocrCache = {};
        this._ocrCache[cacheKey] = outputPath;

        return outputPath;
      } catch (ocrError) {
        logger.warn(`OCR failed for ${filePath}, will use original: ${ocrError.message}`);
        return filePath;
      }
    } catch (error) {
      logger.error('Error in OCR processing:', error);
      return filePath; // Fallback to original file
    }
  }

  /**
   * Extract text from PDF - from rag_pipeline
   */
  async extractPdfText(filePath) {
    try {
      logger.info(`Extracting text from: ${filePath}`);

      const pdfParse = require('pdf-parse');
      const fs = require('fs');

      const pdfBuffer = fs.readFileSync(filePath);
      const data = await pdfParse(pdfBuffer);

      if (!data.text || data.text.trim().length === 0) {
        logger.warn(`No text extracted from ${filePath}, may need OCR`);
        return '';
      }

      logger.info(`Extracted ${data.text.length} characters from PDF`);
      return data.text;
    } catch (error) {
      logger.error('Error extracting PDF text:', error);
      return '';
    }
  }

  /**
   * Check filename for FI indicators - FAST first pass
   */
  checkFilenameForFI(fileName) {
    if (!fileName) return false;

    const filenameLower = fileName.toLowerCase();
    const fiIndicators = [
      'further information', 'fi request', 'fi_request', 'further_information',
      'additional information', 'clarification', 'supplementary',
      'fi response', 'fi_response', 'further info', 'furtherinfo',
      'request for information', 'rfi', 'planning query'
    ];

    return fiIndicators.some(indicator => filenameLower.includes(indicator));
  }

  /**
   * Enhanced filename checking for report type
   */
  checkFilenameForReportType(fileName, targetReportType) {
    if (!fileName || !targetReportType) return false;

    const filenameLower = fileName.toLowerCase();
    const reportTypeIndicators = {
      "acoustic": ["noise", "sound", "acoustic", "decibel", "audio", "vibration"],
      "transport": ["traffic", "transport", "parking", "vehicle", "highway", "road", "mobility"],
      "ecological": ["ecology", "ecological", "wildlife", "habitat", "species", "biodiversity", "environment"],
      "flood": ["flood", "drainage", "water", "sewage", "storm", "surface water", "suds"],
      "heritage": ["heritage", "archaeological", "historic", "conservation", "listed", "cultural"],
      "arboricultural": ["tree", "arboricultural", "vegetation", "landscape", "planting", "forestry"],
      "waste": ["waste", "refuse", "recycling", "disposal", "management", "bin"],
      "lighting": ["lighting", "light", "illumination", "lumens", "lux", "lamp"]
    };

    const indicators = reportTypeIndicators[targetReportType.toLowerCase()] || [];
    return indicators.some(indicator => filenameLower.includes(indicator));
  }

  /**
   * Quick keyword filter - from your RAG pipeline
   */
  quickKeywordFilter(text, keyword) {
    const fiIndicators = [
      "further information", "additional information", "clarification required",
      "applicant is requested", "applicant is invited", "should be provided",
      "submit the following", "carry out a full", "address the concerns",
      "planning authority", "county council", "in relation to this request"
    ];

    const textLower = text.toLowerCase();

    // If this looks like an FI request, always allow it through
    if (fiIndicators.some(indicator => textLower.includes(indicator))) {
      return true;
    }

    const keywordLower = keyword.toLowerCase();

    // Quick keyword presence check
    if (!textLower.includes(keywordLower)) {
      // Check for related terms - expanded list
      const relatedTerms = {
        "acoustic": ["noise", "sound", "decibel", "db", "vibration", "noise assessment", "sound level"],
        "transport": ["traffic", "vehicle", "highway", "road", "parking", "transport assessment", "car park", "mobility"],
        "ecological": ["ecology", "wildlife", "habitat", "species", "biodiversity", "environment", "ecological", "nature"],
        "flood": ["drainage", "water", "sewage", "storm", "rainfall", "suds", "surface water", "attenuation"],
        "heritage": ["archaeological", "historic", "conservation", "listed", "cultural", "monument", "historic", "archaeology"],
        "arboricultural": ["tree", "trees", "vegetation", "landscape", "planting", "hedge", "woodland", "green"],
        "waste": ["waste", "refuse", "recycling", "bin", "storage", "collection", "disposal", "management plan"]
      };

      if (relatedTerms[keywordLower]) {
        if (!relatedTerms[keywordLower].some(term => textLower.includes(term))) {
          return false;
        }
      }
    }

    return true;
  }

  /**
   * Detect if document is an FI request
   */
  async detectFIRequest(documentText) {
    try {
      const result = await this.runChat(
        [
          { role: "system", content: this.SYSTEM_FI_DETECT },
          { role: "user", content: documentText }
        ],
        [this.FI_DETECT_FUNCTION],
        "detect_fi_request"
      );

      return result.isFIRequest;
    } catch (error) {
      logger.error('Error detecting FI request:', error);
      throw error;
    }
  }

  /**
   * Check if FI request matches target report type
   */
  async matchFIRequestType(documentText, targetReportType) {
    try {
      // Quick pre-filter
      if (!this.quickKeywordFilter(documentText, targetReportType)) {
        return false;
      }

      const result = await this.runChat(
        [
          { role: "system", content: this.SYSTEM_FI_MATCH },
          { role: "user", content: `Target report type: ${targetReportType}\n\n${documentText}` }
        ],
        [this.FI_MATCH_FUNCTION],
        "match_fi_request"
      );

      return result.requestsReportType;
    } catch (error) {
      logger.error('Error matching FI request type:', error);
      throw error;
    }
  }

  /**
   * Extract information from FI request
   */
  async extractFIRequestInfo(documentText, fileName = '') {
    try {
      const result = await this.runChat(
        [
          { role: "system", content: this.SYSTEM_EXTRACT_FI_REQUEST },
          { role: "user", content: documentText }
        ],
        [this.EXTRACTION_FUNCTION],
        "extract_fi_request"
      );

      return {
        ...result,
        fileName: fileName || result.fileName,
        docType: "FIRequest"
      };
    } catch (error) {
      logger.error('Error extracting FI request info:', error);
      throw error;
    }
  }

  /**
   * Combined detection and processing - OPTIMIZED VERSION
   */
  async processFIRequest(documentText, targetReportType, fileName = '') {
    try {
      logger.info(`Processing FI request for ${targetReportType} in file: ${fileName}`);

      // CACHE CHECK: Check if we've already processed this document
      const cacheKey = this.generateCacheKey(documentText, targetReportType, fileName);
      const cachedResult = this.getCachedResult(cacheKey);
      if (cachedResult) {
        return cachedResult;
      }

      // FAST TRACK: Check filename first - instant results for obvious cases
      const fiInFilename = this.checkFilenameForFI(fileName);
      const reportTypeInFilename = this.checkFilenameForReportType(fileName, targetReportType);

      // If filename clearly indicates FI + correct report type, fast track to extraction
      if (fiInFilename && reportTypeInFilename) {
        logger.info(`FAST TRACK: Filename indicates FI request for ${targetReportType}: ${fileName}`);

        // Still do basic validation but skip expensive AI calls
        if (this.quickKeywordFilter(documentText, targetReportType)) {
          const extractedInfo = await this.extractFIRequestInfo(documentText, fileName);
          const result = {
            isFIRequest: true,
            matchesTargetType: true,
            extractedInfo,
            detectionMethod: 'filename_fast_track'
          };

          // Cache the result
          this.setCachedResult(cacheKey, result);
          return result;
        }
      }

      // QUICK PRE-FILTER: Avoid expensive AI calls for obvious mismatches
      if (!this.quickKeywordFilter(documentText, targetReportType)) {
        logger.info(`Quick filter rejected document for ${targetReportType}: ${fileName}`);
        const result = {
          isFIRequest: false,
          matchesTargetType: false,
          extractedInfo: null,
          detectionMethod: 'quick_filter_reject'
        };
        this.setCachedResult(cacheKey, result);
        return result;
      }

      // STANDARD FLOW: Step 1 - Check if this is an FI request
      const isFIRequest = await this.detectFIRequest(documentText);

      if (!isFIRequest) {
        const result = {
          isFIRequest: false,
          matchesTargetType: false,
          extractedInfo: null,
          detectionMethod: 'ai_not_fi_request'
        };
        this.setCachedResult(cacheKey, result);
        return result;
      }

      // STANDARD FLOW: Step 2 - Check if it matches the target report type
      const matchesTargetType = await this.matchFIRequestType(documentText, targetReportType);

      if (!matchesTargetType) {
        const result = {
          isFIRequest: true,
          matchesTargetType: false,
          extractedInfo: null,
          detectionMethod: 'ai_wrong_report_type'
        };
        this.setCachedResult(cacheKey, result);
        return result;
      }

      // STANDARD FLOW: Step 3 - Extract detailed information
      const extractedInfo = await this.extractFIRequestInfo(documentText, fileName);

      const result = {
        isFIRequest: true,
        matchesTargetType: true,
        extractedInfo,
        detectionMethod: 'ai_full_processing'
      };

      this.setCachedResult(cacheKey, result);
      return result;

    } catch (error) {
      logger.error('Error processing FI request:', error);
      throw error;
    }
  }

  /**
   * Prioritize documents by likelihood of containing FI requests
   */
  prioritizeDocuments(documents) {
    return documents.sort((a, b) => {
      const scoreA = this.calculateFILikelihoodScore(a.fileName);
      const scoreB = this.calculateFILikelihoodScore(b.fileName);
      return scoreB - scoreA; // Higher scores first
    });
  }

  /**
   * Calculate likelihood score for FI content based on filename
   */
  calculateFILikelihoodScore(fileName) {
    if (!fileName) return 0;

    const filenameLower = fileName.toLowerCase();
    let score = 0;

    // High priority indicators
    const highPriorityTerms = [
      'further information', 'fi request', 'fi_request', 'further_information'
    ];
    for (const term of highPriorityTerms) {
      if (filenameLower.includes(term)) score += 100;
    }

    // Medium priority indicators
    const mediumPriorityTerms = [
      'additional information', 'clarification', 'supplementary',
      'request for information', 'rfi'
    ];
    for (const term of mediumPriorityTerms) {
      if (filenameLower.includes(term)) score += 50;
    }

    // Low priority indicators
    const lowPriorityTerms = [
      'request', 'query', 'condition', 'response'
    ];
    for (const term of lowPriorityTerms) {
      if (filenameLower.includes(term)) score += 10;
    }

    return score;
  }

  /**
   * Generate cache key for FI detection result
   */
  generateCacheKey(documentText, targetReportType, fileName) {
    const content = `${fileName}|${targetReportType}|${documentText.substring(0, 1000)}`;
    return crypto.createHash('sha256').update(content).digest('hex');
  }

  /**
   * Get cached FI detection result
   */
  getCachedResult(cacheKey) {
    if (this.fiResultCache.has(cacheKey)) {
      this.cacheStats.hits++;
      const cachedResult = this.fiResultCache.get(cacheKey);
      logger.info(`Cache HIT for key: ${cacheKey.substring(0, 16)}...`);
      return { ...cachedResult, detectionMethod: `${cachedResult.detectionMethod}_cached` };
    }
    this.cacheStats.misses++;
    return null;
  }

  /**
   * Cache FI detection result
   */
  setCachedResult(cacheKey, result) {
    // Limit cache size to prevent memory issues
    if (this.fiResultCache.size >= 1000) {
      const firstKey = this.fiResultCache.keys().next().value;
      this.fiResultCache.delete(firstKey);
    }

    this.fiResultCache.set(cacheKey, result);
    this.cacheStats.saves++;
    logger.info(`Cache SAVE for key: ${cacheKey.substring(0, 16)}...`);
  }

  /**
   * Get cache statistics
   */
  getCacheStats() {
    const totalRequests = this.cacheStats.hits + this.cacheStats.misses;
    return {
      ...this.cacheStats,
      size: this.fiResultCache.size,
      hitRate: totalRequests > 0 ? (this.cacheStats.hits / totalRequests * 100) : 0
    };
  }

  /**
   * Clear the FI result cache
   */
  clearCache() {
    this.fiResultCache.clear();
    this.cacheStats = { hits: 0, misses: 0, saves: 0 };
    logger.info('FI detection cache cleared');
  }

  /**
   * Get cache memory usage estimate
   */
  getCacheMemoryUsage() {
    let totalSize = 0;
    this.fiResultCache.forEach((value, key) => {
      totalSize += key.length + JSON.stringify(value).length;
    });
    return {
      entriesCount: this.fiResultCache.size,
      estimatedSizeBytes: totalSize,
      estimatedSizeMB: (totalSize / 1024 / 1024).toFixed(2)
    };
  }
}

module.exports = new FIDetectionService();
