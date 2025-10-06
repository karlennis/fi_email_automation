const { OpenAI } = require('openai');
const winston = require('winston');
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

class DocfilesService {
  constructor() {
    this.client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      timeout: 60000,
      maxRetries: 0
    });

    this.config = {
      model: "gpt-4o-mini",
      temperature: 0.0,
      topP: 0.0,
      maxRetries: 3,
      maxMsgChars: 120000 // Allow larger context for consolidated files
    };

    // Cache for docfiles analysis
    this.docfilesCache = new Map();
    this.cacheStats = {
      hits: 0,
      misses: 0,
      saves: 0
    };
  }

  /**
   * System prompt for analyzing consolidated docfiles.txt
   */
  get SYSTEM_DOCFILES_FI_ANALYSIS() {
    return `You are analyzing a consolidated document file (docfiles.txt) that contains OCR'd text from all documents in a planning application project. Your task is to identify if there are any Further Information (FI) requests from planning authorities.

IMPORTANT: This file contains multiple documents concatenated together with no clear separators. Look for:

FORMAL FI REQUEST INDICATORS:
- "Further Information request" or "Additional Information required"
- "The applicant is requested to submit..."
- "The applicant is invited to provide..."
- "Please submit the following additional information..."
- "Clarification is required on..."
- "The planning authority requires..."
- Formal numbered/lettered requirements (1., 2., (a), (b), etc.)

FORMAL LANGUAGE PATTERNS:
- Official letterhead from planning authorities
- Reference to planning application numbers
- Formal request structure with specific requirements
- Deadlines for submission

EXCLUDE:
- Objections or submissions FROM third parties recommending FI requests
- Internal technical notes or guidance documents
- Application acknowledgment letters
- General planning policy text

For each target report type, analyze if there are SPECIFIC requests for:
- 'acoustic': noise impact assessment, acoustic survey, sound measurements, noise monitoring
- 'transport': transport assessment, traffic impact assessment, parking survey, travel plan
- 'ecological': ecological assessment, biodiversity survey, habitat assessment, species survey
- 'flood': flood risk assessment, drainage strategy, SUDS scheme, hydrology report
- 'heritage': heritage assessment, archaeological survey, historic impact assessment
- 'lighting': lighting assessment, light pollution study, artificial lighting impact

Return detailed analysis with specific quotes and locations where FI requests are found.`;
  }

  /**
   * Function schema for docfiles analysis
   */
  get DOCFILES_ANALYSIS_FUNCTION() {
    return {
      name: "analyze_docfiles_for_fi",
      parameters: {
        type: "object",
        properties: {
          hasFIRequests: { type: "boolean", description: "Whether any FI requests were found" },
          reportTypeMatches: {
            type: "object",
            properties: {
              acoustic: { type: "boolean" },
              transport: { type: "boolean" },
              ecological: { type: "boolean" },
              flood: { type: "boolean" },
              heritage: { type: "boolean" },
              lighting: { type: "boolean" }
            }
          },
          fiDetails: {
            type: "array",
            items: {
              type: "object",
              properties: {
                reportType: { type: "string" },
                quote: { type: "string", description: "Direct quote from the FI request" },
                context: { type: "string", description: "Surrounding context" },
                confidence: { type: "number", description: "Confidence level 0-1" }
              }
            }
          },
          summary: { type: "string", description: "Brief summary of findings" }
        },
        required: ["hasFIRequests", "reportTypeMatches", "fiDetails", "summary"]
      }
    };
  }

  /**
   * Robust OpenAI API call with retries
   */
  async runChat(messages, functions, functionName, maxAttempts = this.config.maxRetries) {
    const safeMessages = messages.map(m => ({
      ...m,
      content: String(m.content || '').slice(0, this.config.maxMsgChars)
    }));

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const response = await this.client.chat.completions.create({
          model: this.config.model,
          temperature: this.config.temperature,
          top_p: this.config.topP,
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
   * Analyze docfiles.txt for FI requests
   */
  async analyzeDocfilesForFI(docfilesContent, projectId, targetReportTypes = []) {
    try {
      logger.info(`📋 Analyzing docfiles.txt for project ${projectId} (${docfilesContent.length} chars)`);

      // Cache check
      const cacheKey = this.generateCacheKey(docfilesContent, targetReportTypes, projectId);
      const cachedResult = this.getCachedResult(cacheKey);
      if (cachedResult) {
        return cachedResult;
      }

      // Quick pre-filter for FI indicators
      const fiIndicators = [
        'further information', 'additional information', 'clarification required',
        'applicant is requested', 'applicant is invited', 'please submit',
        'planning authority requires', 'submit the following'
      ];

      const contentLower = docfilesContent.toLowerCase();
      const hasBasicIndicators = fiIndicators.some(indicator =>
        contentLower.includes(indicator)
      );

      if (!hasBasicIndicators) {
        logger.info(`⚡ Quick filter: No FI indicators found in project ${projectId} docfiles`);
        const result = {
          hasFIRequests: false,
          reportTypeMatches: {},
          fiDetails: [],
          summary: 'No Further Information request indicators found in consolidated document',
          detectionMethod: 'quick_filter_reject'
        };
        this.setCachedResult(cacheKey, result);
        return result;
      }

      logger.info(`✅ FI indicators found, performing AI analysis for project ${projectId}`);

      // Perform AI analysis
      const analysisResult = await this.runChat(
        [
          { role: "system", content: this.SYSTEM_DOCFILES_FI_ANALYSIS },
          {
            role: "user",
            content: `Analyze this consolidated planning document for Further Information requests. Target report types: ${targetReportTypes.join(', ')}\n\nDocument content:\n${docfilesContent}`
          }
        ],
        [this.DOCFILES_ANALYSIS_FUNCTION],
        "analyze_docfiles_for_fi"
      );

      const result = {
        ...analysisResult,
        detectionMethod: 'ai_docfiles_analysis',
        projectId
      };

      this.setCachedResult(cacheKey, result);

      if (result.hasFIRequests) {
        logger.info(`🎉 FI requests found in project ${projectId}:`, result.summary);
      } else {
        logger.info(`❌ No FI requests found in project ${projectId}`);
      }

      return result;

    } catch (error) {
      logger.error(`Error analyzing docfiles for project ${projectId}:`, error);
      throw error;
    }
  }

  /**
   * Check if project has docfiles.txt in S3
   */
  async checkDocfilesExists(projectId) {
    try {
      const s3Service = require('./s3Service');
      const docfilesKey = `planning-docs/${projectId}/docfiles.txt`;

      return await s3Service.objectExists(docfilesKey);
    } catch (error) {
      logger.error(`Error checking docfiles existence for project ${projectId}:`, error);
      return false;
    }
  }

  /**
   * Get docfiles.txt content from S3
   */
  async getDocfilesContent(projectId) {
    try {
      const s3Service = require('./s3Service');
      const docfilesKey = `planning-docs/${projectId}/docfiles.txt`;

      logger.info(`📥 Fetching docfiles.txt for project ${projectId}`);
      const result = await s3Service.getDocumentBuffer(docfilesKey);

      if (result && result.buffer) {
        const content = result.buffer.toString('utf-8');
        logger.info(`✅ Retrieved docfiles.txt: ${content.length} characters for project ${projectId}`);
        return content;
      }

      throw new Error('No content received from S3');
    } catch (error) {
      logger.error(`Error fetching docfiles for project ${projectId}:`, error);
      throw error;
    }
  }

  /**
   * Generate cache key
   */
  generateCacheKey(content, reportTypes, projectId) {
    const keyContent = `${projectId}|${reportTypes.join(',')}|${content.substring(0, 1000)}`;
    return crypto.createHash('sha256').update(keyContent).digest('hex');
  }

  /**
   * Get cached result
   */
  getCachedResult(cacheKey) {
    if (this.docfilesCache.has(cacheKey)) {
      this.cacheStats.hits++;
      const cachedResult = this.docfilesCache.get(cacheKey);
      logger.info(`💾 Cache HIT for docfiles analysis: ${cacheKey.substring(0, 16)}...`);
      return { ...cachedResult, detectionMethod: `${cachedResult.detectionMethod}_cached` };
    }
    this.cacheStats.misses++;
    return null;
  }

  /**
   * Cache result
   */
  setCachedResult(cacheKey, result) {
    // Limit cache size
    if (this.docfilesCache.size >= 100) {
      const firstKey = this.docfilesCache.keys().next().value;
      this.docfilesCache.delete(firstKey);
    }

    this.docfilesCache.set(cacheKey, result);
    this.cacheStats.saves++;
    logger.info(`💾 Cache SAVE for docfiles analysis: ${cacheKey.substring(0, 16)}...`);
  }

  /**
   * Get cache statistics
   */
  getCacheStats() {
    const totalRequests = this.cacheStats.hits + this.cacheStats.misses;
    return {
      ...this.cacheStats,
      size: this.docfilesCache.size,
      hitRate: totalRequests > 0 ? (this.cacheStats.hits / totalRequests * 100) : 0
    };
  }

  /**
   * Clear cache
   */
  clearCache() {
    this.docfilesCache.clear();
    this.cacheStats = { hits: 0, misses: 0, saves: 0 };
    logger.info('Docfiles cache cleared');
  }
}

module.exports = new DocfilesService();