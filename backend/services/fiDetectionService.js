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
      maxRetries: 3
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
    return `You detect if a document is a Further Information (FI) request or a consultee recommendation for reports.

CRITICAL: Distinguish between:
1. ACTUAL FI REQUESTS: Planning authority ASKING applicant to provide/submit information (ACCEPT)
2. CONSULTEE RECOMMENDATIONS: Environmental Health, Highways, etc. RECOMMENDING the applicant submits a report (ACCEPT as lead)
3. FI RESPONSES/RECEIVED: Applicant RESPONDING to or SUBMITTING requested information (REJECT)
4. EXISTING DOCUMENTS: Reports or submissions that already exist (e.g., "Acoustic Report by XYZ") (REJECT)
5. CONSULTEE REVIEWS: Consultee has REVIEWED an existing report ("has reviewed the submitted") (REJECT)
6. FI RECEIVED COVER LETTERS: Documents stating FI has been received or submitted (REJECT)

Mark as isFIRequest=true if you find:

FORMAL FI REQUESTS:
- Clear evidence this is FROM the planning authority (letterhead, officer signature, formal council language)
- REQUEST VERBS: "is requested to", "is invited to", "should submit", "must provide", "carry out", "undertake", "prepare and submit"
- DIRECTED AT APPLICANT: "The applicant...", "You are requested...", "Please submit..."

OR CONSULTEE RECOMMENDATIONS (valuable leads):
- Environmental Health, Highways, or other consultees RECOMMENDING future reports
- Language: "would recommend the applicant submits", "this service recommends", "recommends submission of"
- Key: They are suggesting a report that DOES NOT YET EXIST

Look for FORMAL REQUEST LANGUAGE such as:
- 'The applicant is requested to submit...'
- 'The applicant is invited to provide...'
- 'The applicant should prepare and submit...'
- 'A [report type] is required to be submitted...'
- 'Please submit the following: ...'
- 'You are requested to carry out...'
- 'The planning authority requires the applicant to...'

Also look for CONSULTEE RECOMMENDATION LANGUAGE:
- 'Would recommend the applicant submits a noise impact assessment...'
- 'This service recommends submission of an acoustic report...'
- 'Environmental Health recommends a noise assessment be undertaken...'
- 'The applicant should address noise concerns through an acoustic survey...'

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
- "has reviewed the submitted" / "has received and reviewed" (consultee reviewing existing report)
- Quotes from old FI requests followed by responses (e.g., "ITEM 2: Please submit... [Response:] Please refer to...")
- "Acoustic Report prepared by..." (existing report, not a request)
- "Planning policy requires..." (general policy, not specific request)
- Just titles or headers without request context
- Acknowledgment letters without specific requests
- Cover letters stating information has been received or is enclosed

Return JSON for detect_fi_request – isFIRequest true/false.`;
  }

  get SYSTEM_FI_MATCH() {
    return `You are given a document (FI request or consultee recommendation) and a target report type.
    Your job is to determine if this document requests or recommends SPECIFIC information related to the target report type.

CRITICAL DISTINCTION:
- "An acoustic report was submitted" = FALSE (report exists, not requested)
- "The applicant should submit an acoustic report" = TRUE (report is being requested)
- "Would recommend the applicant submits a noise impact assessment" = TRUE (recommendation for future report)
- "Environmental Health has reviewed the submitted acoustic report" = FALSE (existing report reviewed)

MATCHING CRITERIA - ANY of these patterns:

FORMAL FI REQUESTS (planning authority requesting):
- REQUEST VERBS: submit, provide, prepare, carry out, undertake, produce, include, supply
- is required, is requested, is necessary, should be submitted, must be provided, needs to be

CONSULTEE RECOMMENDATIONS (valuable leads):
- RECOMMENDATION VERBS: recommend, recommends, would recommend, this service recommends
- should be provided, should be undertaken, should address
- "would recommend the applicant submits", "recommends submission of"

Look for these specific patterns with target report types:
- 'acoustic': "submit acoustic assessment", "provide noise impact assessment", "recommend noise assessment", "noise survey should be", "NIA required"
- 'transport': "submit transport assessment", "provide traffic impact", "recommend TA", "travel plan should be"
- 'ecological': "submit ecological assessment", "provide biodiversity survey", "recommend PEA", "bat survey should be"
- 'flood': "submit flood risk assessment", "provide drainage strategy", "FRA required", "SUDS should be"
- 'heritage': "submit heritage assessment", "provide archaeological survey", "WSI required"
- 'arboricultural': "submit tree survey", "arboricultural impact assessment", "AIA required"
- 'lighting': "submit lighting assessment", "provide light pollution study"

REJECT patterns (mark as FALSE):
- "Acoustic Report by ABC Consultants" (existing report title)
- "The acoustic report shows..." (discussing existing report)
- "has reviewed the submitted noise assessment" (reviewing existing report)
- "has received and reviewed" (consultee reviewing existing submission)
- "Planning policy requires acoustic assessments" (general policy, not specific request)
- "noise" mentioned but no request/recommendation for assessment
- Report type keyword appears but NOT in request/recommendation context

VALIDATION CHECKLIST:
1. Is there a request verb OR recommendation verb?
2. Is a planning authority/consultee making the request/recommendation?
3. Is the specific report type mentioned?
4. Are the verb and report type in the same context?
5. Is this about a FUTURE report (not an existing one)?

Return JSON for match_fi_request – requestsReportType true/false.`;
  }

  get SYSTEM_EXTRACT_FI_REQUEST() {
    return `You extract key information from Further Information requests or consultee recommendations.
    Focus on:

    • **RequestingAuthority** – the planning authority, consultee, or officer making the request/recommendation
    • **RequestDate** – date of the request if mentioned
    • **Summary** – ≤ 60 words summary of what information is being requested or recommended
    • **SpecificRequests** – detailed breakdown of what is being asked for, INCLUDING direct quotes showing request/recommendation verbs (submit, provide, recommend, etc.) with the specific items
    • **Deadline** – any deadline mentioned for response
    • **ReferenceNumbers** – any planning application or case reference numbers

    CRITICAL for SpecificRequests field:
    - Include EXACT QUOTES from the document showing request/recommendation language
    - Each quote must contain a REQUEST VERB (submit, provide, carry out) or RECOMMENDATION VERB (recommend, recommends, should be)
    - Format as: "Quote: 'The applicant is requested to submit...' - Requesting: [what is being requested]"
    - For recommendations: "Quote: 'This service recommends the applicant submits...' - Recommending: [what is recommended]"
    - This will be validated - quotes without appropriate verbs will be flagged

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

      // Yield to event loop before heavy PDF parsing
      await new Promise(resolve => setImmediate(resolve));

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
   * SELECTIVE REJECTION: Only reject files that are CLEARLY not FI requests/recommendations
   *
   * IMPORTANT: We do NOT reject based on:
   * - Email/correspondence patterns (may contain requests or recommendations)
   * - Consultation responses (may contain recommendations for future reports)
   *
   * We ONLY reject:
   * - Clear FI RESPONSES (applicant responding to FI request)
   * - Submitted reports (the actual report, not a request for one)
   *
   * Content analysis will determine if emails/correspondence contain valuable recommendations.
   *
   * @param {string} fileName - The filename to check
   * @returns {boolean} - true if file should be REJECTED (is clearly NOT an FI request/recommendation)
   */
  shouldRejectByFilename(fileName) {
    if (!fileName) return false;

    const filenameLower = fileName.toLowerCase();

    // NOTE: Email/correspondence patterns are NOT rejected
    // An email might say "please submit an acoustic report" - that's a valuable lead
    // Content-based analysis will catch responses vs requests

    // Patterns that indicate FI RESPONSES (applicant responding, NOT the request itself)
    const responsePatterns = [
      'fi-response', 'fi_response', 'fi-return', 'fi_return',
      'response-to-fi', 'response_to_fi', 'response-to-further',
      'further-information-response', 'further_information_response',
      'fi-submission', 'fi_submission', 'fi-reply', 'fi_reply',
      'fi-received', 'fi_received', 'fi-rec', 'fi_rec',
      'further-information-received', 'further_information_received',
      'response-to-request', 'response_to_request',
      'applicant-response', 'applicant_response',
      'agent-response', 'agent_response',
      // Substantive/Final replies
      'substantive-reply', 'substantive_reply', 'final-reply', 'final_reply',
      'final-response', 'final_response'
    ];

    // NOTE: The following are NOT rejected by filename (passed to content analysis):
    // - Consultation responses (EH, NIEA, etc.) - may contain recommendations
    // - Emails/correspondence - may contain explicit requests or recommendations
    // - Acknowledgments - context matters, content analysis will evaluate

    // Patterns that indicate submitted reports (existing reports, not requests)
    const submittedReportPatterns = [
      'acoustic-report', 'acoustic_report',
      'noise-assessment', 'noise_assessment',
      'noise-impact', 'noise_impact',
      'nia-report', 'nia_report',
      'transport-assessment', 'transport_assessment',
      'ecological-survey', 'ecological_survey',
      'flood-risk', 'flood_risk',
      '-submitted', '_submitted'
    ];

    // SELECTIVE REJECTION - Only reject clear FI responses and submitted reports
    // Emails/correspondence are NOT rejected - content analysis will evaluate them
    // Acknowledgments are also passed through - context matters
    const allRejectPatterns = [
      ...responsePatterns,
      ...submittedReportPatterns
    ];

    const shouldReject = allRejectPatterns.some(pattern => filenameLower.includes(pattern));

    if (shouldReject) {
      logger.info(`📛 Rejecting by filename pattern: ${fileName}`);
    }

    return shouldReject;
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
    // HIGH PRECISION FI INDICATORS - Formal requests
    const fiIndicators = [
      // Formal FI request language
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

      // Alternative request language
      "the council requests",
      "the authority requests",
      "additional information is required",
      "additional assessment required",
      "additional surveys required",
      "prior to a decision",
      "prior to any decision",
      "will be required to",
      "should be submitted",
      "should be provided",
      "should be undertaken",
      "assessment should be",
      "survey should be",

      // Consultation recommendation patterns (valuable leads)
      "would recommend the applicant",
      "recommends the applicant",
      "recommends that the applicant",
      "would recommend that",
      "this service recommends",
      "this department recommends",
      "would therefore recommend",
      "recommend submission of",
      "recommends submission of"
    ];

    // NEGATIVE GATES - Reject patterns that indicate responses, NOT format like email signatures
    // We ALLOW emails that contain requests - don't reject based on greetings/signatures
    const negativeFIIndicators = [
      // Response patterns (applicant responding to request)
      "response to further information",
      "response to clarification of further information",
      "clarification response",
      "we have submitted", "we have provided", "the applicant has submitted",
      "in response to your request",
      "in response to the request",

      // Decision patterns (planning decision made)
      "grant permission", "permission is granted", "conditions set out",
      "subject to conditions", "decision to grant", "decision: grant",
      "refuse permission", "decision to refuse",
      "we will condition", "this will be conditioned",

      // Review of existing submission (not a new request)
      "acknowledge receipt", "acknowledges receipt",
      "has reviewed the submitted", "reviewed the submitted",
      "receipt of this application",

      // NOTE: Email greetings/signatures NOT rejected - email may contain valid request
      // "good morning" + "please submit acoustic report" = valuable lead

      // Extension/waiting patterns (not a request, just correspondence)
      "waiting until", "waiting to", "can we please agree",

      // Submitted report discussion patterns (report ALREADY submitted - not a lead)
      "the submitted acoustic", "submitted noise assessment",
      "the acoustic report shows", "the noise report indicates",
      "has been submitted", "was submitted",
      "has received and reviewed", "received and reviewed the",
      "environmental health service has received",
      "environmental health has reviewed",

      // FI received/fulfilled patterns (request already satisfied)
      "further information received", "fi received", "f.i. received",
      "further information has been received",
      "enclosed please find", "attached please find",
      "please find enclosed", "please find attached"

      // NOTE: Consultation recommendations like "would recommend the applicant submits"
      // are NOT rejected - they indicate future report needs (valuable leads)
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

    // Report type keywords - includes abbreviations commonly used in planning documents
    const relatedTerms = {
      "acoustic": [
        "noise", "sound", "decibel", "db", "vibration", "noise assessment", "sound level", "acoustic",
        "noise impact", "nia", "nir", "bns", "background noise", "noise survey", "acoustic survey",
        "sound insulation", "noise mitigation", "ambient noise", "plant noise"
      ],
      "transport": [
        "traffic", "vehicle", "highway", "road", "parking", "transport assessment", "car park", "mobility", "transport",
        "ta", "tia", "traffic impact", "travel plan", "tp", "access", "junction", "pedestrian", "cycle"
      ],
      "ecological": [
        "ecology", "wildlife", "habitat", "species", "biodiversity", "environment", "ecological", "nature", "flora", "fauna",
        "eia", "bng", "biodiversity net gain", "pea", "preliminary ecological", "bat survey", "bat", "newt", "dormouse",
        "protected species", "nesting birds", "breeding birds"
      ],
      "flood": [
        "drainage", "water", "sewage", "storm", "rainfall", "suds", "surface water", "attenuation", "flood",
        "fra", "flood risk", "hydrology", "runoff", "soakaway", "infiltration", "watercourse", "pluvial"
      ],
      "heritage": [
        "archaeological", "historic", "conservation", "listed", "cultural", "monument", "archaeology", "heritage",
        "hia", "heritage impact", "wsi", "written scheme", "desk-based assessment", "dba", "historic environment"
      ],
      "arboricultural": [
        "tree", "trees", "vegetation", "landscape", "planting", "hedge", "woodland", "green", "arboricultural",
        "aia", "arboricultural impact", "tree survey", "root protection", "rpa", "tree protection"
      ],
      "waste": [
        "waste", "refuse", "recycling", "bin", "storage", "collection", "disposal", "management plan",
        "waste management", "skip", "compactor"
      ],
      "lighting": [
        "lighting", "light", "illumination", "lumens", "lux", "lamp",
        "light pollution", "spillage", "luminaire", "obtrusive light", "sky glow"
      ]
    };

    // GATE 3: Report type keywords present
    const hasReportTypeKeyword = relatedTerms[keywordLower]?.some(term => textLower.includes(term)) || textLower.includes(keywordLower);
    if (!hasReportTypeKeyword) {
      return false;
    }

    // GATE 4: Construction phase rejection (existing plans only)
    // Reject if it's discussing an EXISTING construction management plan, not requesting one
    // These patterns indicate an already-submitted construction management plan being discussed
    const existingConstructionPlanPatterns = [
      "construction management plan submitted",
      "cmp submitted", "cmp been submitted",
      "construction phase management plan",
      "site development works shall be confined to",
      "best practicable means to prevent/minimise noise" // Actual sound reduction method, not request
    ];

    if (keywordLower === "acoustic" || relatedTerms[keywordLower]?.includes("noise")) {
      if (existingConstructionPlanPatterns.some(p => textLower.includes(p))) {
        return false;
      }
    }

    // GATE 5: Sentence-level verb+term matching
    const requestVerbs = [
      "submit", "provide", "prepare", "carry out", "undertake", "produce",
      "supply", "is required to", "is requested to", "should be submitted",
      "must be provided", "needs to be", "shall submit", "shall provide",
      "require that", "requires that", "should", "should be",
      "advise that", "we advise", "we require", "we recommend",
      "recommend that", "recommends that", "recommend the",
      "would require", "would recommend", "further information",
      "clarification is required", "clarification is needed"
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

    // GATE 6: Soft Directionality Check
    // Only reject if it's clearly the APPLICANT responding, not authority requesting
    // Allow recommendations, variations in phrasing, and let AI judge the nuance
    const applicantSpeakingPatterns = [
      "we enclose", "we submit", "we provide",
      "enclosed please find", "attached please find",
      "please find enclosed", "please find attached",
      "we have enclosed", "we have attached"
    ];

    const isApplicantResponding = applicantSpeakingPatterns.some(p => textLower.includes(p));
    
    if (isApplicantResponding) {
      // This looks like applicant submitting/enclosing documents (response, not request)
      // But allow it through if there's also clear authority language OR recommendation language
      const authorityOrRecommendationLanguage = [
        "the applicant is requested",
        "you are requested",
        "please submit",
        "the planning authority",
        "council requires",
        "council requests",
        "would recommend",
        "recommends",
        "this service",
        "environmental health",
        "highways",
        "further information required",
        "further information is required"
      ];

      const hasAuthorityOrRecommendation = authorityOrRecommendationLanguage.some(p => textLower.includes(p));
      
      // If applicant is speaking but there's no authority/recommendation language, reject
      if (!hasAuthorityOrRecommendation) {
        return false;
      }
      // Otherwise, it's a mixed document (might be FI with applicant response) - allow it through
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
      // Yield to event loop before AI call to prevent health check timeouts
      await new Promise(resolve => setImmediate(resolve));

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

      const prompt = `Does this document REQUEST or RECOMMEND that further information be submitted for a planning application?

Answer YES if ANY of these are true:
- A planning authority is REQUESTING information from an applicant/agent
- Language like "you are requested to submit", "please provide", "further information is required"
- A consultee (e.g., Environmental Health, Highways) RECOMMENDS the applicant submits a report
- Language like "would recommend the applicant submits", "recommends submission of", "this service recommends"
- Document indicates a report type SHOULD BE provided (even if not a formal FI request)

Answer NO if:
- It's responding TO a request ("in response to your request", "we have submitted")
- It's a technical report or study (the report itself, not a request for one)
- It's a decision letter (granting/refusing permission)
- A consultee has REVIEWED an existing report ("has reviewed the submitted")
- It's unrelated to planning (invoice, photo, general correspondence)

Document sample:
${sampleText}

Answer with just YES or NO.`;

      // Retry logic for OpenAI API calls
      let lastError;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
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
        } catch (attemptError) {
          lastError = attemptError;
          if (attempt < 2) {
            // Exponential backoff: 1s, 3s
            const delayMs = Math.pow(3, attempt) * 1000;
            logger.warn(`Cheap AI filter attempt ${attempt + 1} failed, retrying in ${delayMs}ms...`, attemptError.message);
            await new Promise(resolve => setTimeout(resolve, delayMs));
          }
        }
      }

      logger.error('Error in cheap AI filter after 3 retries:', lastError);
      // On error, let it pass to full analysis (fail open)
      return true;
    } catch (error) {
      logger.error('Error in cheapFIFilter outer handler:', error);
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
        // Response patterns
        "response to further information",
        "in response to your request for further information",
        "following your request for further information",
        "in response to your request",
        "in response to the request",

        // FI received/fulfilled patterns
        "the further information received",
        "further information has been received",
        "fi received", "f.i. received",
        "we have submitted the following",
        "enclosed please find the requested",
        "attached herewith the further information",
        "enclosed please find", "attached please find",
        "please find enclosed", "please find attached",

        // Decision patterns
        "permission is hereby granted",
        "it is proposed to grant permission",
        "decision to grant permission",
        "it is proposed to refuse permission",
        "decision to refuse permission",
        "we will condition", "this will be conditioned",

        // Consultant report indicators
        "were engaged to undertake",
        "were engaged by",
        "commissioned to undertake",
        "this report has been prepared by",

        // Acknowledgment/receipt patterns
        "acknowledge receipt", "acknowledges receipt",
        "has reviewed the submitted", "reviewed the submitted",
        "receipt of this application",

        // Email/correspondence patterns
        "good morning", "good afternoon", "good evening",
        "kind regards", "best regards",
        "happy to discuss", "please let me know",
        "waiting until", "waiting to", "can we please agree",

        // Submitted report discussion patterns (report ALREADY submitted - not a lead)
        "the submitted acoustic", "submitted noise assessment",
        "the acoustic report shows", "the noise report indicates",
        "has been submitted", "was submitted",
        "has received and reviewed", "received and reviewed the",
        "environmental health service has received",
        "environmental health has reviewed"

        // NOTE: Consultation recommendations like "would recommend the applicant submits"
        // are NOT rejected - they indicate future report needs (valuable leads)
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

        // POST-AI VALIDATION: Verify the validation quote mentions the target report type
        // Sanity check: if quote exists, ensure it's about the right topic
        if (validationQuote && validationQuote !== 'No specific quote extracted' && 
            validationQuote !== 'Match confirmed by AI but no specific quote extracted') {
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
            logger.info(`Post-AI validation: Quote doesn't mention ${targetReportType}, using fallback. Quote: "${validationQuote.substring(0, 100)}..."`);
            // Don't reject - AI has already validated, just use generic fallback
            validationQuote = 'Match confirmed by AI but no specific quote extracted';
          }
        }
        // If no quote or weak quote found, that's ok - AI already validated it as FI request

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
      "the applicant is requested", "further information", "clarification",
      "would recommend", "recommends", "recommend that", "applicant should",
      "applicant must", "is required to submit", "shall submit", "shall provide"
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

    // Physical work indicators - these suggest a request for PHYSICAL WORK
    // not a document/report. Reject if these appear WITH topic terms but WITHOUT document terms
    // e.g., "provide noise insulation" = physical work, NOT a noise report request
    const physicalWorkIndicators = [
      "insulation",
      "glazing",
      "double glazing",
      "triple glazing",
      "acoustic glazing",
      "sound insulation",
      "noise barrier",
      "barrier",
      "install",
      "construct",
      "erect",
      "build",
      "fit",
      "upgrade windows",
      "upgrade glazing",
      "protected by",
      "shall be protected"
    ];

    // Document type indicators - if present, override physical work rejection
    // because "noise insulation assessment" IS a valid document request
    const documentIndicators = [
      "report",
      "assessment",
      "study",
      "survey",
      "analysis",
      "appraisal",
      "evaluation",
      "statement",
      "investigation",
      "certificate",
      "audit",
      "plan",
      "scheme",
      "strategy",
      "specification",
      "drawing",
      "calculations"
    ];

    const reportTypeTerms = {
      "acoustic": ["noise", "sound", "acoustic", "decibel", "db", "vibration", "noise assessment", "sound level", "noise impact"],
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

    // Find sentences with request verbs and report type terms
    // Reject if it's about physical work (e.g., "provide insulation") but NOT a document
    // Accept if it has document indicators OR doesn't have physical work indicators
    for (let i = 0; i < sentences.length; i++) {
      const sentence = sentences[i];
      const hasVerb = requestVerbs.some(v => sentence.includes(v));
      const hasTerm = terms.some(t => sentence.includes(t));
      const hasResponseIndicator = responseIndicators.some(r => sentence.includes(r));
      const hasPhysicalWork = physicalWorkIndicators.some(p => sentence.includes(p));
      const hasDocumentIndicator = documentIndicators.some(d => sentence.includes(d));
      
      // Reject if it's physical work without any document reference
      const isPhysicalWorkOnly = hasPhysicalWork && !hasDocumentIndicator;

      if (hasVerb && hasTerm && !hasResponseIndicator && !isPhysicalWorkOnly) {
        // Include surrounding sentences for context (up to 4 sentences total)
        const contextStart = Math.max(0, i - 1);  // 1 sentence before
        const contextEnd = Math.min(sentences.length, i + 3);  // 2 sentences after
        const contextSentences = sentences.slice(contextStart, contextEnd);
        const quote = contextSentences.join(' ').trim();

        // If quote is still very long, truncate intelligently at sentence boundary
        if (quote.length > 600) {
          // Keep the core matching sentence + immediate context
          const coreSentences = sentences.slice(i, Math.min(sentences.length, i + 3));
          return coreSentences.join(' ').trim();
        }
        return quote;
      }

      // Check adjacent sentences (2-sentence window)
      if (i + 1 < sentences.length) {
        const combo = sentence + " " + sentences[i + 1];
        const hasVerb2 = requestVerbs.some(v => combo.includes(v));
        const hasTerm2 = terms.some(t => combo.includes(t));
        const hasResponse2 = responseIndicators.some(r => combo.includes(r));
        const hasPhysical2 = physicalWorkIndicators.some(p => combo.includes(p));
        const hasDoc2 = documentIndicators.some(d => combo.includes(d));
        const isPhysicalOnly2 = hasPhysical2 && !hasDoc2;
        
        if (hasVerb2 && hasTerm2 && !hasResponse2 && !isPhysicalOnly2) {
          // Include more context (up to 4 sentences)
          const contextStart = Math.max(0, i - 1);
          const contextEnd = Math.min(sentences.length, i + 4);
          const contextSentences = sentences.slice(contextStart, contextEnd);
          const quote = contextSentences.join(' ').trim();

          if (quote.length > 600) {
            return sentences.slice(i, Math.min(sentences.length, i + 3)).join(' ').trim();
          }
          return quote;
        }
      }
    }

    // Fallback: Be generous for lead generation
    // Return any mention of the topic that isn't obviously physical work only
    for (const term of terms) {
      const idx = textLower.indexOf(term);
      if (idx !== -1) {
        // Find sentence boundaries for cleaner quote
        const sentenceStart = this.findSentenceStart(textLower, idx);
        const sentenceEnd = this.findSentenceEnd(textLower, idx);

        // Extract the sentence text to check for red flags
        const sentenceText = textLower.substring(sentenceStart, sentenceEnd);
        const hasPhysicalWork = physicalWorkIndicators.some(p => sentenceText.includes(p));
        const hasDocumentIndicator = documentIndicators.some(d => sentenceText.includes(d));
        
        // Skip only if it's physical work WITHOUT any document/report reference
        // Otherwise include it even if it's just mentioning the topic (lead generation)
        if (hasPhysicalWork && !hasDocumentIndicator) {
          continue;  // Try next term
        }

        // Expand to include adjacent sentences if not too long
        let start = sentenceStart;
        let end = sentenceEnd;

        // Try to include next sentence for context
        const nextEnd = this.findSentenceEnd(textLower, end + 1);
        if (nextEnd - start < 500) {
          end = nextEnd;
        }

        return documentText.substring(start, end).trim();
      }
    }

    return 'Match confirmed by AI but no specific quote extracted';
  }

  /**
   * Find the start of a sentence containing the given index
   */
  findSentenceStart(text, idx) {
    const sentenceEnders = ['.', '!', '?', '\n'];
    let start = idx;
    while (start > 0) {
      if (sentenceEnders.includes(text[start - 1])) {
        break;
      }
      start--;
    }
    // Skip whitespace
    while (start < text.length && /\s/.test(text[start])) {
      start++;
    }
    return start;
  }

  /**
   * Find the end of a sentence containing the given index
   */
  findSentenceEnd(text, idx) {
    const sentenceEnders = ['.', '!', '?', '\n'];
    let end = idx;
    while (end < text.length) {
      if (sentenceEnders.includes(text[end])) {
        return end + 1;
      }
      end++;
    }
    return end;
  }

  /**
   * Validate that extracted FI request info contains actual request language
   * Also checks for response indicators to reject FI response/received documents
   * @param {Object} extractedInfo - The extracted FI request information
   * @param {string} targetReportType - The report type we're looking for
   * @returns {Object} - Validation result with isValid flag and reasons
   */
  validateFIRequestExtraction(extractedInfo, targetReportType) {
    // Request verbs - includes both formal requests and consultee recommendations
    const requestVerbs = [
      "submit", "provide", "prepare", "carry out", "undertake", "produce",
      "supply", "required", "requested", "necessary",
      "should be submitted", "must be provided", "needs to be", "is to be",
      // Recommendation verbs (for consultee recommendations)
      "recommend", "recommends", "would recommend", "this service recommends",
      "should be provided", "should be undertaken", "should address"
    ];

    // Response indicators - these suggest it's a RESPONSE not a REQUEST
    const responseIndicators = [
      "please refer to", "as outlined in", "as detailed in",
      "the assessment", "the report", "prepared by",
      "we have submitted", "we have provided", "has been submitted",
      "further information received", "fi response", "response to fi",
      "in response to", "following receipt", "submitted on",
      "has reviewed the submitted", "has received and reviewed"
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

      // FILENAME REJECTION CHECK - reject emails, correspondence, responses, etc.
      if (this.shouldRejectByFilename(fileName)) {
        const result = {
          isFIRequest: false,
          matchesTargetType: false,
          extractedInfo: null,
          detectionMethod: 'filename_rejection'
        };
        this.setCachedResult(cacheKey, result);
        return result;
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
      // Apply county/sector filters based on each customer's subscription
      const customerMatches = {};
      if (customerData && customerData.length > 0) {
        // Create or find customer records in database
        for (const customer of customerData) {
          try {
            // Find or create customer record in database
            const customerRecord = await this.findOrCreateCustomer(customer, reportTypes);

            // Get customer's subscription filters
            const allowedCounties = customerRecord.filters?.allowedCounties || [];
            const allowedSectors = customerRecord.filters?.allowedSectors || [];
            const hasActiveFilters = allowedCounties.length > 0 || allowedSectors.length > 0;

            // Debug: Log customer filter settings
            if (hasActiveFilters) {
              logger.info(`🔍 ${customer.email} subscription filters - Counties: [${allowedCounties.join(', ')}], Sectors: [${allowedSectors.join(', ')}]`);
            }

            // Filter matches based on customer's subscription (county/sector)
            let filteredMatches = [...docfilesMatches];

            if (hasActiveFilters) {
              const originalCount = filteredMatches.length;
              filteredMatches = filteredMatches.filter(match => {
                const projectCounty = match.planningCounty || match.projectMetadata?.planning_county;
                const projectSector = match.planningSector || match.projectMetadata?.planning_sector;

                // If no county/sector info, exclude (can't verify against active filters)
                if (!projectCounty || projectCounty === 'Unknown' || projectCounty === 'N/A') {
                  logger.warn(`⚠️ Project ${match.projectId}: No county data - EXCLUDING for ${customer.email}`);
                  return false;
                }

                // County check: empty allowedCounties = no restriction
                const countyOK = allowedCounties.length === 0 ||
                  allowedCounties.some(county =>
                    projectCounty.trim().toLowerCase() === county.trim().toLowerCase()
                  );

                // Sector check: empty allowedSectors = no restriction
                const sectorOK = allowedSectors.length === 0 ||
                  (projectSector && allowedSectors.some(sector =>
                    projectSector.trim().toLowerCase() === sector.trim().toLowerCase()
                  ));

                // Debug: Log filtering decisions for projects that fail
                if (!countyOK || !sectorOK) {
                  logger.info(`🚫 Project ${match.projectId} (${projectCounty}/${projectSector}) EXCLUDED for ${customer.email} - countyOK: ${countyOK}, sectorOK: ${sectorOK}`);
                }

                return countyOK && sectorOK;
              });

              if (originalCount !== filteredMatches.length) {
                logger.info(`📋 ${customer.email}: ${filteredMatches.length}/${originalCount} matches after applying subscription filters`);
              }
            }

            customerMatches[customer.email] = {
              email: customer.email,
              name: customerRecord.name,
              matches: filteredMatches,
              customerId: customerRecord._id
            };
          } catch (error) {
            logger.error(`Failed to create/find customer ${customer.email}:`, error);
            // Fallback to in-memory customer data - give all matches (no filter info available)
            customerMatches[customer.email] = {
              email: customer.email,
              name: customer.name || customer.email.split('@')[0],
              matches: [...docfilesMatches]
            };
          }
        }
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
