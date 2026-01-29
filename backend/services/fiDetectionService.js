const { OpenAI } = require('openai');
const fs = require('fs').promises;
const path = require('path');
const { execSync } = require('child_process');
const crypto = require('crypto');
const pdf = require('pdf-parse');
const winston = require('winston');
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

// Import FI Report Service for saving results
const fiReportService = require('./fiReportService');
const Customer = require('../models/Customer');

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
      maxTextChars: 10000,
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

    // BII URL prefix for constructing proper BII URLs
    this.BII_URL_PREFIX = 'https://app.buildinginfo.com/';

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
   * Construct proper BII URL from planning_path_url
   * @param {Object} projectMetadata - Project metadata containing planning_path_url
   * @returns {string|null} - Constructed BII URL or null if no planning_path_url
   */
  constructBiiUrl(projectMetadata) {
    if (!projectMetadata?.planning_path_url) {
      return null;
    }

    // Simply concatenate the base URL with the planning_path_url
    // planning_path_url already contains "p-" prefix and "-" suffix (e.g., "p-OGY4Zg==-")
    return `${this.BII_URL_PREFIX}${projectMetadata.planning_path_url}`;
  }

  /**
   * Find or create customer record for email address
   * @param {Object} customerInfo - Customer info with email, name, etc.
   * @param {Array} reportTypes - Report types to add if creating new customer
   * @returns {Promise<Object>} - Customer record
   */
  async findOrCreateCustomer(customerInfo, reportTypes = []) {
    try {
      let customer = await Customer.findOne({ email: customerInfo.email });

      if (!customer) {
        // Create new customer record
        customer = new Customer({
          name: customerInfo.name || customerInfo.email.split('@')[0],
          email: customerInfo.email,
          company: customerInfo.company || '',
          phone: customerInfo.phone || '',
          reportTypes: reportTypes.length > 0 ? reportTypes : ['acoustic'], // Default to acoustic if none specified
          isActive: true,
          emailPreferences: {
            instantNotification: true,
            dailyDigest: false,
            weeklyDigest: false
          }
        });

        await customer.save();
        logger.info(`📊 Created new customer record for ${customerInfo.email}`, {
          customerId: customer._id,
          name: customer.name,
          reportTypes: customer.reportTypes
        });
      } else {
        // Update existing customer with new report types if needed
        const newReportTypes = reportTypes.filter(rt => !customer.reportTypes.includes(rt));
        if (newReportTypes.length > 0) {
          customer.reportTypes.push(...newReportTypes);
          await customer.save();
          logger.info(`📈 Updated customer ${customerInfo.email} with new report types: ${newReportTypes.join(', ')}`);
        }
      }

      return customer;
    } catch (error) {
      logger.error(`❌ Error finding/creating customer ${customerInfo.email}:`, error);
      throw error;
    }
  }

  /**
   * System prompts - directly from your RAG pipeline
   */
  get SYSTEM_FI_DETECT() {
    return `You detect if a document is a formal Further Information (FI) request from a planning authority to an applicant.

CRITICAL: Distinguish between:
1. ACTUAL FI REQUESTS: Planning authority ASKING applicant to provide/submit information (ACCEPT)
2. FI RESPONSES/RECEIVED: Applicant RESPONDING to or SUBMITTING requested information (REJECT)
3. EXISTING DOCUMENTS: Reports or submissions that already exist (e.g., "Acoustic Report by XYZ") (REJECT)
4. THIRD-PARTY COMMENTS: Objectors or consultees suggesting FI requests (REJECT)
5. FI RECEIVED COVER LETTERS: Documents stating FI has been received or submitted (REJECT)

ONLY mark as isFIRequest=true if you find:
- Clear evidence this is FROM the planning authority (letterhead, officer signature, formal council language)
- REQUEST VERBS: "is requested to", "is invited to", "should submit", "must provide", "carry out", "undertake", "prepare and submit"
- DIRECTED AT APPLICANT: "The applicant...", "You are requested...", "Please submit..."
- Document is ASKING for information, NOT responding to previous requests

Look for FORMAL REQUEST LANGUAGE such as:
- 'The applicant is requested to submit...'
- 'The applicant is invited to provide...'
- 'The applicant should prepare and submit...'
- 'A [report type] is required to be submitted...'
- 'Please submit the following: ...'
- 'You are requested to carry out...'
- 'The planning authority requires the applicant to...'

Also look for STRUCTURAL INDICATORS:
- Numbered or lettered requirements (1., 2., (a), (b), etc.)
- References to council departments or planning officers
- Phrases like 'for this application', 'in relation to planning application ref...'
- Council letterhead or formal government formatting
- Deadlines for submission of information

CRITICAL - REJECT (mark as false) if document shows:
- "Further Information Received" (applicant has submitted, request already fulfilled)
- "FI Response" or "Response to FI Request" (applicant responding)
- "Please refer to..." followed by report names (applicant referencing submitted reports)
- "We have submitted..." / "We have provided..." (applicant speaking)
- Quotes from old FI requests followed by responses (e.g., "ITEM 2: Please submit... [Response:] Please refer to...")
- "Acoustic Report prepared by..." (existing report, not a request)
- "Objector recommends FI request for..." (third party, not planning authority)
- "Planning policy requires..." (general policy, not specific request)
- Just titles or headers without request context
- Acknowledgment letters without specific requests
- Cover letters stating information has been received or is enclosed

STRICT RULE: When in doubt, mark as isFIRequest=false. Better to miss than create false positive.
If document contains BOTH a quoted old request AND a response, it is a RESPONSE document (mark false).

Return JSON for detect_fi_request – isFIRequest true/false.`;
  }

  get SYSTEM_FI_MATCH() {
    return `You are given a formal Further Information request from a planning authority and a target report type.
    Your job is to determine if this FI request asks for SPECIFIC information related to the target report type.

CRITICAL DISTINCTION:
- "An acoustic report was submitted" = FALSE (report exists, not requested)
- "The applicant should submit an acoustic report" = TRUE (report is being requested)

STRICT MATCHING CRITERIA - ALL must be present:
1. Evidence of a REQUEST (not just mention) - must have request verbs
2. The request must be FROM planning authority TO applicant
3. The specific report type must be mentioned IN THE REQUEST
4. The report type and request verb must appear in same context (same sentence or adjacent sentences)

REQUEST VERBS (must appear with report type):
- submit, provide, prepare, carry out, undertake, produce, include, supply
- is required, is requested, is necessary, should be submitted, must be provided, needs to be

Look for these specific REQUEST patterns:
- 'acoustic': "submit acoustic assessment", "provide noise impact assessment", "carry out acoustic survey", "noise monitoring is required", "undertake noise assessment"
- 'transport': "submit transport assessment", "provide traffic impact assessment", "carry out parking survey", "travel plan is required", "undertake transport study"
- 'ecological': "submit ecological assessment", "provide biodiversity survey", "carry out habitat assessment", "ecological survey is required", "undertake ecological study"
- 'flood': "submit flood risk assessment", "provide drainage strategy", "carry out SUDS assessment", "hydrology report is required", "undertake flood study"
- 'heritage': "submit heritage assessment", "provide archaeological survey", "carry out historic impact assessment", "heritage study is required"
- 'lighting': "submit lighting assessment", "provide light pollution study", "carry out lighting impact assessment", "lighting study is required"

REJECT patterns (mark as FALSE):
- "Acoustic Report by ABC Consultants" (existing report title)
- "The acoustic report shows..." (discussing existing report)
- "Objector recommends acoustic assessment" (third party suggestion, not planning authority request)
- "Planning policy requires acoustic assessments" (general policy, not specific request)
- "noise" mentioned but no request for noise assessment
- Report type keyword appears but NOT in request context

VALIDATION CHECKLIST:
1. Is there a request verb (submit, provide, carry out, etc.)?
2. Is the planning authority making the request?
3. Is the specific report type mentioned?
4. Are the request verb and report type in the same context (same sentence or adjacent)?

STRICT RULE: If ANY of these 4 criteria are not met, return FALSE.
When in doubt, be SELECTIVE rather than inclusive - only match clear, unambiguous requests.
Better to miss a potential match than create a false positive.

Return JSON for match_fi_request – requestsReportType true/false.`;
  }

  get SYSTEM_EXTRACT_FI_REQUEST() {
    return `You extract key information from Further Information (FI) requests from planning authorities.
    Focus on:

    • **RequestingAuthority** – the planning authority or officer making the request
    • **RequestDate** – date of the request if mentioned
    • **Summary** – ≤ 60 words summary of what information is being requested
    • **SpecificRequests** – detailed breakdown of what is being asked for, INCLUDING direct quotes showing request verbs (submit, provide, carry out, etc.) with the specific items requested
    • **Deadline** – any deadline mentioned for response
    • **ReferenceNumbers** – any planning application or case reference numbers

    CRITICAL for SpecificRequests field:
    - Include EXACT QUOTES from the document showing request language
    - Each quote must contain a REQUEST VERB (submit, provide, carry out, undertake, prepare, etc.)
    - Format as: "Quote: 'The applicant is requested to submit...' - Requesting: [what is being requested]"
    - This will be validated - quotes without request verbs will be flagged

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
   * Split text into sentences for sentence-level matching
   */
  splitIntoSentences(text) {
    // Crude but effective for planning prose
    return text
      .replace(/\n+/g, ' ')
      .split(/(?<=[\.\!\?;:])\s+/)
      .map(x => x.trim())
      .filter(Boolean);
  }

  /**
   * Quick keyword filter - SURGICAL PRECISION VERSION
   * Implements strict gates to eliminate false positives.
   * ACCOUNTABILITY: Logs exact matching phrase when passes.
   */
  quickKeywordFilter(text, keyword) {
    // HIGH PRECISION FI INDICATORS
    const fiIndicators = [
      "request for further information",
      "further information request",
      "clarification of further information",
      "you are requested to",
      "the applicant is requested to",
      "please submit the following",
      "please submit",
      "is requested to submit",
      "is required to submit",
      "must be submitted",
      "must provide",
    ];

    // NEGATIVE GATES
    const negativeFIIndicators = [
      "response to further information",
      "response to clarification of further information",
      "clarification response",
      "we have submitted", "we have provided", "the applicant has submitted",
      "grant permission", "permission is granted", "conditions set out",
      "subject to conditions", "decision to grant", "decision: grant",
      "refuse permission", "decision to refuse"
    ];

    const textLower = text.toLowerCase();

    // GATE 1: Negative indicators
    if (negativeFIIndicators.some(p => textLower.includes(p))) {
      return false;
    }

    // GATE 2: Strict FI indicators
    const hasFIIndicator = fiIndicators.some(indicator => textLower.includes(indicator));
    if (!hasFIIndicator) {
      return false;
    }

    const keywordLower = keyword.toLowerCase();

    // Report type keywords
    const relatedTerms = {
      "acoustic": ["noise", "sound", "decibel", "db", "vibration", "noise assessment", "sound level", "acoustic"],
      "transport": ["traffic", "vehicle", "highway", "road", "parking", "transport assessment", "car park", "mobility", "transport"],
      "ecological": ["ecology", "wildlife", "habitat", "species", "biodiversity", "environment", "ecological", "nature", "flora", "fauna"],
      "flood": ["drainage", "water", "sewage", "storm", "rainfall", "suds", "surface water", "attenuation", "flood"],
      "heritage": ["archaeological", "historic", "conservation", "listed", "cultural", "monument", "archaeology", "heritage"],
      "arboricultural": ["tree", "trees", "vegetation", "landscape", "planting", "hedge", "woodland", "green", "arboricultural"],
      "waste": ["waste", "refuse", "recycling", "bin", "storage", "collection", "disposal", "management plan"],
      "lighting": ["lighting", "light", "illumination", "lumens", "lux", "lamp"]
    };

    // GATE 3: Report type keywords present
    const hasReportTypeKeyword = relatedTerms[keywordLower]?.some(term => textLower.includes(term)) || textLower.includes(keywordLower);
    if (!hasReportTypeKeyword) {
      return false;
    }

    // GATE 4: Construction noise rejection
    const constructionNoisePatterns = [
      "laeq", "construction phase", "hours monday to friday",
      "site development works shall be confined", "db(a)",
      "best practicable means to prevent/minimise noise"
    ];

    if (keywordLower === "acoustic" || relatedTerms[keywordLower]?.includes("noise")) {
      if (constructionNoisePatterns.some(p => textLower.includes(p))) {
        return false;
      }
    }

    // GATE 5: Sentence-level verb+term matching
    const requestVerbs = [
      "submit", "provide", "prepare", "carry out", "undertake", "produce",
      "supply", "is required to", "is requested to", "should be submitted",
      "must be provided", "needs to be"
    ];

    const reportTypeTerms = relatedTerms[keywordLower] || [keywordLower];
    const sentences = this.splitIntoSentences(textLower);

    let foundSentenceMatch = false;
    let matchingSentence = '';

    for (let i = 0; i < sentences.length; i++) {
      const s = sentences[i];
      const hasVerb = requestVerbs.some(v => s.includes(v));
      const hasTerm = reportTypeTerms.some(t => s.includes(t));

      if (hasVerb && hasTerm) {
        foundSentenceMatch = true;
        matchingSentence = s.substring(0, 200); // First 200 chars of matching sentence
        break;
      }

      // Check adjacent sentences
      if (i + 1 < sentences.length) {
        const s2 = sentences[i + 1];
        const combo = s + " " + s2;
        const hasVerb2 = requestVerbs.some(v => combo.includes(v));
        const hasTerm2 = reportTypeTerms.some(t => combo.includes(t));
        if (hasVerb2 && hasTerm2) {
          foundSentenceMatch = true;
          matchingSentence = combo.substring(0, 200); // First 200 chars
          break;
        }
      }
    }

    if (!foundSentenceMatch) {
      return false;
    }

    // GATE 6: Directionality
    const authorityToApplicantMarkers = [
      "the applicant is requested",
      "you are requested",
      "please submit",
      "the planning authority requests",
      "the planning authority requires",
      "council requires",
      "council requests",
    ];

    const hasDirectionality = authorityToApplicantMarkers.some(m => textLower.includes(m));
    if (!hasDirectionality) {
      return false;
    }

    // ACCOUNTABILITY: Store the matching sentence for logging
    this._lastMatchingSentence = matchingSentence;
    return true;
  }

  /**
   * LAYER 2: Cheap AI pre-filter
   * Uses first 10k chars (~4 pages) + last 5k chars with simple yes/no prompt
   * Cost: ~75% cheaper than full analysis
   * Purpose: Fast rejection of unrelated documents (invoices, photos, general correspondence)
   * Checks both beginning (standalone FI letters) and end (FI recommendations in reports)
   */
  async cheapFIFilter(documentText) {
    try {
      // Check beginning (first 10k) and end (last 5k) to catch both:
      // - Standalone FI request letters (start at beginning)
      // - FI recommendations at end of planning reports
      let sampleText;
      if (documentText.length <= 10000) {
        sampleText = documentText;
      } else if (documentText.length <= 15000) {
        sampleText = documentText.substring(0, 10000);
      } else {
        // Take first 10k + last 5k
        const beginning = documentText.substring(0, 10000);
        const ending = documentText.substring(documentText.length - 5000);
        sampleText = beginning + "\n\n[...document middle omitted...]\n\n" + ending;
      }
      
      const prompt = `Does this document REQUEST further information about a planning application?

Answer YES only if:
- A planning authority is REQUESTING information from an applicant/agent
- It uses language like "you are requested to submit", "please provide", "further information is required"

Answer NO if:
- It's responding TO a request ("in response to your request")
- It's a technical report or study
- It's a decision letter (granting/refusing permission)
- It's unrelated to planning (invoice, photo, general correspondence)

Document sample:
${sampleText}

Answer with just YES or NO.`;

      const result = await this.client.chat.completions.create({
        model: this.MODEL,
        messages: [
          { role: "system", content: "You are a document classifier. Answer only YES or NO." },
          { role: "user", content: prompt }
        ],
        temperature: 0,
        max_tokens: 10
      });

      const answer = result.choices[0].message.content.trim().toUpperCase();
      const passes = answer.includes('YES');
      
      logger.info(`Cheap AI filter: ${passes ? 'PASS' : 'REJECT'} (answer: ${answer})`);
      return passes;
    } catch (error) {
      logger.error('Error in cheap AI filter:', error);
      // On error, let it pass to full analysis (fail open)
      return true;
    }
  }

  /**
   * LAYER 3: Full AI detection
   * Detect if document is an FI request (no pre-screening, let AI decide)
   */
  async detectFIRequest(documentText) {
    try {
      // No pre-screening here - Layer 1 (structural) and Layer 2 (cheap AI) already filtered
      // Let full AI handle all nuanced detection
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
   * Returns object with match result and validation quote
   * NOTE: Quick filter bypassed - AI handles all detection to reduce false negatives
   * BUT negative indicators are still checked to reject obvious responses
   */
  async matchFIRequestType(documentText, targetReportType) {
    try {
      // GATE 1: Check for negative indicators (responses, not requests)
      // CRITICAL: Only use phrases that are EXCLUSIVE to responses/reports
      const negativeFIIndicators = [
        "response to further information",
        "in response to your request for further information",
        "following your request for further information",
        "the further information received",
        "further information has been received",
        "fi received",
        "f.i. received",
        "we have submitted the following",
        "enclosed please find the requested",
        "attached herewith the further information",
        "permission is hereby granted",
        "it is proposed to grant permission",
        "decision to grant permission",
        "it is proposed to refuse permission",
        "decision to refuse permission",
        // Consultant report indicators
        "were engaged to undertake",
        "were engaged by",
        "commissioned to undertake",
        "this report has been prepared by"
      ];

      const textLower = documentText.toLowerCase();
      
      // Reject if contains negative indicators
      if (negativeFIIndicators.some(indicator => textLower.includes(indicator))) {
        return {
          matches: false,
          validationQuote: 'Rejected: Document appears to be a response/decision, not a request'
        };
      }

      // Send directly to AI without positive pre-filtering
      const result = await this.runChat(
        [
          { role: "system", content: this.SYSTEM_FI_MATCH },
          { role: "user", content: `Target report type: ${targetReportType}\n\n${documentText}` }
        ],
        [this.FI_MATCH_FUNCTION],
        "match_fi_request"
      );

      // If it matches, extract a validation quote from the document
      let validationQuote = 'No specific quote extracted';
      if (result.requestsReportType) {
        validationQuote = this.extractValidationQuote(documentText, targetReportType);
        
        // POST-AI VALIDATION: Verify the validation quote actually mentions the target report type
        // This catches false positives where AI says "yes" but can't find actual request text
        if (validationQuote && validationQuote !== 'No specific quote extracted') {
          const reportTypeTerms = {
            "acoustic": ["noise", "sound", "acoustic", "decibel", "db", "vibration"],
            "transport": ["traffic", "vehicle", "highway", "road", "parking", "transport", "mobility"],
            "ecological": ["ecology", "ecological", "habitat", "species", "biodiversity", "wildlife"],
            "flood": ["flood", "drainage", "suds", "hydrology", "water", "surface water"],
            "heritage": ["heritage", "archaeological", "historic", "conservation", "listed"],
            "lighting": ["lighting", "light", "illumination", "luminaire", "lux"]
          };
          
          const terms = reportTypeTerms[targetReportType.toLowerCase()] || [targetReportType];
          const quoteContainsReportType = terms.some(term => 
            validationQuote.toLowerCase().includes(term.toLowerCase())
          );
          
          if (!quoteContainsReportType) {
            logger.info(`Post-AI validation failed: Quote doesn't mention ${targetReportType}. Quote: "${validationQuote.substring(0, 100)}..."`);
            return {
              matches: false,
              validationQuote: `Rejected: AI matched but validation quote doesn't mention ${targetReportType}`
            };
          }
        } else {
          // No validation quote found - reject
          logger.info(`Post-AI validation failed: No validation quote found for ${targetReportType}`);
          return {
            matches: false,
            validationQuote: 'Rejected: No validation quote containing request found'
          };
        }
      }

      return {
        matches: result.requestsReportType,
        validationQuote: validationQuote
      };
    } catch (error) {
      logger.error('Error matching FI request type:', error);
      throw error;
    }
  }

  /**
   * Extract a validation quote from document text
   * Finds sentences containing both request verbs and report type keywords
   */
  extractValidationQuote(documentText, targetReportType) {
    const requestVerbs = [
      "submit", "provide", "prepare", "carry out", "undertake", "produce",
      "supply", "required", "requested", "necessary", "should be submitted",
      "must be provided", "needs to be", "please submit", "you are requested",
      "the applicant is requested", "further information", "clarification"
    ];

    // Response document indicators - if we see these, it's NOT a request
    const responseIndicators = [
      "this report",
      "this assessment",
      "executive summary",
      "table of contents",
      "methodology",
      "prepared by",
      "report prepared",
      "conclusions and recommendations",
      "findings",
      "survey results",
      "results section"
    ];

    const reportTypeTerms = {
      "acoustic": ["noise", "sound", "acoustic", "decibel", "db", "vibration", "noise assessment", "sound level"],
      "transport": ["traffic", "vehicle", "highway", "road", "parking", "transport assessment", "car park", "mobility", "transport"],
      "ecological": ["ecology", "wildlife", "habitat", "species", "biodiversity", "environment", "ecological", "nature", "flora", "fauna"],
      "flood": ["drainage", "water", "sewage", "storm", "rainfall", "suds", "surface water", "attenuation", "flood"],
      "heritage": ["archaeological", "historic", "conservation", "listed", "cultural", "monument", "archaeology", "heritage"],
      "arboricultural": ["tree", "trees", "vegetation", "landscape", "planting", "hedge", "woodland", "green", "arboricultural"],
      "waste": ["waste", "refuse", "recycling", "bin", "storage", "collection", "disposal"],
      "lighting": ["lighting", "light", "illumination", "lumens", "lux", "lamp"]
    };

    const textLower = documentText.toLowerCase();
    const sentences = this.splitIntoSentences(textLower);
    const terms = reportTypeTerms[targetReportType.toLowerCase()] || [targetReportType.toLowerCase()];

    // Find sentences with both request verbs and report type terms
    // BUT reject if it contains response/report language
    for (let i = 0; i < sentences.length; i++) {
      const sentence = sentences[i];
      const hasVerb = requestVerbs.some(v => sentence.includes(v));
      const hasTerm = terms.some(t => sentence.includes(t));
      const hasResponseIndicator = responseIndicators.some(r => sentence.includes(r));

      if (hasVerb && hasTerm && !hasResponseIndicator) {
        // Return first 200 chars of matching sentence
        return sentence.substring(0, 200) + (sentence.length > 200 ? '...' : '');
      }

      // Check adjacent sentences
      if (i + 1 < sentences.length) {
        const combo = sentence + " " + sentences[i + 1];
        const hasVerb2 = requestVerbs.some(v => combo.includes(v));
        const hasTerm2 = terms.some(t => combo.includes(t));
        const hasResponse2 = responseIndicators.some(r => combo.includes(r));
        if (hasVerb2 && hasTerm2 && !hasResponse2) {
          return combo.substring(0, 200) + (combo.length > 200 ? '...' : '');
        }
      }
    }

    // Fallback: return first mention of report type with context
    for (const term of terms) {
      const idx = textLower.indexOf(term);
      if (idx !== -1) {
        const start = Math.max(0, idx - 50);
        const end = Math.min(textLower.length, idx + 150);
        return '...' + documentText.substring(start, end) + '...';
      }
    }

    return 'Match confirmed by AI but no specific quote extracted';
  }

  /**
   * Validate that extracted FI request info contains actual request language
   * Also checks for response indicators to reject FI response/received documents
   * @param {Object} extractedInfo - The extracted FI request information
   * @param {string} targetReportType - The report type we're looking for
   * @returns {Object} - Validation result with isValid flag and reasons
   */
  validateFIRequestExtraction(extractedInfo, targetReportType) {
    // Request verbs - REMOVED "include" as it's too generic
    const requestVerbs = [
      "submit", "provide", "prepare", "carry out", "undertake", "produce",
      "supply", "required", "requested", "necessary",
      "should be submitted", "must be provided", "needs to be", "is to be"
    ];

    // Response indicators - these suggest it's a RESPONSE not a REQUEST
    const responseIndicators = [
      "please refer to", "as outlined in", "as detailed in",
      "the assessment", "the report", "prepared by",
      "we have submitted", "we have provided", "has been submitted",
      "further information received", "fi response", "response to fi",
      "in response to", "following receipt", "submitted on"
    ];

    const validation = {
      isValid: true,
      reasons: [],
      warnings: []
    };

    // Check if SpecificRequests contains request verbs
    const specificRequests = extractedInfo.SpecificRequests || extractedInfo.Summary || '';
    const requestsLower = specificRequests.toLowerCase();

    // CRITICAL: Check for response indicators first
    const hasResponseIndicator = responseIndicators.some(indicator => requestsLower.includes(indicator));
    if (hasResponseIndicator) {
      validation.isValid = false;
      validation.reasons.push('Document appears to be a FI RESPONSE/RECEIVED document, not a request. Contains response language like "please refer to", "the report", "prepared by", etc.');
      return validation;
    }

    // STRICT: Must contain BOTH a request verb AND the target report term
    const reportTypeKeywords = {
      "acoustic": ["acoustic", "noise", "sound"],
      "transport": ["transport", "traffic", "parking", "highway"],
      "ecological": ["ecological", "ecology", "biodiversity", "habitat", "wildlife"],
      "flood": ["flood", "drainage", "suds", "hydrology"],
      "heritage": ["heritage", "archaeological", "historic"],
      "lighting": ["lighting", "light", "illumination"],
      "arboricultural": ["tree", "arboricultural", "vegetation"],
      "waste": ["waste", "refuse", "recycling"]
    };

    const reportTerms = (reportTypeKeywords[targetReportType.toLowerCase()] || [targetReportType]).map(x => x.toLowerCase());

    const hasRequestVerb = requestVerbs.some(verb => requestsLower.includes(verb));
    const hasReportTerm = reportTerms.some(term => requestsLower.includes(term));

    if (!hasRequestVerb || !hasReportTerm) {
      validation.isValid = false;
      if (!hasRequestVerb) {
        validation.reasons.push(`No request verbs found in extracted requests. Found text: "${specificRequests.substring(0, 100)}..."`);
      }
      if (!hasReportTerm) {
        validation.reasons.push(`Target report type "${targetReportType}" not found in extracted requests`);
      }
      // Combined check
      validation.reasons.push(`SpecificRequests must contain BOTH a request verb AND the target report term.`);
    }

    // Check if Summary is too generic
    const genericPhrases = [
      "further information required",
      "additional information needed",
      "clarification required"
    ];

    if (extractedInfo.Summary && genericPhrases.some(phrase => extractedInfo.Summary.toLowerCase().includes(phrase))) {
      validation.warnings.push('Summary appears generic - may not be specific enough');
    }

    // Validate that we have meaningful content
    if (!specificRequests || specificRequests.length < 20) {
      validation.isValid = false;
      validation.reasons.push('Extracted requests are too short or empty');
    }

    return validation;
  }

  /**
   * Extract information from FI request
   */
  async extractFIRequestInfo(documentText, fileName = '', targetReportType = '') {
    try {
      const result = await this.runChat(
        [
          { role: "system", content: this.SYSTEM_EXTRACT_FI_REQUEST },
          { role: "user", content: documentText }
        ],
        [this.EXTRACTION_FUNCTION],
        "extract_fi_request"
      );

      // Validate the extraction if we have a target report type
      if (targetReportType) {
        const validation = this.validateFIRequestExtraction(result, targetReportType);

        if (!validation.isValid) {
          logger.warn(`⚠️ Extraction validation FAILED for ${targetReportType}:`, {
            fileName,
            reasons: validation.reasons,
            extractedSummary: result.Summary?.substring(0, 100)
          });

          // Return null to indicate this is not a valid FI request for this report type
          return null;
        }

        if (validation.warnings.length > 0) {
          logger.warn(`⚠️ Extraction validation warnings for ${targetReportType}:`, validation.warnings);
        }
      }

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
   * Combined detection and processing
   * ACCOUNTABILITY: Logs exact phrase that triggered match
   */
  async processFIRequest(documentText, targetReportType, fileName = '') {
    try {
      // CACHE CHECK
      const cacheKey = this.generateCacheKey(documentText, targetReportType, fileName);
      const cachedResult = this.getCachedResult(cacheKey);
      if (cachedResult) {
        return cachedResult;
      }

      // QUICK PRE-FILTER
      if (!this.quickKeywordFilter(documentText, targetReportType)) {
        const result = {
          isFIRequest: false,
          matchesTargetType: false,
          extractedInfo: null,
          detectionMethod: 'quick_filter_reject'
        };
        this.setCachedResult(cacheKey, result);
        return result;
      }

      // AI VALIDATION: Step 1 - Is this an FI request?
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

      // AI VALIDATION: Step 2 - Does it match the target report type?
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

      // EXTRACTION with validation
      const extractedInfo = await this.extractFIRequestInfo(documentText, fileName, targetReportType);
      if (!extractedInfo) {
        const result = {
          isFIRequest: true,
          matchesTargetType: false,
          extractedInfo: null,
          detectionMethod: 'ai_extraction_validation_failed'
        };
        this.setCachedResult(cacheKey, result);
        return result;
      }

      // SUCCESS - Log exact matching phrase
      const matchingSentence = this._lastMatchingSentence || 'N/A';
      logger.info(`🎯 MATCH | File: ${fileName} | Type: ${targetReportType} | Phrase: "${matchingSentence}"`);

      const result = {
        isFIRequest: true,
        matchesTargetType: true,
        extractedInfo,
        matchingSentence, // Include for accountability
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
  }

  /**
   * Process FI requests with API-based project filtering - ENHANCED WITH DOCFILES.TXT AND REPORT SAVING
   */
  async processFIRequestWithFiltering(reportTypes, apiParams = {}, customerData = [], saveReport = true) {
    const startTime = Date.now();

    try {
      logger.info('🚀 Starting FI detection with API filtering + docfiles.txt optimization');

      // Import services
      const buildingInfoService = require('./buildingInfoService');
      const s3Service = require('./s3Service');
      const docfilesService = require('./docfilesService');

      let filteredProjectIds = [];
      let projectData = [];

      // Step 1: Get filtered project IDs from API if filters are applied
      if (Object.keys(apiParams).length > 0) {
        logger.info('🔍 Fetching projects from Building Info API with filters:', apiParams);
        const apiResult = await buildingInfoService.getProjectsByParams(apiParams);
        filteredProjectIds = apiResult.projectIds;
        projectData = apiResult.projectData;

        logger.info(`✅ API returned ${filteredProjectIds.length} filtered project IDs`);
        if (filteredProjectIds.length > 0) {
          logger.info(`📋 First 10 project IDs: ${filteredProjectIds.slice(0, 10).join(', ')}${filteredProjectIds.length > 10 ? '...' : ''}`);
        }
      } else {
        // If no API filters, get all projects from planning-docs folder
        logger.info('ℹ️ No API filters applied, getting all projects from planning-docs');
        const planningDocsProjects = await s3Service.listPlanningDocsProjects();
        filteredProjectIds = planningDocsProjects.map(p => p.projectId);

        logger.info(`📂 Found ${filteredProjectIds.length} projects in planning-docs folder`);
      }

      if (filteredProjectIds.length === 0) {
        logger.warn('No projects found with applied filters');
        return {
          success: false,
          message: 'No projects found with the applied filters',
          results: []
        };
      }

      // Step 2: DOCFILES.TXT FIRST-PASS FILTER
      logger.info('� Starting docfiles.txt analysis for rapid FI detection...');
      const docfilesMatches = [];
      const projectsWithoutDocfiles = [];
      const processingStats = {
        totalProjects: filteredProjectIds.length,
        projectsWithDocfiles: 0,
        projectsWithoutDocfiles: 0,
        docfilesMatches: 0,
        individualDocProcessed: 0,
        fiRequestsFound: 0,
        matchesByReportType: {},
        projectsWithMatches: new Set(),
        earlyTerminations: 0
      };

      // Initialize report type counters
      reportTypes.forEach(type => {
        processingStats.matchesByReportType[type] = 0;
      });

      // Check each project for docfiles.txt
      for (const projectId of filteredProjectIds) {
        try {
          const hasDocfiles = await docfilesService.checkDocfilesExists(projectId);

          if (hasDocfiles) {
            processingStats.projectsWithDocfiles++;

            // Get and analyze docfiles.txt
            const docfilesContent = await docfilesService.getDocfilesContent(projectId);
            const docfilesAnalysis = await docfilesService.analyzeDocfilesForFI(
              docfilesContent,
              projectId,
              reportTypes
            );

            if (docfilesAnalysis.hasFIRequests) {
              processingStats.docfilesMatches++;

              // Check which report types match
              for (const reportType of reportTypes) {
                if (docfilesAnalysis.reportTypeMatches[reportType]) {
                  processingStats.matchesByReportType[reportType]++;
                  processingStats.fiRequestsFound++;
                  processingStats.projectsWithMatches.add(projectId);

                  // Get project metadata
                  let projectMetadata = null;
                  if (projectData.length > 0) {
                    projectMetadata = projectData.find(p => p.planning_id === projectId);
                  }
                  if (!projectMetadata) {
                    projectMetadata = await buildingInfoService.getProjectMetadata(projectId);
                  }

                  // Enhance projectMetadata with computed fields for email templates
                  if (projectMetadata) {
                    projectMetadata.bii_url = this.constructBiiUrl(projectMetadata);
                    projectMetadata.planning_sector = this.mapPlanningSector(projectMetadata.planning_category, projectMetadata.planning_subcategory);
                  }

                  // Create match record
                  docfilesMatches.push({
                    projectId: projectId,
                    documentName: 'docfiles.txt',
                    documentPath: `planning-docs/${projectId}/docfiles.txt`,
                    reportType: reportType,
                    confidence: 0.95, // High confidence from consolidated analysis
                    matchedText: docfilesAnalysis.summary,
                    fiDetails: {
                      Summary: docfilesAnalysis.summary,
                      SpecificRequests: docfilesAnalysis.fiDetails
                        .filter(d => d.reportType === reportType)
                        .map(d => d.quote)
                        .join('; ')
                    },
                    // Extract email-ready data from metadata
                    planningTitle: projectMetadata?.planning_title || 'Title unavailable',
                    planningStage: projectMetadata?.planning_stage || 'Unknown',
                    planningValue: projectMetadata?.planning_value || 0,
                    planningCounty: projectMetadata?.planning_county || 'Unknown',
                    planningRegion: projectMetadata?.planning_region || 'Unknown',
                    planningSector: this.mapPlanningSector(projectMetadata?.planning_category, projectMetadata?.planning_subcategory) || 'N/A',
                    biiUrl: this.constructBiiUrl(projectMetadata) || '',
                    fiIndicators: docfilesAnalysis.fiDetails
                      .filter(d => d.reportType === reportType)
                      .map(d => d.quote),
                    matchedKeywords: [reportType],
                    projectMetadata: projectMetadata,
                    fullMetadata: projectMetadata,
                    detectionMethod: docfilesAnalysis.detectionMethod
                  });
                }
              }
            }
          } else {
            processingStats.projectsWithoutDocfiles++;
            projectsWithoutDocfiles.push(projectId);
          }
        } catch (error) {
          logger.warn(`Error processing docfiles for project ${projectId}:`, error);
          projectsWithoutDocfiles.push(projectId);
          processingStats.projectsWithoutDocfiles++;
        }
      }

      logger.info(`📊 DOCFILES ANALYSIS COMPLETE:`);
      logger.info(`   - Projects with docfiles.txt: ${processingStats.projectsWithDocfiles}`);
      logger.info(`   - Projects without docfiles.txt: ${processingStats.projectsWithoutDocfiles}`);
      logger.info(`   - FI matches found via docfiles: ${processingStats.docfilesMatches}`);
      logger.info(`   - Projects needing individual doc analysis: ${projectsWithoutDocfiles.length}`);

      // Step 3: FALLBACK TO INDIVIDUAL DOCUMENT ANALYSIS (only for projects without docfiles.txt)
      if (projectsWithoutDocfiles.length > 0) {
        logger.info(`🔍 Processing ${projectsWithoutDocfiles.length} projects with individual document analysis...`);

        // Get documents for projects without docfiles
        const documents = await s3Service.listFilteredProjectDocuments(projectsWithoutDocfiles);
        logger.info(`📄 Found ${documents.length} individual documents to process`);

        // Group documents by project for early termination
        const documentsByProject = {};
        documents.forEach(doc => {
          if (!documentsByProject[doc.projectId]) {
            documentsByProject[doc.projectId] = [];
          }
          documentsByProject[doc.projectId].push(doc);
        });

        // Process each report type
        for (const reportType of reportTypes) {
          logger.info(`🔍 Processing ${reportType} across projects without docfiles.txt`);

          let processedCount = 0;
          const projectsFoundForThisType = new Set();

          // Process by project for early termination
          for (const projectId of projectsWithoutDocfiles) {
            const projectDocs = documentsByProject[projectId] || [];
            if (projectDocs.length === 0) continue;

            let foundFIForProject = false;

            for (const doc of projectDocs) {
              try {
                processedCount++;
                processingStats.individualDocProcessed++;

                // Log progress every 10 documents
                if (processedCount % 10 === 0) {
                  logger.info(`📈 Progress: ${processedCount}/${documents.length} individual docs processed for ${reportType} (${Math.round((processedCount/documents.length)*100)}%) - Found FI in ${projectsFoundForThisType.size} projects`);
                }

                // Stream document for processing
                const streamResult = await s3Service.getDocumentBuffer(doc.key);
                const documentProcessor = require('./documentProcessor');
                const processedDoc = await documentProcessor.processDocumentFromBuffer(
                  streamResult.buffer,
                  streamResult.fileName
                );

                // Process FI request detection
                const fiResult = await this.processFIRequest(
                  processedDoc.text,
                  reportType,
                  doc.fileName
                );

                if (fiResult.isFIRequest && fiResult.matchesTargetType) {
                  processingStats.fiRequestsFound++;
                  processingStats.matchesByReportType[reportType]++;
                  foundFIForProject = true;
                  projectsFoundForThisType.add(projectId);
                  processingStats.projectsWithMatches.add(projectId);

                  // Get project metadata
                  let projectMetadata = null;
                  if (projectData.length > 0) {
                    projectMetadata = projectData.find(p => p.planning_id === doc.projectId);
                  }
                  if (!projectMetadata) {
                    projectMetadata = await buildingInfoService.getProjectMetadata(doc.projectId);
                  }

                  // Enhance projectMetadata with computed fields for email templates
                  if (projectMetadata) {
                    projectMetadata.bii_url = this.constructBiiUrl(projectMetadata);
                    projectMetadata.planning_sector = this.mapPlanningSector(projectMetadata.planning_category, projectMetadata.planning_subcategory);
                  }

                  docfilesMatches.push({
                    projectId: doc.projectId,
                    documentName: doc.fileName,
                    documentPath: doc.key,
                    reportType: reportType,
                    confidence: 0.9,
                    matchedText: fiResult.extractedInfo?.Summary || 'FI request detected',
                    fiDetails: fiResult.extractedInfo,
                    // Extract email-ready data from metadata
                    planningTitle: projectMetadata?.planning_title || 'Title unavailable',
                    planningStage: projectMetadata?.planning_stage || 'Unknown',
                    planningValue: projectMetadata?.planning_value || 0,
                    planningCounty: projectMetadata?.planning_county || 'Unknown',
                    planningRegion: projectMetadata?.planning_region || 'Unknown',
                    planningSector: this.mapPlanningSector(projectMetadata?.planning_category, projectMetadata?.planning_subcategory) || 'N/A',
                    biiUrl: this.constructBiiUrl(projectMetadata) || '',
                    fiIndicators: fiResult.extractedInfo ? [fiResult.extractedInfo.Summary] : [],
                    matchedKeywords: [reportType],
                    projectMetadata: projectMetadata,
                    fullMetadata: projectMetadata,
                    detectionMethod: fiResult.detectionMethod
                  });

                  // Early termination: stop processing this project for this report type
                  break;
                }

              } catch (docError) {
                logger.error(`Error processing individual document ${doc.fileName}:`, docError);
              }
            }

            // Track early termination
            if (foundFIForProject) {
              processingStats.earlyTerminations++;
            }
          }
        }
      }

      // Log final statistics
      logger.info(`📊 FI Detection Complete - Processed ${processingStats.totalProjects} projects, found ${processingStats.fiRequestsFound} FI requests`);
      logger.info(`   Breakdown by type: ${JSON.stringify(processingStats.matchesByReportType)}`);

      // Step 4: Group results by customer if customer data provided
      const customerMatches = {};
      if (customerData && customerData.length > 0) {
        // Create or find customer records in database
        for (const customer of customerData) {
          try {
            // Find or create customer record in database
            const customerRecord = await this.findOrCreateCustomer(customer, reportTypes);

            customerMatches[customer.email] = {
              email: customer.email,
              name: customerRecord.name,
              matches: [],
              customerId: customerRecord._id
            };
          } catch (error) {
            logger.error(`Failed to create/find customer ${customer.email}:`, error);
            // Fallback to in-memory customer data
            customerMatches[customer.email] = {
              email: customer.email,
              name: customer.name || customer.email.split('@')[0],
              matches: []
            };
          }
        }

        // Give ALL matches to ALL customers (each customer subscribed to these report types)
        const customerEmails = Object.keys(customerMatches);
        customerEmails.forEach(email => {
          customerMatches[email].matches = [...docfilesMatches];
        });
      }

      // Step 5: Save FI reports to database if requested
      let savedReports = [];
      if (saveReport && docfilesMatches.length > 0) {
        try {
          const searchCriteria = {
            reportTypes,
            apiParams,
            dateRange: apiParams.dateRange || {},
            projectTypes: apiParams.projectTypes || [],
            regions: apiParams.regions || []
          };

          // Convert customerMatches object to array with customer IDs included
          const enhancedCustomerData = Object.values(customerMatches).map(cm => ({
            email: cm.email,
            name: cm.name,
            id: cm.customerId // Use the MongoDB _id from the database
          }));

          savedReports = await this.saveFIReports(
            docfilesMatches,
            enhancedCustomerData.length > 0 ? enhancedCustomerData : customerData,
            searchCriteria,
            processingStats,
            startTime
          );

          logger.info(`💾 Saved ${savedReports.length} FI reports to database`);
        } catch (saveError) {
          logger.error('Error saving FI reports (continuing with results):', saveError);
          // Don't throw error, just log and continue with results
        }
      }

      return {
        success: true,
        results: docfilesMatches,
        customerMatches: Object.values(customerMatches),
        savedReports: savedReports.map(r => ({
          reportId: r.reportId,
          customerId: r.customerId,
          status: r.status,
          projectsFound: r.totalFIMatches
        })),
        processingStats,
        apiFilter: apiParams,
        cacheStats: this.getCacheStats(),
        docfilesCacheStats: docfilesService.getCacheStats()
      };

    } catch (error) {
      logger.error('Error in processFIRequestWithFiltering:', error);
      throw error;
    }
  }

  /**
   * Save FI detection results as reports for multiple customers
   * @param {Array} docfilesMatches - The FI detection results
   * @param {Array} customerData - Customer information
   * @param {Object} searchCriteria - The search parameters used
   * @param {Object} processingStats - Processing statistics
   * @param {number} startTime - Start timestamp for processing time calculation
   * @returns {Promise<Array>} Array of saved reports
   */
  async saveFIReports(docfilesMatches, customerData, searchCriteria, processingStats, startTime) {
    try {
      const savedReports = [];

      if (!customerData || customerData.length === 0) {
        logger.warn('No customer data provided, skipping report saving');
        return savedReports;
      }

      for (const customer of customerData) {
        // Each customer gets ALL matches for their subscribed report types
        const customerMatches = [...docfilesMatches];

        if (customerMatches.length === 0) {
          logger.info(`No FI matches for customer ${customer.email}`);
          continue;
        }

        // Prepare report data
        const reportData = {
          customerId: customer.id || customer.email,
          customerEmail: customer.email,
          customerName: customer.name || customer.email.split('@')[0],
          reportType: 'FI_DETECTION',
          status: 'GENERATED',

          searchCriteria: {
            keywords: searchCriteria.reportTypes || [],
            dateRange: searchCriteria.dateRange || {},
            projectTypes: searchCriteria.projectTypes || [],
            regions: searchCriteria.regions || [],
            customFilters: searchCriteria.apiParams || {}
          },

          projectsFound: customerMatches.map(match => ({
            projectId: match.projectId,
            planningTitle: match.planningTitle || 'Title unavailable',
            planningStage: match.planningStage || 'Unknown',
            planningValue: match.planningValue || 0,
            planningCounty: match.planningCounty || 'Unknown',
            planningRegion: match.planningRegion || 'Unknown',
            biiUrl: match.biiUrl || '',
            fiIndicators: match.fiIndicators || [],
            matchedKeywords: match.matchedKeywords || [],
            confidence: match.confidence || 0.8,
            metadata: match.fullMetadata || {}
          })),

          totalProjectsScanned: processingStats.totalProjects || 0,
          totalFIMatches: customerMatches.length,

          processingTime: Date.now() - startTime,
          source: 'MANUAL'
        };

        // Save the report
        const savedReport = await fiReportService.createReport(reportData);
        savedReports.push(savedReport);

        logger.info(`📊 Saved FI report ${savedReport.reportId} for customer ${customer.email}`, {
          customerId: customer.email,
          projectsFound: customerMatches.length,
          processingTime: reportData.processingTime
        });
      }

      return savedReports;
    } catch (error) {
      logger.error('Error saving FI reports:', error);
      throw error;
    }
  }  /**
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

  /**
   * Map planning category and subcategory to a readable sector
   */
  mapPlanningSector(category, subcategory) {
    if (!category) return 'N/A';

    const categoryMap = {
      'Residential': 'Residential',
      'Commercial': 'Commercial',
      'Industrial': 'Industrial',
      'Mixed Use': 'Mixed Use',
      'Infrastructure': 'Infrastructure',
      'Education': 'Education',
      'Healthcare': 'Healthcare',
      'Retail': 'Retail',
      'Office': 'Office',
      'Leisure': 'Leisure',
      'Transport': 'Transport',
      'Utilities': 'Utilities',
      'Agricultural': 'Agricultural',
      'Environmental': 'Environmental'
    };

    // Try exact match first
    if (categoryMap[category]) {
      return subcategory ? `${categoryMap[category]} - ${subcategory}` : categoryMap[category];
    }

    // Try partial matches
    const categoryLower = category.toLowerCase();
    for (const [key, value] of Object.entries(categoryMap)) {
      if (categoryLower.includes(key.toLowerCase()) || key.toLowerCase().includes(categoryLower)) {
        return subcategory ? `${value} - ${subcategory}` : value;
      }
    }

    // Return original if no mapping found
    return subcategory ? `${category} - ${subcategory}` : category;
  }
}

module.exports = new FIDetectionService();
