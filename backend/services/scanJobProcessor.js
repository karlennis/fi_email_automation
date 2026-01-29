const schedule = require('node-schedule');
const ScanJob = require('../models/ScanJob');
const Customer = require('../models/Customer');
const fastS3Scanner = require('./fastS3Scanner');
const fiDetectionService = require('./fiDetectionService');
const s3Service = require('./s3Service');
const emailService = require('./emailService');
const buildingInfoService = require('./buildingInfoService');
const logger = require('../utils/logger');

class ScanJobProcessor {
    constructor() {
        this.isRunning = false;
        this.scheduledJob = null;
        this.lastProcessedDate = null; // Track last processed date to run once per day
    }

    /**
     * Initialize the scan job processor
     */
    async initialize() {
        try {
            logger.info('🤖 Initializing Scan Job Processor...');

            // Schedule to run once daily at 12:10 AM (5 minutes after document register generation)
            this.scheduledJob = schedule.scheduleJob('10 0 * * *', async () => {
                await this.processActiveJobs();
            });

            logger.info(`✅ Scan Job Processor initialized - runs daily at 12:10 AM`);

            // Check if we should run on startup (if we haven't run today yet)
            const today = new Date().toISOString().split('T')[0];
            if (this.lastProcessedDate !== today) {
                logger.info('🚀 Running initial scan on startup...');
                setTimeout(() => this.processActiveJobs(), 5000);
            }

        } catch (error) {
            logger.error('❌ Failed to initialize Scan Job Processor:', error);
        }
    }

    /**
     * Process all active scan jobs
     */
    async processActiveJobs() {
        if (this.isRunning) {
            logger.info('⏭️ Scan job processing already in progress, skipping...');
            return;
        }

        // Check if we've already run today
        const today = new Date().toISOString().split('T')[0];
        if (this.lastProcessedDate === today) {
            logger.info('⏭️ Scan jobs already processed today, skipping...');
            return;
        }

        this.isRunning = true;

        try {
            // Get all active and running jobs
            const activeJobs = await ScanJob.find({ status: { $in: ['ACTIVE', 'RUNNING'] } })
                .populate('customers.customerId', 'email company name projectId');

            // Log all jobs for debugging
            const allJobs = await ScanJob.find({});
            logger.info(`📊 Total jobs in database: ${allJobs.length}`);
            for (const job of allJobs) {
                logger.info(`  - ${job.jobId}: status=${job.status}, checkpoint=${job.checkpoint?.processedCount || 0}/${job.checkpoint?.totalDocuments || 0}, isResuming=${job.checkpoint?.isResuming || false}`);
            }

            if (activeJobs.length === 0) {
                logger.info('📋 No active/running scan jobs to process');
                return;
            }

            logger.info(`🔍 Processing ${activeJobs.length} active scan jobs for ${today}...`);

            for (const job of activeJobs) {
                try {
                    // Check if this job needs to resume from a crash
                    const needsResume = job.checkpoint && job.checkpoint.isResuming;
                    
                    // Also check for interrupted scans (status=RUNNING on startup means crashed mid-scan)
                    const wasInterrupted = job.status === 'RUNNING' && job.checkpoint && job.checkpoint.processedCount > 0;
                    
                    if (needsResume || wasInterrupted) {
                        if (wasInterrupted) {
                            logger.info(`🔄 Job ${job.jobId} was interrupted mid-scan (found RUNNING status), resuming from ${job.checkpoint.processedCount} documents...`);
                            job.checkpoint.isResuming = true;
                            job.status = 'ACTIVE';
                            await job.save();
                        } else {
                            logger.info(`🔄 Job ${job.jobId} needs to resume from checkpoint at ${job.checkpoint.processedCount} documents...`);
                        }
                        await this.processJob(job);
                        continue;
                    }
                    
                    // Check if this job should run based on its schedule
                    const shouldRun = this.shouldJobRun(job, today);
                    
                    if (!shouldRun) {
                        const scheduleType = job.schedule?.type || 'DAILY';
                        logger.info(`⏭️ Job ${job.jobId} not scheduled to run (${scheduleType} schedule)`);
                        continue;
                    }

                    await this.processJob(job);
                } catch (error) {
                    logger.error(`❌ Error processing job ${job.jobId}:`, error);
                }
            }

            // Mark that we've processed today
            this.lastProcessedDate = today;

            logger.info('✅ Completed processing all active jobs');

        } catch (error) {
            logger.error('❌ Error processing active jobs:', error);
        } finally {
            this.isRunning = false;
        }
    }

    /**
     * Process a single scan job
     * @param {Object} job - The scan job to process
     * @param {string} targetDate - Optional target date (YYYY-MM-DD) to scan documents from
     */
    async processJob(job, targetDate = null) {
        logger.info(`📝 Processing job: ${job.jobId} (${job.name}) - ${job.documentType}`);

        const startTime = Date.now();

        let scanStartDate, scanEndDate;

        if (targetDate) {
            // Use specified target date (single day scan for manual testing)
            scanStartDate = new Date(targetDate);
            scanStartDate.setHours(0, 0, 0, 0);
            scanEndDate = new Date(scanStartDate);
            scanEndDate.setDate(scanEndDate.getDate() + 1);
            scanEndDate.setHours(23, 59, 59, 999);
            logger.info(`📅 Scanning document register for ${targetDate} (user-specified date)`);
        } else {
            // Use lookback period from job configuration
            const lookbackDays = job.schedule?.lookbackDays || 1; // Default to 1 day if not specified
            
            // End date: yesterday (don't include today's partial data)
            scanEndDate = new Date();
            scanEndDate.setDate(scanEndDate.getDate() - 1);
            scanEndDate.setHours(23, 59, 59, 999);
            
            // Start date: lookbackDays ago
            scanStartDate = new Date(scanEndDate);
            scanStartDate.setDate(scanStartDate.getDate() - lookbackDays + 1); // +1 because we include the end day
            scanStartDate.setHours(0, 0, 0, 0);
            
            const startDateStr = scanStartDate.toISOString().split('T')[0];
            const endDateStr = scanEndDate.toISOString().split('T')[0];
            
            if (lookbackDays === 1) {
                logger.info(`📅 Scanning documents from ${endDateStr} (1 day lookback)`);
            } else {
                logger.info(`📅 Scanning documents from ${startDateStr} to ${endDateStr} (${lookbackDays} days lookback)`);
            }
        }

        // Stream documents directly from S3 (memory safe, no register dependency)
        const documents = [];

        logger.info(`🔍 Streaming S3 documents for date range: ${scanStartDate.toISOString()} to ${scanEndDate.toISOString()}`);

        try {
            await fastS3Scanner.streamDocumentsSince(
                scanStartDate,
                scanEndDate,
                async (doc) => {
                    // Only collect PDF and DOCX files
                    const fileName = doc.fileName ? doc.fileName.toLowerCase() : '';
                    if (fileName.endsWith('.pdf') || fileName.endsWith('.docx')) {
                        documents.push(doc);
                    }
                },
                { maxObjects: null, timeoutSeconds: 600 } // No limit, 10 min timeout for full scan
            );
        } catch (scanError) {
            logger.error(`❌ Error streaming S3 documents:`, scanError);
            throw scanError;
        }

        if (documents.length === 0) {
            const dateRangeStr = scanStartDate.toISOString().split('T')[0] === scanEndDate.toISOString().split('T')[0]
                ? scanStartDate.toISOString().split('T')[0]
                : `${scanStartDate.toISOString().split('T')[0]} to ${scanEndDate.toISOString().split('T')[0]}`;
            logger.info(`📋 No documents found for date range: ${dateRangeStr}`);
            return;
        }

        const dateRangeStr = scanStartDate.toISOString().split('T')[0] === scanEndDate.toISOString().split('T')[0]
            ? scanStartDate.toISOString().split('T')[0]
            : `${scanStartDate.toISOString().split('T')[0]} to ${scanEndDate.toISOString().split('T')[0]}`;
        logger.info(`📄 Found ${documents.length} documents in date range: ${dateRangeStr}`);
        // Use all customers assigned to this job
        const jobCustomers = job.customers.filter(c => c.customerId).map(c => c.customerId);

        logger.info(`👥 Job has ${jobCustomers.length} customers assigned`);

        if (jobCustomers.length === 0) {
            logger.warn(`⚠️ Job ${job.jobId} has no customers assigned`);
            return;
        }

        // Initialize or resume checkpoint
        const CHECKPOINT_INTERVAL = 10000; // Send progress email every 10,000 documents
        const SAVE_INTERVAL = 100; // Save checkpoint to DB every 100 docs (for crash recovery)
        const isResuming = job.checkpoint && job.checkpoint.isResuming && job.checkpoint.lastProcessedIndex > 0;
        const startIndex = isResuming ? job.checkpoint.lastProcessedIndex : 0;

        if (isResuming) {
            logger.info(`🔄 Resuming scan from document #${startIndex + 1} (${job.checkpoint.lastProcessedFile})`);
        } else {
            // Initialize checkpoint for new scan
            job.checkpoint = {
                lastProcessedIndex: 0,
                lastProcessedFile: '',
                totalDocuments: documents.length,
                processedCount: 0,
                matchesFound: 0,
                scanStartTime: new Date(),
                lastCheckpointTime: new Date(),
                isResuming: false
            };
            await job.save();
            logger.info(`💾 Checkpoint initialized for ${documents.length} documents`);
        }

        // Process ALL documents in the register (or resume from checkpoint)
        logger.info(`🔍 Scanning ${documents.length - startIndex} documents for ${job.documentType} reports`);

        // Process each document through the 3-stage filter
        const matches = [];
        let totalProcessed = isResuming ? job.checkpoint.processedCount : 0;
        let skippedNonPdf = 0;

        for (let i = startIndex; i < documents.length; i++) {
            const document = documents[i];
            
            try {
                // Only process PDF and DOCX files
                const fileName = document.fileName ? document.fileName.toLowerCase() : '';
                if (!fileName.endsWith('.pdf') && !fileName.endsWith('.docx')) {
                    skippedNonPdf++;
                    continue;
                }

                totalProcessed++;

                logger.info(`🔍 [${totalProcessed}/${documents.length - skippedNonPdf}] Scanning: ${document.projectId}/${document.fileName}`);

                const result = await this.processDocument(document, job);
                
                // Clear large objects from memory immediately after processing
                if (result && result.extractedText) {
                    delete result.extractedText; // Free extracted text from memory
                }
                
                // Null out document buffer if it exists
                if (document.buffer) {
                    document.buffer = null;
                }

                if (result.isMatch) {
                    logger.info(`✅ MATCH FOUND: ${document.fileName} (confidence: ${(result.confidence * 100).toFixed(1)}%)`);
                    matches.push({
                        document,
                        result,
                        customers: job.customers // Send to all assigned customers
                    });
                    
                    // Update matches count in checkpoint
                    job.checkpoint.matchesFound = (job.checkpoint.matchesFound || 0) + 1;
                } else {
                    logger.info(`❌ No match: ${document.fileName} (stage: ${result.stage})`);
                }

                // Update checkpoint after each document
                job.checkpoint.lastProcessedIndex = i;
                job.checkpoint.lastProcessedFile = document.fileName;
                job.checkpoint.processedCount = totalProcessed;

                // Save checkpoint more frequently: 
                // - EVERY document for first 100 (critical crash recovery period)
                // - Every 100 documents after that
                // - Every 10,000 documents for progress emails
                const shouldSave = totalProcessed <= 100 || 
                                 totalProcessed % SAVE_INTERVAL === 0 || 
                                 totalProcessed % CHECKPOINT_INTERVAL === 0;
                
                if (shouldSave) {
                    job.checkpoint.lastCheckpointTime = new Date();
                    
                    // Log memory usage at checkpoints
                    const memUsage = process.memoryUsage();
                    const rssInMB = memUsage.rss / 1024 / 1024;
                    logger.info(`💾 Memory: ${(memUsage.heapUsed / 1024 / 1024).toFixed(2)}MB / ${(memUsage.heapTotal / 1024 / 1024).toFixed(2)}MB (RSS: ${rssInMB.toFixed(2)}MB)`);
                    
                    // Circuit breaker: Stop if memory exceeds 450MB (88% of 512MB Render limit)
                    if (rssInMB > 450) {
                        logger.error(`🚨 MEMORY LIMIT APPROACHING: ${rssInMB.toFixed(2)}MB / 512MB - Stopping scan to prevent crash`);
                        job.checkpoint.isResuming = true;
                        job.status = 'PAUSED';
                        await job.save();
                        throw new Error(`Memory limit reached at ${rssInMB.toFixed(2)}MB - scan paused for safety`);
                    }
                    
                    // Force garbage collection if available (run with --expose-gc flag)
                    if (global.gc && totalProcessed % 1000 === 0) {
                        global.gc();
                        logger.info('🗑️ Forced garbage collection');
                    }
                    
                    await job.save();
                    
                    // Only send progress email at CHECKPOINT_INTERVAL milestones
                    if (totalProcessed % CHECKPOINT_INTERVAL === 0) {
                        logger.info(`💾 Checkpoint saved at ${totalProcessed} documents`);

                        // Send match emails for all matches found in this batch
                        if (matches.length > 0 && job.config.autoProcess) {
                            logger.info(`📧 Sending match emails for ${matches.length} matches found so far...`);
                            await this.sendMatchEmails(matches, job);
                            logger.info(`✅ Match emails sent for checkpoint at ${totalProcessed} documents`);
                        }

                        // Send progress email to all job customers
                        const customerEmails = job.customers
                            .filter(c => c.email)
                            .map(c => c.email);

                        if (customerEmails.length > 0) {
                            await emailService.sendScanProgressEmail(customerEmails, {
                                jobName: job.name,
                                documentType: job.documentType,
                                startTime: job.checkpoint.scanStartTime,
                                processedCount: totalProcessed,
                                totalDocuments: documents.length,
                                matchesFound: job.checkpoint.matchesFound,
                                lastProcessedFile: document.fileName,
                                isCheckpoint: true
                            });
                        }
                    } else if (totalProcessed <= 100) {
                        // Silent checkpoint save for first 100 docs (critical period)
                        logger.debug(`💾 Checkpoint saved at ${totalProcessed} documents (early crash protection)`);
                    } else {
                        // Silent checkpoint save (no email)
                        logger.debug(`💾 Checkpoint saved at ${totalProcessed} documents (silent)`);
                    }
                }

            } catch (error) {
                logger.error(`❌ Error processing document ${document.fileName}:`, error);
                
                // Save checkpoint even on error to allow resume
                job.checkpoint.lastProcessedIndex = i;
                job.checkpoint.lastProcessedFile = document.fileName;
                job.checkpoint.processedCount = totalProcessed;
                job.checkpoint.isResuming = true; // Mark for resume
                await job.save();
                
                // Re-throw error to trigger scan interruption
                throw error;
            }
        }

        // Final checkpoint save on completion
        job.checkpoint.processedCount = totalProcessed;
        job.checkpoint.isResuming = false; // Clear resume flag
        await job.save();

        if (skippedNonPdf > 0) {
            logger.info(`⏭️  Skipped ${skippedNonPdf} unsupported files`);
        }

        logger.info(`✅ Job ${job.jobId} complete: ${matches.length} matches found from ${totalProcessed} documents`);

        // Print validation quotes for sanity check
        if (matches.length > 0) {
            logger.info('\n📋 ===== VALIDATION QUOTES (Sanity Check) =====');
            matches.forEach((match, index) => {
                const fileName = match.document.fileName;
                const quote = match.result.validationQuote || 'No quote captured';
                logger.info(`\n[${index + 1}] File: ${fileName}`);
                logger.info(`    Quote: "${quote.substring(0, 300)}${quote.length > 300 ? '...' : ''}"`);
            });
            logger.info('\n================================================\n');
        }

        // Send emails for matches
        if (matches.length > 0 && job.config.autoProcess) {
            await this.sendMatchEmails(matches, job);
        }

        // Update job statistics
        job.statistics.totalScans = (job.statistics.totalScans || 0) + 1;
        job.statistics.totalDocumentsProcessed = (job.statistics.totalDocumentsProcessed || 0) + totalProcessed;
        job.statistics.totalMatches = (job.statistics.totalMatches || 0) + matches.length;
        job.statistics.lastScanDate = new Date();

        await job.save();

        const duration = ((Date.now() - startTime) / 1000).toFixed(2);
        logger.info(`⏱️ Job ${job.jobId} completed in ${duration}s`);
    }

    /**
     * Process a single document - check if it's an FI request for the report type
     */
    async processDocument(document, job) {
        try {
            const fileName = document.fileName;
            const documentType = job.documentType; // e.g., 'acoustic'

            logger.info(`📄 Processing: ${fileName}`);

            // Download and extract text from the document
            const s3Key = document.filePath;
            let documentText = '';

            try {
                // Download from S3 using AWS SDK
                const AWS = require('aws-sdk');
                const s3 = new AWS.S3();

                const params = {
                    Bucket: process.env.S3_BUCKET || 'planning-documents-2',
                    Key: s3Key
                };

                const s3Response = await s3.getObject(params).promise();
                const fileBuffer = s3Response.Body;

                // Extract text based on file type
                const isDocx = fileName.toLowerCase().endsWith('.docx');
                
                if (isDocx) {
                    // Extract text from DOCX buffer with error handling
                    const mammoth = require('mammoth');
                    
                    try {
                        const result = await mammoth.extractRawText({ buffer: fileBuffer });
                        documentText = result.value;
                    } catch (docxError) {
                        // Handle corrupted/malformed DOCX files
                        logger.error(`❌ DOCX parsing failed for ${fileName}: ${docxError.message}`);
                        return {
                            isMatch: false,
                            stage: 'docx-parse-error',
                            confidence: 0,
                            reasoning: 'DOCX is corrupted or malformed',
                            error: docxError.message
                        };
                    }
                } else {
                    // Extract text from PDF buffer using pdfjs-dist (more robust than pdf-parse)
                    const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
                    
                    try {
                        // Convert Buffer to Uint8Array (required by pdfjs-dist)
                        const uint8Array = new Uint8Array(fileBuffer);
                        
                        // Load PDF document
                        const loadingTask = pdfjsLib.getDocument({
                            data: uint8Array,
                            useSystemFonts: true,
                            standardFontDataUrl: null
                        });
                        
                        const pdfDocument = await loadingTask.promise;
                        const numPages = pdfDocument.numPages;
                        
                        // Extract text from all pages
                        const textPromises = [];
                        for (let pageNum = 1; pageNum <= numPages; pageNum++) {
                            textPromises.push(
                                pdfDocument.getPage(pageNum).then(page => {
                                    return page.getTextContent().then(textContent => {
                                        return textContent.items.map(item => item.str).join(' ');
                                    });
                                })
                            );
                        }
                        
                        const pageTexts = await Promise.all(textPromises);
                        documentText = pageTexts.join('\n');
                        
                        // Clean up
                        await pdfDocument.destroy();
                        
                    } catch (pdfError) {
                        // Handle corrupted/malformed PDFs gracefully
                        logger.error(`❌ PDF parsing failed for ${fileName}: ${pdfError.message}`);
                        return {
                            isMatch: false,
                            stage: 'pdf-parse-error',
                            confidence: 0,
                            reasoning: 'PDF is corrupted or malformed',
                            error: pdfError.message
                        };
                    }
                }

                if (!documentText || documentText.length < 100) {
                    logger.warn(`⚠️ Insufficient text extracted from ${fileName} (${documentText.length} chars)`);
                    return {
                        isMatch: false,
                        stage: 'text-extraction',
                        confidence: 0,
                        reasoning: 'Could not extract sufficient text from document'
                    };
                }

                // Truncate to max size for AI (32000 chars - matches fiDetectionService.MAX_MSG_CHARS)
                if (documentText.length > 32000) {
                    documentText = documentText.substring(0, 32000);
                }

                logger.info(`✅ Extracted ${documentText.length} chars from ${fileName}`);

            } catch (error) {
                logger.error(`❌ Error downloading/extracting ${fileName}:`, error);
                return {
                    isMatch: false,
                    stage: 'download-error',
                    confidence: 0,
                    error: error.message
                };
            }

            // LAYER 1: Fast structural rejection (no AI cost)
            const filenameLower = fileName.toLowerCase();
            
            // 1a. Filename rejection - responses/submissions
            const fiResponseIndicators = [
                'fi_received', 
                'f.i._received', 
                'fi received',
                'response to fi',
                'fi response',
                'submitted',
                'final grant',
                'decision notification',
                'grant permission'
            ];
            
            if (fiResponseIndicators.some(indicator => filenameLower.includes(indicator))) {
                return {
                    isMatch: false,
                    stage: 'filename-reject',
                    confidence: 0,
                    reasoning: 'Filename indicates response/decision document, not FI request'
                };
            }

            // 1b. Document length rejection - reports are typically >100 pages
            // FI request letters are usually 2-5 pages
            const estimatedPages = Math.ceil(documentText.length / 2500); // ~2500 chars per page
            if (estimatedPages > 100) {
                logger.info(`Rejecting long document: ${estimatedPages} estimated pages (>100)`);
                return {
                    isMatch: false,
                    stage: 'length-reject',
                    confidence: 0,
                    reasoning: `Document too long (${estimatedPages} pages) - likely a report, not FI request letter`
                };
            }

            // 1c. Report structure markers - consultant reports have specific formatting
            const reportStructureMarkers = [
                /table of contents/i,
                /executive summary/i,
                /\d+\.\d+\s+(introduction|background|methodology)/i,
                /this report (?:was|has been) prepared by/i,
                /prepared on behalf of/i
            ];
            
            const hasReportStructure = reportStructureMarkers.some(pattern => pattern.test(documentText));
            if (hasReportStructure) {
                logger.info('Rejecting document with report structure markers');
                return {
                    isMatch: false,
                    stage: 'structure-reject',
                    confidence: 0,
                    reasoning: 'Document has consultant report structure (TOC, exec summary, etc.)'
                };
            }

            // LAYER 2: Cheap AI pre-filter (uses only first 5k chars)
            const shouldProcessFully = await fiDetectionService.cheapFIFilter(documentText);
            if (!shouldProcessFully) {
                return {
                    isMatch: false,
                    stage: 'cheap-ai-reject',
                    confidence: 0,
                    reasoning: 'Document unlikely to be FI request (cheap AI filter)'
                };
            }

            // 🔍 LOG: Document passed Layer 2 - will process with full AI
            logger.info(`✅ Layer 2 PASS: ${fileName} - Processing with full AI (${documentText.length} chars)`);

            // LAYER 3: Full AI detection - only for promising candidates
            try {
                const isFIRequest = await fiDetectionService.detectFIRequest(documentText);

                if (!isFIRequest) {
                    return {
                        isMatch: false,
                        stage: 'not-fi-request',
                        confidence: 0,
                        reasoning: 'Document is not an FI request'
                    };
                }

                // Check if it specifically requests the target report type (e.g., acoustic)
                const matchResult = await fiDetectionService.matchFIRequestType(documentText, documentType);

                if (matchResult.matches) {
                    logger.info(`✅ FI REQUEST MATCH: ${fileName} requests ${documentType} report`);
                    return {
                        isMatch: true,
                        stage: 'fi-detection',
                        confidence: 0.95,
                        reasoning: `Document is an FI request asking for ${documentType} report`,
                        needsReview: false,
                        validationQuote: matchResult.validationQuote || 'No quote captured'
                    };
                } else {
                    return {
                        isMatch: false,
                        stage: 'wrong-report-type',
                        confidence: 0,
                        reasoning: `FI request does not ask for ${documentType} report`
                    };
                }

            } catch (error) {
                logger.error(`❌ Error in FI detection for ${fileName}:`, error);
                return {
                    isMatch: false,
                    stage: 'detection-error',
                    confidence: 0,
                    error: error.message
                };
            }

        } catch (error) {
            logger.error(`❌ Error processing document ${document.fileName}:`, error);
            return {
                isMatch: false,
                stage: 'error',
                confidence: 0,
                error: error.message
            };
        }
    }

    /**
     * Get customers who should receive notifications for this document
     */
    getDocumentCustomers(document, jobCustomers) {
        return jobCustomers.filter(c =>
            c.customerId?.projectId &&
            document.projectId &&
            c.customerId.projectId.toLowerCase() === document.projectId.toLowerCase()
        );
    }

    /**
     * Send batch email notifications for matched documents
     * Groups matches by customer and fetches project metadata from Building Info API
     */
    async sendMatchEmails(matches, job) {
        logger.info(`📧 Preparing batch notifications for ${matches.length} matched documents...`);

        try {
            // Group matches by customer email
            const customerMatchesMap = new Map();

            for (const match of matches) {
                const { document, result, customers } = match;

                for (const customer of customers) {
                    if (!customer.customerId?.email) continue;

                    const email = customer.customerId.email;

                    if (!customerMatchesMap.has(email)) {
                        customerMatchesMap.set(email, {
                            email: email,
                            name: customer.customerId.name,
                            matches: []
                        });
                    }

                    // Add match with document and project info
                    customerMatchesMap.get(email).matches.push({
                        reportType: job.documentType,
                        projectId: document.projectId,
                        documentName: document.fileName,
                        requestingAuthority: 'Planning Authority',
                        deadline: 'See document for details',
                        summary: result.reasoning || `FI request detected for ${job.documentType} report`,
                        specificRequests: result.reasoning || 'See document for specific requirements',
                        projectMetadata: null // Will be populated below
                    });
                }
            }

            // Get unique project IDs to fetch metadata
            const uniqueProjectIds = new Set();
            matches.forEach(match => {
                if (match.document.projectId) {
                    uniqueProjectIds.add(match.document.projectId);
                }
            });

            logger.info(`📡 Fetching metadata for ${uniqueProjectIds.size} projects from Building Info API...`);

            // Fetch all project metadata from Building Info API
            const projectMetadataMap = new Map();
            for (const projectId of uniqueProjectIds) {
                try {
                    const metadata = await buildingInfoService.getProjectMetadata(projectId);
                    if (metadata) {
                        projectMetadataMap.set(projectId, metadata);
                    }
                } catch (error) {
                    logger.warn(`⚠️ Could not fetch metadata for project ${projectId}:`, error.message);
                }
            }

            // Populate project metadata in matches
            for (const customerData of customerMatchesMap.values()) {
                for (const match of customerData.matches) {
                    if (projectMetadataMap.has(match.projectId)) {
                        match.projectMetadata = projectMetadataMap.get(match.projectId);
                    }
                }
            }

            // Send batch emails to each customer
            let emailsSent = 0;
            for (const customerData of customerMatchesMap.values()) {
                try {
                    await emailService.sendBatchFINotification(
                        customerData.email,
                        customerData.name,
                        {
                            matches: customerData.matches,
                            reportTypes: [job.documentType],
                            jobId: job.jobId,
                            generatedAt: new Date()
                        }
                    );

                    emailsSent++;
                    logger.info(`✉️ Sent batch email to ${customerData.email} (${customerData.matches.length} matches)`);

                } catch (error) {
                    logger.error(`❌ Failed to send batch email to ${customerData.email}:`, error);
                }
            }

            // Update job statistics
            job.statistics.totalEmailsSent = (job.statistics.totalEmailsSent || 0) + emailsSent;
            await job.save();

            logger.info(`✅ Sent ${emailsSent} batch email notifications for ${matches.length} total matches`);

        } catch (error) {
            logger.error('❌ Error sending batch emails:', error);
        }
    }

    /**
     * Stop the processor
     */
    stop() {
        if (this.scheduledJob) {
            this.scheduledJob.cancel();
            logger.info('🛑 Scan Job Processor stopped');
        }
    }

    /**
     * Check if a job should run based on its schedule frequency
     */
    shouldJobRun(job, today) {
        const scheduleType = job.schedule?.type || 'DAILY';
        const lastScanDate = job.statistics.lastScanDate
            ? new Date(job.statistics.lastScanDate)
            : null;

        if (!lastScanDate) {
            // Never run before, should run now
            return true;
        }

        const lastScanDateStr = lastScanDate.toISOString().split('T')[0];
        const daysSinceLastScan = Math.floor((new Date(today) - lastScanDate) / (1000 * 60 * 60 * 24));

        switch (scheduleType) {
            case 'DAILY':
                // Run if not already run today
                return lastScanDateStr !== today;

            case 'WEEKLY':
                // Run if it's been 7+ days since last scan
                return daysSinceLastScan >= 7;

            case 'MONTHLY':
                // Run if it's been 30+ days since last scan
                return daysSinceLastScan >= 30;

            case 'CUSTOM':
                // For custom schedules, check if already run today
                return lastScanDateStr !== today;

            default:
                // Default to daily
                return lastScanDateStr !== today;
        }
    }

    /**
     * Get processor status
     */
    getStatus() {
        return {
            isRunning: this.isRunning,
            processingInterval: this.processingInterval,
            nextRunTime: this.scheduledJob?.nextInvocation()
        };
    }
}

module.exports = new ScanJobProcessor();
