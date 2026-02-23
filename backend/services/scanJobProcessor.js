const schedule = require('node-schedule');
const ScanJob = require('../models/ScanJob');
const Customer = require('../models/Customer');
const fastS3Scanner = require('./fastS3Scanner');
const fiDetectionService = require('./fiDetectionService');
const s3Service = require('./s3Service');
const emailService = require('./emailService');
const buildingInfoService = require('./buildingInfoService');
const fiReportService = require('./fiReportService');
const logger = require('../utils/logger');
const { enqueueScanJob } = require('./scanJobQueue');
const optimizedPdfExtractor = require('./optimizedPdfExtractor');
const StreamingDocumentProcessor = require('./streamingDocumentProcessor');
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const { pipeline } = require('stream/promises');

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
                if (process.env.SCAN_SCHEDULER_ENABLED === 'false') {
                    logger.info('⏭️ Scan scheduler disabled (SCAN_SCHEDULER_ENABLED=false)');
                    return;
                }

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

                    // Also check for incomplete scans (has checkpoint but didn't finish all documents)
                    const isIncomplete = job.checkpoint &&
                                       job.checkpoint.processedCount > 0 &&
                                       job.checkpoint.totalDocuments > 0 &&
                                       job.checkpoint.processedCount < job.checkpoint.totalDocuments;

                    if (needsResume || wasInterrupted || isIncomplete) {
                        if (wasInterrupted) {
                            logger.info(`🔄 Job ${job.jobId} was interrupted mid-scan (found RUNNING status), resuming from ${job.checkpoint.processedCount} documents...`);
                            job.checkpoint.isResuming = true;
                            job.status = 'ACTIVE';
                            await job.save();
                        } else if (isIncomplete) {
                            logger.info(`🔄 Job ${job.jobId} has incomplete scan (${job.checkpoint.processedCount}/${job.checkpoint.totalDocuments}), resuming...`);
                            job.checkpoint.isResuming = true;
                            await job.save();
                        } else {
                            logger.info(`🔄 Job ${job.jobId} needs to resume from checkpoint at ${job.checkpoint.processedCount} documents...`);
                        }
                        // Pass null - processJob will use checkpoint dates for resuming
                        await enqueueScanJob(job.jobId, { targetDate: null });
                        continue;
                    }

                    // Check if this job should run based on its schedule
                    const shouldRun = this.shouldJobRun(job, today);

                    if (!shouldRun) {
                        const scheduleType = job.schedule?.type || 'DAILY';
                        logger.info(`⏭️ Job ${job.jobId} not scheduled to run (${scheduleType} schedule)`);
                        continue;
                    }

                    // SCHEDULED DAILY RUN: Pass null - processJob will use lookback (yesterday)
                    await enqueueScanJob(job.jobId, { targetDate: null });
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

        // Priority order for determining scan dates:
        // 1. Parameter targetDate (manual run - user just selected)
        // 2. Stored dates from checkpoint (resuming mid-scan)
        // 3. Lookback calculation (scheduled daily runs - always scan yesterday)

        const isResuming = job.checkpoint && job.checkpoint.isResuming && job.checkpoint.lastProcessedIndex > 0;

        if (targetDate) {
            // 1. MANUAL RUN: Use user-specified target date
            scanStartDate = new Date(targetDate);
            scanStartDate.setHours(0, 0, 0, 0);
            scanEndDate = new Date(scanStartDate);
            scanEndDate.setHours(23, 59, 59, 999);
            logger.info(`📅 MANUAL RUN: Scanning documents for ${targetDate}`);
            // Note: Date is stored in checkpoint below, not in job.schedule
        } else if (isResuming && job.checkpoint.scanStartDate && job.checkpoint.scanEndDate) {
            // 2. RESUMING: Use stored dates from checkpoint
            scanStartDate = new Date(job.checkpoint.scanStartDate);
            scanEndDate = new Date(job.checkpoint.scanEndDate);
            logger.info(`🔄 RESUMING: Original scan dates ${scanStartDate.toISOString().split('T')[0]} to ${scanEndDate.toISOString().split('T')[0]}`);
        } else {
            // 3. SCHEDULED DAILY RUN: Use lookback period (default: yesterday)
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

        // Stream documents directly from S3 and process inline (no array accumulation)
        logger.info(`🔍 Streaming S3 documents for date range: ${scanStartDate.toISOString()} to ${scanEndDate.toISOString()}`);

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

        // Always send progress/summary emails to admin
        const adminEmail = process.env.ADMIN_EMAIL || 'afatogun@buildinginfo.com';

        if (isResuming) {
            logger.info(`🔄 Resuming scan after ${job.checkpoint.lastProcessedFile || 'unknown file'}`);

            // Ensure triggeredBy uses admin email
            if (!job.checkpoint.triggeredBy?.email) {
                job.checkpoint.triggeredBy = {
                    email: adminEmail,
                    name: 'Admin',
                    timestamp: new Date()
                };
                await job.save();
                logger.info(`📧 Progress/summary emails will go to admin: ${adminEmail}`);
            }
        } else {
            // COUNT TOTAL DOCUMENTS UPFRONT (once, not incrementally)
            const totalDocumentCount = await fastS3Scanner.countDocumentsSince(scanStartDate, scanEndDate);

            // Always send progress/summary emails to admin
            const triggeredBy = {
                email: adminEmail,
                name: 'Admin',
                timestamp: new Date()
            };

            logger.info(`📧 Progress/summary emails will be sent to admin: ${adminEmail}`);

            job.checkpoint = {
                lastProcessedIndex: 0,
                lastProcessedFile: '',
                lastProcessedPath: '',
                scanStartDate: scanStartDate.toISOString(),
                scanEndDate: scanEndDate.toISOString(),
                totalDocuments: totalDocumentCount,
                processedCount: 0,
                matchesFound: 0,
                scanStartTime: new Date(),
                lastCheckpointTime: new Date(),
                isResuming: false,
                triggeredBy: triggeredBy,
                // Track all match details for final summary email
                allMatchDetails: []
            };
            await job.save();
            logger.info(`💾 Checkpoint initialized: ${totalDocumentCount} documents to process`);
        }

        let matches = []; // Use let instead of const so we can clear after sending
        let totalProcessed = isResuming ? job.checkpoint.processedCount : 0;
        let totalDocuments = job.checkpoint.totalDocuments; // Use stored count, don't increment
        let skippedNonPdf = 0;
        let skipping = isResuming && (job.checkpoint.lastProcessedPath || job.checkpoint.lastProcessedFile);
        const resumePath = job.checkpoint.lastProcessedPath;
        const resumeFile = job.checkpoint.lastProcessedFile;

        let streamStats;
        try {
            streamStats = await fastS3Scanner.streamDocumentsSince(
                scanStartDate,
                scanEndDate,
                async (document) => {
                    try {
                        // CHECK FOR CANCELLATION before processing each document
                        const currentJob = await ScanJob.findOne({ jobId: job.jobId });
                        if (currentJob && currentJob.status === 'CANCELLING') {
                            logger.warn(`🚫 Job ${job.jobId} is being cancelled - aborting processing`);

                            // Reset job status and checkpoint
                            currentJob.status = 'ACTIVE';
                            currentJob.checkpoint = {
                                lastProcessedIndex: 0,
                                lastProcessedFile: '',
                                lastProcessedPath: '',
                                processedCount: 0,
                                matchesFound: 0,
                                isResuming: false,
                                totalDocuments: 0
                            };
                            await currentJob.save();

                            // Throw error to break out of streaming loop
                            throw new Error('JOB_CANCELLED_BY_USER');
                        }

                        // Only process PDF and DOCX files
                        const fileName = document.fileName ? document.fileName.toLowerCase() : '';
                        if (!fileName.endsWith('.pdf') && !fileName.endsWith('.docx')) {
                            skippedNonPdf++;
                            return;
                        }

                        if (skipping) {
                            const currentKey = document.filePath || document.fileName;
                            if ((resumePath && currentKey === resumePath) || (resumeFile && document.fileName === resumeFile)) {
                                skipping = false; // Skip the last processed doc and continue
                            }
                            return;
                        }

                        // Yield control to event loop EVERY document to prevent health check timeouts
                        await new Promise(resolve => setImmediate(resolve));

                        totalProcessed++;
                        logger.info(`🔍 [${totalProcessed}/${totalDocuments}] Processing: ${document.fileName}`);

                        // Additional yield before heavy processing
                        await new Promise(resolve => setImmediate(resolve));

                        const result = await this.processDocument(document, job);

                        // Yield after processing each document
                        await new Promise(resolve => setImmediate(resolve));

                        // AGGRESSIVE memory cleanup after each document
                        if (result && result.extractedText) {
                            delete result.extractedText;
                        }

                        if (document.buffer) {
                            document.buffer = null;
                        }

                        // Force garbage collection every 10 documents
                        if (totalProcessed % 10 === 0 && global.gc) {
                            global.gc();
                            logger.debug(`🗑️ Forced GC at document ${totalProcessed}`);
                        }

                        // Check memory usage and pause if approaching limit
                        const memUsage = process.memoryUsage();
                        if (memUsage.heapUsed > 1500 * 1024 * 1024) {
                            logger.warn(`🚨 High memory usage: ${(memUsage.heapUsed / 1024 / 1024).toFixed(0)}MB - pausing briefly`);
                            await new Promise(resolve => setTimeout(resolve, 2000));
                            if (global.gc) global.gc();
                        }

                        if (result.isMatch) {
                            logger.info(`✅ MATCH FOUND: ${document.fileName} (confidence: ${(result.confidence * 100).toFixed(1)}%)`);
                            matches.push({
                                document,
                                result,
                                customers: job.customers
                            });

                            job.checkpoint.matchesFound = (job.checkpoint.matchesFound || 0) + 1;

                            // Track match details for final summary email
                            if (!job.checkpoint.allMatchDetails) {
                                job.checkpoint.allMatchDetails = [];
                            }
                            job.checkpoint.allMatchDetails.push({
                                fileName: document.fileName,
                                fiType: job.documentType,
                                validationQuote: result.validationQuote || 'No quote captured',
                                confidence: result.confidence,
                                timestamp: new Date()
                            });
                        } else {
                            logger.info(`❌ No match: ${document.fileName} (stage: ${result.stage})`);
                        }

                        // Update checkpoint after each document
                        job.checkpoint.lastProcessedIndex = totalProcessed - 1;
                        job.checkpoint.lastProcessedFile = document.fileName;
                        job.checkpoint.lastProcessedPath = document.filePath;
                        job.checkpoint.processedCount = totalProcessed;
                        job.checkpoint.totalDocuments = totalDocuments;

                        const shouldSave = totalProcessed <= 100 ||
                                         totalProcessed % SAVE_INTERVAL === 0 ||
                                         totalProcessed % CHECKPOINT_INTERVAL === 0;

                if (shouldSave) {
                    job.checkpoint.lastCheckpointTime = new Date();

                    // Log memory usage at checkpoints
                    const memUsage = process.memoryUsage();
                    const rssInMB = memUsage.rss / 1024 / 1024;
                    logger.info(`💾 Memory: ${(memUsage.heapUsed / 1024 / 1024).toFixed(2)}MB / ${(memUsage.heapTotal / 1024 / 1024).toFixed(2)}MB (RSS: ${rssInMB.toFixed(2)}MB)`);

                    // Circuit breaker: Stop if memory exceeds 1700MB (85% of 2GB Render limit)
                    if (rssInMB > 1700) {
                        logger.error(`🚨 MEMORY LIMIT APPROACHING: ${rssInMB.toFixed(2)}MB / 2048MB - Stopping scan to prevent crash`);
                        job.checkpoint.isResuming = true;
                        job.status = 'PAUSED';
                        await job.save();
                        throw new Error(`Memory limit reached at ${rssInMB.toFixed(2)}MB - scan paused for safety`);
                    }

                    // Force garbage collection if available (run with --expose-gc flag)
                    if (global.gc && totalProcessed % 100 === 0) {
                        global.gc();
                        logger.info('🗑️ Forced garbage collection');
                    }

                    await job.save();

                    // Only send progress email at CHECKPOINT_INTERVAL milestones
                    if (totalProcessed % CHECKPOINT_INTERVAL === 0) {
                        logger.info(`💾 Checkpoint saved at ${totalProcessed} documents`);

                        // Send match emails for all matches found in this batch
                        // Default autoProcess to true if undefined (for backward compatibility with existing jobs)
                        const autoProcess = job.config.autoProcess !== false; // true if undefined or true, false only if explicitly false
                        logger.info(`🔍 Match email check: matches.length=${matches.length}, autoProcess=${autoProcess} (raw: ${job.config.autoProcess})`);

                        if (matches.length > 0 && autoProcess) {
                            logger.info(`📧 Sending match emails for ${matches.length} matches found so far...`);

                            // Log validation quotes at checkpoint (sanity check)
                            logger.info(`\n📋 ===== CHECKPOINT VALIDATION QUOTES (${totalProcessed} docs) =====`);
                            matches.forEach((match, idx) => {
                                const fileName = match.document.fileName;
                                const quote = match.result.validationQuote || 'No quote captured';
                                logger.info(`[${idx + 1}] ${fileName}`);
                                logger.info(`    Quote: "${quote.substring(0, 200)}${quote.length > 200 ? '...' : ''}"`);
                            });
                            logger.info(`=================================================\n`);

                            await this.sendMatchEmails(matches, job);
                            logger.info(`✅ Match emails sent for checkpoint at ${totalProcessed} documents`);
                            matches = []; // Clear matches after sending to avoid duplicates
                        } else if (matches.length > 0 && !autoProcess) {
                            logger.warn(`⚠️ Found ${matches.length} matches but autoProcess is disabled - skipping match emails`);
                        }

                        // Send progress email to admin (internal progress update)
                        const triggeredByEmail = job.checkpoint.triggeredBy?.email || adminEmail;

                        if (triggeredByEmail) {
                            // Collect recent match details for the progress email
                            const recentMatches = (job.checkpoint.allMatchDetails || []).slice(-10); // Last 10 matches

                            await emailService.sendScanProgressEmail([triggeredByEmail], {
                                jobName: job.name,
                                documentType: job.documentType,
                                startTime: job.checkpoint.scanStartTime,
                                processedCount: totalProcessed,
                                totalDocuments: totalDocuments,
                                matchesFound: job.checkpoint.matchesFound || 0,
                                lastProcessedFile: document.fileName,
                                isCheckpoint: true,
                                // Include match details for visibility
                                recentMatches: recentMatches.map(m => ({
                                    fileName: m.fileName,
                                    fiType: m.fiType,
                                    validationQuote: m.validationQuote?.substring(0, 150) + (m.validationQuote?.length > 150 ? '...' : '')
                                }))
                            });
                            logger.info(`📧 Progress email sent to ${triggeredByEmail} (${totalProcessed} docs, ${job.checkpoint.matchesFound || 0} matches)`);
                        } else {
                            logger.warn(`⚠️ No triggeredBy email found, skipping progress email`);
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
                        job.checkpoint.lastProcessedIndex = totalProcessed - 1;
                        job.checkpoint.lastProcessedFile = document.fileName;
                        job.checkpoint.lastProcessedPath = document.filePath;
                        job.checkpoint.processedCount = totalProcessed;
                        job.checkpoint.totalDocuments = totalDocuments;
                        job.checkpoint.isResuming = true;
                        await job.save();

                        throw error;
                    }
                },
                { maxObjects: null, timeoutSeconds: null } // No timeout - allows continuous scanning of large projects
            );
        } catch (scanError) {
            // Handle user-initiated cancellation gracefully
            if (scanError.message === 'JOB_CANCELLED_BY_USER') {
                logger.info(`✅ Job ${job.jobId} cancelled cleanly by user`);
                return; // Exit gracefully without throwing error
            }

            logger.error(`❌ Error streaming S3 documents:`, scanError);
            throw scanError;
        }

        // Final checkpoint save on completion
        job.checkpoint.processedCount = totalProcessed;
        job.checkpoint.isResuming = false; // Clear resume flag
        await job.save();

        if (skippedNonPdf > 0) {
            logger.info(`⏭️  Skipped ${skippedNonPdf} unsupported files`);
        }

        if (streamStats && streamStats.totalMatched !== undefined) {
            job.checkpoint.totalDocuments = totalDocuments;
        }

        // Use job.checkpoint.matchesFound for accurate count (matches array gets cleared after each checkpoint email)
        const totalMatchesFound = job.checkpoint.matchesFound || 0;
        logger.info(`✅ Job ${job.jobId} complete: ${totalMatchesFound} matches found from ${totalProcessed} documents`);

        // Print validation quotes for any remaining matches (only those since last checkpoint)
        if (matches.length > 0) {
            logger.info('\n📋 ===== FINAL VALIDATION QUOTES =====');
            matches.forEach((match, index) => {
                const fileName = match.document.fileName;
                const quote = match.result.validationQuote || 'No quote captured';
                logger.info(`\n[${index + 1}] File: ${fileName}`);
                logger.info(`    Quote: "${quote.substring(0, 300)}${quote.length > 300 ? '...' : ''}"`);
            });
            logger.info('\n========================================\n');
        }

        // Send emails for matches
        // Default autoProcess to true if undefined (for backward compatibility with existing jobs)
        const autoProcess = job.config.autoProcess !== false;
        if (matches.length > 0 && autoProcess) {
            await this.sendMatchEmails(matches, job);
        }

        // Update job statistics - use checkpoint.matchesFound for accurate count
        job.statistics.totalScans = (job.statistics.totalScans || 0) + 1;
        job.statistics.totalDocumentsProcessed = (job.statistics.totalDocumentsProcessed || 0) + totalProcessed;
        job.statistics.totalMatches = (job.statistics.totalMatches || 0) + totalMatchesFound;
        job.statistics.lastScanDate = new Date();

        // SEND FINAL SUMMARY EMAIL TO ADMIN (always, even if zero matches)
        const triggeredByEmail = job.checkpoint.triggeredBy?.email || adminEmail;
        if (triggeredByEmail) {
            const duration = ((Date.now() - startTime) / 1000).toFixed(2);
            const allMatchDetails = job.checkpoint.allMatchDetails || [];

            await emailService.sendScanSummaryEmail(triggeredByEmail, {
                jobName: job.name,
                documentType: job.documentType,
                startTime: job.checkpoint.scanStartTime,
                endTime: new Date(),
                duration: duration,
                processedCount: totalProcessed,
                totalDocuments: totalDocuments,
                matchesFound: totalMatchesFound,
                // Include all match details for final summary
                matches: allMatchDetails.map(m => ({
                    fileName: m.fileName,
                    fiType: m.fiType,
                    validationQuote: m.validationQuote?.substring(0, 300) + (m.validationQuote?.length > 300 ? '...' : '')
                }))
            });
            logger.info(`📧 Final summary email sent to ${triggeredByEmail}`);
        } else {
            logger.warn(`⚠️ No triggeredBy email found, skipping final summary email`);
        }

        // Reset job status back to ACTIVE after completion (don't leave it as RUNNING)
        // This prevents the processor from thinking the job crashed if it was manually triggered
        job.status = 'ACTIVE';

        // Clear checkpoint after successful completion
        job.checkpoint = {
            lastProcessedIndex: 0,
            lastProcessedFile: '',
            lastProcessedPath: '',
            processedCount: 0,
            matchesFound: 0,
            isResuming: false,
            totalDocuments: 0
        };

        await job.save();

        const duration = ((Date.now() - startTime) / 1000).toFixed(2);
        logger.info(`⏱️ Job ${job.jobId} completed in ${duration}s - status reset to ACTIVE`);
    }

    /**
     * Process a single document - check if it's an FI request for the report type
     */
    async processDocument(document, job) {
        try {
            const fileName = document.fileName;
            const documentType = job.documentType; // e.g., 'acoustic'

            logger.info(`📄 Processing: ${fileName}`);

            // Add processing timeout to prevent health check timeouts
            const PROCESSING_TIMEOUT = 25000; // 25 seconds (less than 30s health check timeout)

            const processWithTimeout = new Promise(async (resolve, reject) => {
                const timeout = setTimeout(() => {
                    reject(new Error(`Processing timeout: ${fileName} took longer than ${PROCESSING_TIMEOUT/1000}s`));
                }, PROCESSING_TIMEOUT);

                try {
                    const result = await this.processDocumentInternal(document, job, fileName, documentType);
                    clearTimeout(timeout);
                    resolve(result);
                } catch (error) {
                    clearTimeout(timeout);
                    reject(error);
                }
            });

            return await processWithTimeout;

        } catch (error) {
            if (error.message.includes('Processing timeout')) {
                logger.warn(`⏱️ ${error.message} - Skipping to prevent health check timeout`);
                return {
                    isMatch: false,
                    stage: 'processing-timeout',
                    confidence: 0,
                    reasoning: 'Document processing timed out to prevent server health check failure',
                    error: error.message
                };
            }
            throw error;
        }
    }

    async processDocumentInternal(document, job, fileName, documentType) {
        try {
            // Download and extract text from the document
            const s3Key = document.filePath;
            let documentText = '';

            try {
                // Yield before heavy S3 download
                await new Promise(resolve => setImmediate(resolve));

                // Download from S3 using AWS SDK
                const AWS = require('aws-sdk');
                const s3 = new AWS.S3();

                const params = {
                    Bucket: process.env.S3_BUCKET || 'planning-documents-2',
                    Key: s3Key
                };

                const maxDocMb = parseInt(process.env.MAX_S3_OBJECT_MB || '25', 10);
                const streamThresholdMb = parseInt(process.env.STREAMING_PDF_THRESHOLD_MB || '8', 10);
                const maxBytes = maxDocMb * 1024 * 1024;
                const streamThresholdBytes = streamThresholdMb * 1024 * 1024;

                // Define tempDir at function scope for OCR fallback
                const tempDir = path.join(__dirname, '..', 'temp');

                let sizeBytes = 0;
                try {
                    const head = await s3.headObject(params).promise();
                    sizeBytes = head.ContentLength || 0;
                    if (sizeBytes > maxBytes) {
                        logger.warn(`⚠️ Skipping ${fileName} (${(sizeBytes / 1024 / 1024).toFixed(1)}MB) - exceeds ${maxDocMb}MB limit`);
                        return {
                            isMatch: false,
                            stage: 'file-too-large',
                            confidence: 0,
                            reasoning: `File size ${(sizeBytes / 1024 / 1024).toFixed(1)}MB exceeds ${maxDocMb}MB limit`
                        };
                    }
                } catch (headError) {
                    logger.warn(`⚠️ Could not read size for ${fileName}: ${headError.message}`);
                }

                const isDocx = fileName.toLowerCase().endsWith('.docx');

                if (!isDocx && sizeBytes > streamThresholdBytes) {
                    await fsp.mkdir(tempDir, { recursive: true });
                    const tempPath = path.join(
                        tempDir,
                        `scan-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`
                    );

                    const s3Stream = s3.getObject(params).createReadStream();
                    await pipeline(s3Stream, fs.createWriteStream(tempPath));

                    const streamingProcessor = new StreamingDocumentProcessor();
                    const streamingResult = await streamingProcessor.extractTextWithStreamingAndLimits(tempPath);

                    await fsp.unlink(tempPath).catch(() => null);

                    if (!streamingResult?.text) {
                        logger.error(`❌ Text extraction failed for ${fileName}: streaming extractor returned empty text`);
                        return {
                            isMatch: false,
                            stage: 'pdf-stream-parse-error',
                            confidence: 0,
                            reasoning: 'PDF streaming extraction returned empty text'
                        };
                    }

                    documentText = streamingResult.text;
                } else {
                    const s3Response = await s3.getObject(params).promise();
                    let fileBuffer = s3Response.Body;

                    // Clean up S3 response object
                    s3Response.Body = null;

                    // Yield after S3 download
                    await new Promise(resolve => setImmediate(resolve));

                    // Extract text using optimized zero-copy extractor
                    // For PDFs, write to disk for OCR fallback support
                    let extractionResult;
                    let tempFilePath = null;

                    if (isDocx) {
                        extractionResult = await optimizedPdfExtractor.extractDocxOptimized(fileBuffer, fileName);
                    } else {
                        // Write PDF to temp directory for OCR fallback
                        await fsp.mkdir(tempDir, { recursive: true });
                        tempFilePath = path.join(tempDir, fileName);
                        await fsp.writeFile(tempFilePath, fileBuffer);

                        extractionResult = await optimizedPdfExtractor.extractTextOptimized(fileBuffer, fileName, tempFilePath);

                        // Clean up temp file after extraction
                        try {
                            await fsp.unlink(tempFilePath);
                        } catch (unlinkError) {
                            logger.debug(`Could not delete temp file ${tempFilePath}: ${unlinkError.message}`);
                        }
                    }

                    // Null out buffer immediately after extraction
                    fileBuffer = null;

                    if (!extractionResult.success) {
                        logger.error(`❌ Text extraction failed for ${fileName}: ${extractionResult.error}`);
                        return {
                            isMatch: false,
                            stage: isDocx ? 'docx-parse-error' : 'pdf-parse-error',
                            confidence: 0,
                            reasoning: isDocx ? 'DOCX is corrupted or malformed' : 'PDF is corrupted or malformed',
                            error: extractionResult.error
                        };
                    }

                    documentText = extractionResult.text;
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
            // Yield before AI processing
            await new Promise(resolve => setImmediate(resolve));

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
                // Yield before expensive AI call
                await new Promise(resolve => setImmediate(resolve));

                const isFIRequest = await fiDetectionService.detectFIRequest(documentText);

                if (!isFIRequest) {
                    return {
                        isMatch: false,
                        stage: 'not-fi-request',
                        confidence: 0,
                        reasoning: 'Document is not an FI request'
                    };
                }

                // Yield before final AI call
                await new Promise(resolve => setImmediate(resolve));

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
                            customerId: customer.customerId._id.toString(), // Store MongoDB _id for FIReport
                            email: email,
                            name: customer.customerId.name,
                            filters: customer.customerId.filters || {}, // Store customer's subscription filters
                            matches: []
                        });
                    }

                    // Add match with document and project info (including validation quote)
                    customerMatchesMap.get(email).matches.push({
                        reportType: job.documentType,
                        projectId: document.projectId,
                        documentName: document.fileName,
                        validationQuote: result.validationQuote || 'No quote captured',
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

            // Apply customer subscription filters (county/sector)
            // Customers only receive matches that pass their filter criteria
            for (const customerData of customerMatchesMap.values()) {
                const customerFilters = customerData.filters || {};
                const allowedCounties = customerFilters.allowedCounties || [];
                const allowedSectors = customerFilters.allowedSectors || [];
                const hasActiveFilters = allowedCounties.length > 0 || allowedSectors.length > 0;

                // Debug: Log customer filter settings
                if (hasActiveFilters) {
                    logger.info(`🔍 ${customerData.email} subscription filters - Counties: [${allowedCounties.join(', ')}], Sectors: [${allowedSectors.join(', ')}]`);
                }

                // Filter matches based on customer's subscription
                const originalCount = customerData.matches.length;
                customerData.matches = customerData.matches.filter(match => {
                    const metadata = match.projectMetadata;
                    
                    // If no filters set, include all projects
                    if (!hasActiveFilters) return true;
                    
                    // Debug: Log what we're filtering
                    const projectCounty = metadata?.planning_county || 'NO_METADATA';
                    const projectSector = metadata?.planning_sector || 'NO_METADATA';
                    
                    if (!metadata) {
                        logger.warn(`⚠️ Project ${match.projectId}: No metadata - EXCLUDING (can't verify against active filters)`);
                        return false; // Exclude if no metadata when filters are active
                    }

                    // County check: empty allowedCounties = no restriction
                    // Use trim() to handle trailing spaces from API
                    const countyOK = allowedCounties.length === 0 ||
                        allowedCounties.some(county =>
                            metadata.planning_county &&
                            metadata.planning_county.trim().toLowerCase() === county.trim().toLowerCase()
                        );

                    // Sector check: empty allowedSectors = no restriction
                    const sectorOK = allowedSectors.length === 0 ||
                        allowedSectors.some(sector =>
                            metadata.planning_sector &&
                            metadata.planning_sector.trim().toLowerCase() === sector.trim().toLowerCase()
                        );

                    // Debug: Log filtering decisions for projects that fail
                    if (!countyOK || !sectorOK) {
                        logger.info(`🚫 Project ${match.projectId} (${projectCounty}/${projectSector}) EXCLUDED for ${customerData.email} - countyOK: ${countyOK}, sectorOK: ${sectorOK}`);
                    }

                    return countyOK && sectorOK;
                });

                if (originalCount !== customerData.matches.length) {
                    logger.info(`📋 ${customerData.email}: ${customerData.matches.length}/${originalCount} matches after applying subscription filters (counties: ${allowedCounties.length || 'all'}, sectors: ${allowedSectors.length || 'all'})`);
                }
            }

            // Send batch emails to each customer (only if they have eligible matches)
            let emailsSent = 0;
            let customersSkipped = 0;
            for (const customerData of customerMatchesMap.values()) {
                // Skip if no matches remain after filtering
                if (customerData.matches.length === 0) {
                    logger.info(`⏭️ Skipping ${customerData.email} - no matches after applying subscription filters`);
                    customersSkipped++;
                    continue;
                }

                const startTime = Date.now();
                let emailStatus = 'FAILED';
                let emailError = null;

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
                    emailStatus = 'SENT';
                    logger.info(`✉️ Sent batch email to ${customerData.email} (${customerData.matches.length} matches)`);

                    // Update Customer record with email statistics
                    try {
                        const customerRecord = await Customer.findById(customerData.customerId);
                        if (customerRecord) {
                            await customerRecord.recordEmailSent();
                            logger.info(`📈 Updated email stats for customer ${customerData.email}`);
                        }
                    } catch (customerUpdateError) {
                        logger.warn(`⚠️ Failed to update customer email stats for ${customerData.email}:`, customerUpdateError.message);
                    }

                } catch (error) {
                    emailError = error.message;
                    logger.error(`❌ Failed to send batch email to ${customerData.email}:`, error);
                }

                // Create FIReport record to track what was sent
                try {
                    const projectsFound = customerData.matches.map(match => ({
                        projectId: match.projectId,
                        planningTitle: match.projectMetadata?.planning_title || 'N/A',
                        planningStage: match.projectMetadata?.planning_stage || 'N/A',
                        planningValue: match.projectMetadata?.planning_value || 0,
                        planningCounty: match.projectMetadata?.planning_county || 'N/A',
                        planningRegion: match.projectMetadata?.planning_region || 'N/A',
                        biiUrl: match.projectMetadata?.bii_url || '',
                        fiIndicators: [match.reportType],
                        matchedKeywords: [],
                        confidence: 1,
                        metadata: {
                            documentName: match.documentName,
                            validationQuote: match.validationQuote,
                            summary: match.summary,
                            specificRequests: match.specificRequests,
                            planningSector: match.projectMetadata?.planning_sector || 'N/A'
                        }
                    }));

                    await fiReportService.createReport({
                        customerId: customerData.customerId,
                        customerEmail: customerData.email,
                        customerName: customerData.name,
                        reportType: 'BATCH_FI_NOTIFICATION',
                        status: emailStatus,
                        searchCriteria: {
                            projectTypes: [job.documentType],
                            customFilters: {
                                jobId: job.jobId,
                                allowedCounties: customerData.filters?.allowedCounties || [],
                                allowedSectors: customerData.filters?.allowedSectors || []
                            }
                        },
                        projectsFound: projectsFound,
                        totalProjectsScanned: matches.length,
                        totalFIMatches: customerData.matches.length,
                        processingTime: Date.now() - startTime,
                        source: 'SCHEDULED',
                        deliveryAttempts: emailStatus === 'SENT' ? [{
                            attemptNumber: 1,
                            timestamp: new Date(),
                            status: 'SUCCESS',
                            recipientEmail: customerData.email
                        }] : [{
                            attemptNumber: 1,
                            timestamp: new Date(),
                            status: 'FAILED',
                            recipientEmail: customerData.email,
                            error: emailError
                        }],
                        sentAt: emailStatus === 'SENT' ? new Date() : undefined
                    });

                    logger.info(`📊 Created FIReport for ${customerData.email} (${customerData.matches.length} matches, status: ${emailStatus})`);

                } catch (reportError) {
                    logger.error(`❌ Failed to create FIReport for ${customerData.email}:`, reportError);
                }
            }

            // Update job statistics
            job.statistics.totalEmailsSent = (job.statistics.totalEmailsSent || 0) + emailsSent;
            await job.save();

            logger.info(`✅ Sent ${emailsSent} batch email notifications for ${matches.length} total matches (${customersSkipped} customers skipped due to filters)`);

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
