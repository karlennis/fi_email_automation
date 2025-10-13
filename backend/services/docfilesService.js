const { OpenAI } = require('openai');
const winston = require('winston');
const crypto = require('crypto');
require('dotenv').config(); // Load environment variables

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

CRITICAL DISTINCTION - You must differentiate between:
1. EXISTING REPORTS: Documents that already exist in the project (e.g., "Acoustic Report submitted by XYZ Consultants")
2. REQUESTED REPORTS: The planning authority ASKING the applicant to provide/submit reports

ONLY mark as TRUE if you find the planning authority REQUESTING a report type, NOT if the report type already exists.

FORMAL FI REQUEST INDICATORS (must be FROM planning authority TO applicant):
- "The applicant is requested to submit [report type]..."
- "The applicant is invited to provide [report type]..."
- "Please submit the following: [report type]..."
- "A [report type] should be provided/submitted..."
- "The planning authority requires [report type]..."
- "Carry out a [report type]..."
- "Undertake a [report type]..."
- Formal numbered/lettered requirements requesting specific report types

REQUIRED REQUEST VERBS (must appear with report type):
- submit, provide, prepare, carry out, undertake, produce, include, supply
- should be submitted, must be provided, needs to be prepared
- is required, is requested, is necessary

EXCLUDE - These are NOT FI requests:
- Existing reports: "Acoustic Report by ABC Consultants" (already exists)
- Third-party objections: "Objector recommends acoustic assessment" (not from planning authority)
- Applicant's submissions: "We have prepared an acoustic report" (applicant speaking)
- General policy text: "Planning policy requires acoustic assessments" (general statement)
- Report titles/headers: "NOISE IMPACT ASSESSMENT" (just a title)
- Application acknowledgment letters without requests

For each target report type, you must find:
1. Evidence this is FROM the planning authority (letterhead, signature, formal language)
2. A clear REQUEST verb (submit, provide, carry out, etc.)
3. The specific report type mentioned WITH the request verb

Target report types with strict keywords:
- 'acoustic': "submit acoustic assessment", "provide noise impact assessment", "carry out acoustic survey", "noise monitoring is required"
- 'transport': "submit transport assessment", "provide traffic impact assessment", "carry out parking survey", "travel plan is required"
- 'ecological': "submit ecological assessment", "provide biodiversity survey", "carry out habitat assessment", "ecological survey is required"
- 'flood': "submit flood risk assessment", "provide drainage strategy", "carry out SUDS assessment", "hydrology report is required"
- 'heritage': "submit heritage assessment", "provide archaeological survey", "carry out historic impact assessment"
- 'lighting': "submit lighting assessment", "provide light pollution study", "carry out lighting impact assessment"

STRICT MATCHING RULES:
- Report type keyword + request verb must appear in same sentence or adjacent sentences
- Must be in context of planning authority making a request
- When in doubt, mark as FALSE - better to miss than create false positive
- Provide exact quotes showing request verb + report type together

Return detailed analysis with specific quotes showing the REQUEST for each report type.`;

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
   * ACCOUNTABILITY: Logs exact phrases from fiDetails when matches found
   */
  async analyzeDocfilesForFI(docfilesContent, projectId, targetReportTypes = []) {
    try {
      // CACHE CHECK
      const cacheKey = this.generateCacheKey(docfilesContent, targetReportTypes, projectId);
      const cachedResult = this.getCachedResult(cacheKey);
      if (cachedResult) {
        return cachedResult;
      }

      // QUICK PRE-FILTER
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

      // AI ANALYSIS
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

      // VALIDATION: Filter out fiDetails where quote doesn't contain the report type keyword
      if (result.hasFIRequests && result.fiDetails && result.fiDetails.length > 0) {
        const reportTypeKeywords = {
          'acoustic': ['acoustic', 'noise', 'sound', 'vibration', 'decibel', 'db(a)'],
          'transport': ['transport', 'traffic', 'parking', 'travel', 'highway', 'vehicular'],
          'ecological': ['ecological', 'ecology', 'biodiversity', 'habitat', 'species', 'wildlife'],
          'flood': ['flood', 'drainage', 'suds', 'hydrology', 'surface water', 'foul water'],
          'heritage': ['heritage', 'archaeological', 'historic', 'conservation', 'listed building'],
          'lighting': ['lighting', 'light pollution', 'illumination', 'luminance']
        };

        // Validate each detail - quote must contain at least one keyword for the claimed report type
        const validatedDetails = result.fiDetails.filter(detail => {
          const reportType = detail.reportType;
          const quote = (detail.quote || detail.context || '').toLowerCase();
          const keywords = reportTypeKeywords[reportType] || [];

          const hasKeyword = keywords.some(keyword => quote.includes(keyword));

          if (!hasKeyword) {
            logger.warn(`⚠️ Rejected invalid quote for ${reportType} - quote doesn't contain report type keyword: "${detail.quote?.substring(0, 100)}"`);
          }

          return hasKeyword;
        });

        result.fiDetails = validatedDetails;

        // Update reportTypeMatches based on validated details
        const validReportTypes = new Set(validatedDetails.map(d => d.reportType));
        Object.keys(result.reportTypeMatches).forEach(type => {
          result.reportTypeMatches[type] = validReportTypes.has(type);
        });

        // Update hasFIRequests based on whether any valid details remain
        result.hasFIRequests = validatedDetails.length > 0;
      }

      this.setCachedResult(cacheKey, result);

      // ACCOUNTABILITY LOGGING: Log exact matching phrases (only validated ones)
      if (result.hasFIRequests && result.fiDetails && result.fiDetails.length > 0) {
        result.fiDetails.forEach(detail => {
          const exactPhrase = detail.quote || detail.context || 'N/A';
          const matchedType = detail.reportType || 'unknown';
          logger.info(`🎯 MATCH | Project: ${projectId} | Source: docfiles.txt | Type: ${matchedType} | Phrase: "${exactPhrase.substring(0, 200)}"`);
        });
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