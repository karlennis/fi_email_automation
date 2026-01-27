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
            // Get all active jobs
            const activeJobs = await ScanJob.find({ status: 'ACTIVE' })
                .populate('customers.customerId', 'email company name projectId');

            if (activeJobs.length === 0) {
                logger.info('📋 No active scan jobs to process');
                return;
            }

            logger.info(`🔍 Processing ${activeJobs.length} active scan jobs for ${today}...`);

            for (const job of activeJobs) {
                try {
                    // Check if this job has already been processed today
                    const lastScanDate = job.statistics.lastScanDate
                        ? new Date(job.statistics.lastScanDate).toISOString().split('T')[0]
                        : null;

                    if (lastScanDate === today) {
                        logger.info(`⏭️ Job ${job.jobId} already processed today, skipping...`);
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

        let scanDate, nextDay;

        if (targetDate) {
            // Use specified target date
            scanDate = new Date(targetDate);
            scanDate.setHours(0, 0, 0, 0);
            nextDay = new Date(scanDate);
            nextDay.setDate(nextDay.getDate() + 1);
            logger.info(`📅 Scanning document register for ${targetDate} (user-specified date)`);
        } else {
            // Default: Get yesterday's document register (projects updated the day before)
            scanDate = new Date();
            scanDate.setDate(scanDate.getDate() - 1);
            scanDate.setHours(0, 0, 0, 0);
            nextDay = new Date(scanDate);
            nextDay.setDate(nextDay.getDate() + 1);
            logger.info(`📅 Scanning document register for ${scanDate.toISOString().split('T')[0]} (projects updated the day before)`);
        }

        // Stream documents directly from S3 (memory safe, no register dependency)
        const documents = [];
        const dayEnd = new Date(nextDay);
        dayEnd.setHours(23, 59, 59, 999);

        logger.info(`🔍 Streaming S3 documents for date range: ${scanDate.toISOString()} to ${dayEnd.toISOString()}`);

        try {
            await fastS3Scanner.streamDocumentsSince(
                scanDate,
                dayEnd,
                async (doc) => {
                    // Only collect PDF files
                    if (doc.fileName && doc.fileName.toLowerCase().endsWith('.pdf')) {
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
            logger.info(`📋 No documents in register for ${scanDate.toISOString().split('T')[0]} for job ${job.jobId}`);
            return;
        }

        logger.info(`📄 Found ${documents.length} documents in register (updated ${scanDate.toISOString().split('T')[0]})`);

        // Use all customers assigned to this job
        const jobCustomers = job.customers.filter(c => c.customerId).map(c => c.customerId);

        logger.info(`👥 Job has ${jobCustomers.length} customers assigned`);

        if (jobCustomers.length === 0) {
            logger.warn(`⚠️ Job ${job.jobId} has no customers assigned`);
            return;
        }

        // Process ALL documents in the register
        logger.info(`🔍 Scanning all ${documents.length} documents for ${job.documentType} reports`);

        // Process each document through the 3-stage filter
        const matches = [];
        let totalProcessed = 0;
        let skippedNonPdf = 0;

        for (const document of documents) {
            try {
                // Only process PDF files
                if (!document.fileName || !document.fileName.toLowerCase().endsWith('.pdf')) {
                    skippedNonPdf++;
                    continue;
                }

                totalProcessed++;

                logger.info(`🔍 [${totalProcessed}/${documents.length - skippedNonPdf}] Scanning: ${document.projectId}/${document.fileName}`);

                const result = await this.processDocument(document, job);

                if (result.isMatch) {
                    logger.info(`✅ MATCH FOUND: ${document.fileName} (confidence: ${(result.confidence * 100).toFixed(1)}%)`);
                    matches.push({
                        document,
                        result,
                        customers: job.customers // Send to all assigned customers
                    });
                } else {
                    logger.info(`❌ No match: ${document.fileName} (stage: ${result.stage})`);
                }

            } catch (error) {
                logger.error(`❌ Error processing document ${document.fileName}:`, error);
            }
        }

        if (skippedNonPdf > 0) {
            logger.info(`⏭️  Skipped ${skippedNonPdf} non-PDF files`);
        }

        logger.info(`✅ Job ${job.jobId} complete: ${matches.length} matches found from ${totalProcessed} PDF documents`);

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

                // Extract text from PDF buffer
                const pdf = require('pdf-parse');
                const pdfData = await pdf(fileBuffer);
                documentText = pdfData.text;

                if (!documentText || documentText.length < 100) {
                    logger.warn(`⚠️ Insufficient text extracted from ${fileName} (${documentText.length} chars)`);
                    return {
                        isMatch: false,
                        stage: 'text-extraction',
                        confidence: 0,
                        reasoning: 'Could not extract sufficient text from document'
                    };
                }

                // Truncate to max size for AI (8000 chars as per config)
                if (documentText.length > 8000) {
                    documentText = documentText.substring(0, 8000);
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

            // Use FI detection service to check if it requests this report type
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
