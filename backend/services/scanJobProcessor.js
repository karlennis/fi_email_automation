const schedule = require('node-schedule');
const ScanJob = require('../models/ScanJob');
const Customer = require('../models/Customer');
const ScanJobDailyResult = require('../models/ScanJobDailyResult');
const PendingMetadataMatch = require('../models/PendingMetadataMatch');
const ProjectReportVeto = require('../models/ProjectReportVeto');
const fastS3Scanner = require('./fastS3Scanner');
const fiDetectionService = require('./fiDetectionService');
const s3Service = require('./s3Service');
const emailService = require('./emailService');
const buildingInfoService = require('./buildingInfoService');
const fiReportService = require('./fiReportService');
const documentIngestionService = require('./documentIngestionService');
const diskCleanupService = require('./diskCleanupService');
const logger = require('../utils/logger');
const runContext = require('../utils/runContext');
// Always called through the module object, never destructured: a destructured binding
// is captured at require time and silently bypasses a test's spy on the module.
const scanJobQueue = require('./scanJobQueue');
const optimizedPdfExtractor = require('./optimizedPdfExtractor');
const StreamingDocumentProcessor = require('./streamingDocumentProcessor');
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const { pipeline } = require('stream/promises');
const { normalizeReportType, getQuoteTerms } = require('./reportTypes');
const { getBucket } = require('../utils/awsConfig');
const { withLock } = require('./jobLock');

// Delivery-run attempts before an unfound-metadata match is permanently expired
const MAX_METADATA_RETRIES = 4;

// Quotes that carry no evidence. Matches holding only these are already dropped before
// the customer email; here they also rank last when choosing a project's best match.
const PLACEHOLDER_QUOTES = [
    'Match confirmed by AI',
    'No specific quote extracted',
    'No quote captured'
];

// Outcomes where the document could not actually be judged, as opposed to being judged
// and found not to match. Counted separately so a night of API or OCR failures cannot
// masquerade as a night with no FI requests in it.
const UNRESOLVED_STAGES = [
    'processing-timeout',
    'file-too-large',
    'pdf-stream-parse-error',
    'pdf-parse-error',
    'docx-parse-error',
    'text-extraction',
    'download-error',
    'detection-error',
    'error'
];

const REQUEST_VERBS = [
    'requested to', 'required to', 'is requested', 'is required',
    'shall submit', 'shall provide', 'should submit', 'should provide',
    'must submit', 'must provide', 'please submit', 'please provide',
    'carry out', 'undertake', 'prepare and submit', 'recommend', 'recommends'
];

class ScanJobProcessor {
    constructor() {
        this.isRunning = false;
        this.scheduledJob = null;
        this.deliverySweepJob = null;
        this.stuckJobSweepJob = null;
        this.lastProcessedDate = null; // Track last processed date to run once per day
    }

    /**
     * Initialize the scan job processor
     */
    async initialize() {
        try {
            if (process.env.SCAN_SCHEDULER_ENABLED === 'false') {
                logger.info('scan scheduler disabled (SCAN_SCHEDULER_ENABLED=false)');
                return;
            }

            // Schedule to run once daily at 12:10 AM (5 minutes after document register generation)
            this.scheduledJob = schedule.scheduleJob('10 0 * * *', async () => {
                await this.processActiveJobs();
            });

            // Sweep pending deliveries every minute so deferred sends fire at configured time.
            this.deliverySweepJob = schedule.scheduleJob('*/1 * * * *', async () => {
                await this.processPendingDeliveries();
            });

            // Recover jobs that failed out of the queue entirely. Without this a job that
            // exhausts its three Bull attempts sits in PAUSED forever - invisible to
            // processActiveJobs, which only looks for ACTIVE/RUNNING - and silently stops
            // producing leads for its customers.
            if (process.env.SCAN_STUCK_SWEEP_ENABLED !== 'false') {
                this.stuckJobSweepJob = schedule.scheduleJob('*/15 * * * *', async () => {
                    await this.sweepStuckJobs();
                });
            } else {
                logger.info('scan: stuck-job sweeper disabled (SCAN_STUCK_SWEEP_ENABLED=false)');
            }

            logger.info('scan job processor ready', {
                nightly: '00:10',
                delivery: 'every 1m',
                stuckSweep: this.stuckJobSweepJob ? 'every 15m' : 'off'
            });

            // Check if we should run on startup (if we haven't run today yet)
            const today = new Date().toISOString().split('T')[0];
            if (this.lastProcessedDate !== today) {
                logger.info('scan: running initial scan on startup');
                setTimeout(() => this.processActiveJobs(), 5000);
            }

            // Also check any pending deferred deliveries on startup.
            setTimeout(() => this.processPendingDeliveries(), 10000);

        } catch (error) {
            logger.error('scan job processor failed to initialize', error);
        }
    }

    /**
     * Process all active scan jobs
     */
    async processActiveJobs() {
        return runContext.runWith({ runId: runContext.newRunId('NIGHTLY') }, async () => {
            if (this.isRunning) {
                logger.info('nightly: already in progress, skipping');
                return;
            }

            // Check if we've already run today
            const today = new Date().toISOString().split('T')[0];
            if (this.lastProcessedDate === today) {
                logger.info('nightly: already processed today, skipping', { today });
                return;
            }

            // Defence in depth: this runs in the single fork-mode worker today, but both
            // in-process guards above are wiped by a restart, so a crash-loop around 12:10 AM
            // could enqueue the same job repeatedly.
            const outcome = await withLock(
                'scan-job-enqueue-daily',
                {
                    ttlMs: 10 * 60 * 1000,
                    skipMessage: 'nightly: enqueue lock held by another process, skipping'
                },
                () => this.enqueueDueJobs(today)
            );

            return outcome.ran ? outcome.result : undefined;
        });
    }

    async enqueueDueJobs(today) {
        this.isRunning = true;
        let enqueued = 0, resumed = 0, skipped = 0, failed = 0;

        try {
            // Get all active and running jobs
            const activeJobs = await ScanJob.find({ status: { $in: ['ACTIVE', 'RUNNING'] } })
                .populate('customers.customerId', 'email company name projectId filters');

            // One line per job in the database, every night. Useful when a job has gone
            // missing, noise the rest of the time - so it lands in debug-DATE.log only.
            const allJobs = await ScanJob.find({});
            for (const job of allJobs) {
                logger.debug('nightly: job state', {
                    job: job.jobId,
                    status: job.status,
                    done: job.checkpoint?.processedCount || 0,
                    total: job.checkpoint?.totalDocuments || 0,
                    resuming: !!job.checkpoint?.isResuming
                });
            }

            if (activeJobs.length === 0) {
                logger.info('run start: nightly enqueue — no active jobs', { today });
                return;
            }

            logger.info('run start: nightly enqueue', { today, jobs: activeJobs.length });

            for (const job of activeJobs) {
                try {
                    // Heartbeat check: a job that is actively scanning updates
                    // checkpoint.lastCheckpointTime frequently. A live run normally sits in
                    // status=RUNNING, so we must NOT treat that as "interrupted" — doing so
                    // mislabels it ACTIVE and enqueues a duplicate (concurrent) resume.
                    const HEARTBEAT_STALE_MS = 15 * 60 * 1000; // 15 min without progress = stalled/crashed
                    const lastBeat = job.checkpoint?.lastCheckpointTime
                        ? new Date(job.checkpoint.lastCheckpointTime).getTime()
                        : 0;
                    const heartbeatAgeMs = Date.now() - lastBeat;
                    const isActivelyScanning = lastBeat > 0 && heartbeatAgeMs < HEARTBEAT_STALE_MS;

                    if (isActivelyScanning) {
                        skipped++;
                        logger.info('nightly: skip, already scanning', {
                            job: job.jobId,
                            beatAgeSec: Math.round(heartbeatAgeMs / 1000),
                            done: job.checkpoint?.processedCount || 0,
                            total: job.checkpoint?.totalDocuments || 0
                        });
                        continue;
                    }

                    // Check if this job needs to resume from a crash
                    const needsResume = job.checkpoint && job.checkpoint.isResuming;

                    // Interrupted scan: status=RUNNING with a stale heartbeat means the process
                    // crashed mid-scan (no live worker is advancing the checkpoint).
                    const wasInterrupted = job.status === 'RUNNING' && job.checkpoint && job.checkpoint.processedCount > 0;


                    // Also check for incomplete scans (has checkpoint but didn't finish all documents)
                    const isIncomplete = job.checkpoint &&
                                       job.checkpoint.processedCount > 0 &&
                                       job.checkpoint.totalDocuments > 0 &&
                                       job.checkpoint.processedCount < job.checkpoint.totalDocuments;

                    if (needsResume || wasInterrupted || isIncomplete) {
                        // Why we are resuming matters when a job keeps restarting, so the
                        // cause stays a field rather than three near-identical messages.
                        const cause = wasInterrupted ? 'interrupted' : isIncomplete ? 'incomplete' : 'checkpoint';
                        if (wasInterrupted) {
                            job.checkpoint.isResuming = true;
                            job.status = 'ACTIVE';
                            await job.save();
                        } else if (isIncomplete) {
                            job.checkpoint.isResuming = true;
                            await job.save();
                        }
                        resumed++;
                        logger.info('nightly: enqueue resume', {
                            job: job.jobId,
                            cause,
                            done: job.checkpoint.processedCount,
                            total: job.checkpoint.totalDocuments || 0
                        });
                        // Pass null - processJob will use checkpoint dates for resuming
                        await scanJobQueue.enqueueScanJob(job.jobId, { targetDate: null });
                        continue;
                    }

                    // Check if this job should run based on its schedule
                    const shouldRun = this.shouldJobRun(job, today);

                    if (!shouldRun) {
                        skipped++;
                        logger.info('nightly: skip, not scheduled today', {
                            job: job.jobId,
                            schedule: job.schedule?.type || 'DAILY'
                        });
                        continue;
                    }

                    // SCHEDULED DAILY RUN: Pass null - processJob will use lookback (yesterday)
                    await scanJobQueue.enqueueScanJob(job.jobId, { targetDate: null });
                    enqueued++;

                    // Then top up any earlier day this job never covered. Deliberately not
                    // reached from the resume branches above: a job that is mid-way through
                    // a day should finish it before being handed a second one.
                    await this.enqueueBackfill(job);
                } catch (error) {
                    failed++;
                    logger.error('nightly: enqueue failed', { job: job.jobId, err: error.message, stack: error.stack });
                }
            }

            // Mark that we've processed today
            this.lastProcessedDate = today;

            logger.info('run end: nightly enqueue', { enqueued, resumed, skipped, failed });

        } catch (error) {
            logger.error('run end: nightly enqueue FAILED', error);
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
        // The individual setup facts below are debug; what the run was configured to do
        // is reported as one 'scan config' record once the dates are resolved.
        logger.debug('scan: job loaded', { name: job.name, type: job.documentType });

        const startTime = Date.now();

        let scanStartDate, scanEndDate;
        let scanMode = 'unknown';

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
            scanMode = 'manual';
            // Note: Date is stored in checkpoint below, not in job.schedule
        } else if (isResuming && job.checkpoint.scanStartDate && job.checkpoint.scanEndDate) {
            // 2. RESUMING: Use stored dates from checkpoint
            scanStartDate = new Date(job.checkpoint.scanStartDate);
            scanEndDate = new Date(job.checkpoint.scanEndDate);
            scanMode = 'resume';
        } else {
            // Scheduled recurring runs always scan only yesterday.
            // Delivery uses lookbackDays to aggregate recent daily results on delivery day.
            const lookbackDays = 1;

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

            scanMode = `lookback-${lookbackDays}d`;
        }

        // Stream documents directly from S3 and process inline (no array accumulation)
        logger.info('scan config', {
            mode: scanMode,
            type: job.documentType,
            from: scanStartDate.toISOString().split('T')[0],
            to: scanEndDate.toISOString().split('T')[0],
            customers: (job.customers || []).length
        });

        // Use all customers assigned to this job
        const jobCustomers = job.customers.filter(c => c.customerId).map(c => c.customerId);
        logger.debug('scan: customers assigned', { customers: jobCustomers.length });

        if (jobCustomers.length === 0) {
            logger.warn('scan: job has no customers assigned');
            return;
        }

        // Initialize or resume checkpoint
        const CHECKPOINT_INTERVAL = 10000; // Send progress email every 10,000 documents
        // How often the run reports progress to the log. A 3,000-document night gets
        // ~6 lines here instead of the ~12,000 the old per-document logging produced.
        const PROGRESS_INTERVAL = parseInt(process.env.SCAN_PROGRESS_INTERVAL || '500', 10);
        const scanStartedAt = Date.now();
        const SAVE_INTERVAL = 100; // Save checkpoint to DB every 100 docs (for crash recovery)

        // Always send progress/summary emails to admin
        const adminEmail = process.env.ADMIN_EMAIL || 'afatogun@buildinginfo.com';

        if (isResuming) {
            logger.info('scan: resuming after last processed file', { after: job.checkpoint.lastProcessedFile || 'unknown' });

            // Ensure triggeredBy uses admin email
            if (!job.checkpoint.triggeredBy?.email) {
                job.checkpoint.triggeredBy = {
                    email: adminEmail,
                    name: 'Admin',
                    timestamp: new Date()
                };
                await job.save();
                logger.debug('scan: progress emails routed to admin', { to: adminEmail });
            }

            // Fix missing totalDocuments from older checkpoints
            if (!job.checkpoint.totalDocuments || job.checkpoint.totalDocuments === 0) {
                logger.debug('scan: counting documents for resumed job (totalDocuments missing)');
                const totalDocumentCount = await fastS3Scanner.countDocumentsSince(scanStartDate, scanEndDate);
                job.checkpoint.totalDocuments = totalDocumentCount;
                await job.save();
                logger.debug('scan: total documents resolved', { total: totalDocumentCount });
            }

            // Fix missing scanStartTime from older checkpoints
            if (!job.checkpoint.scanStartTime) {
                job.checkpoint.scanStartTime = new Date();
                await job.save();
                logger.debug('scan: filled in missing scanStartTime for resumed job');
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

            logger.debug('scan: progress emails routed to admin', { to: adminEmail });

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
            logger.info('scan: checkpoint initialised', { toProcess: totalDocumentCount });
        }

        let matches = []; // Use let instead of const so we can clear after sending
        let totalProcessed = isResuming ? job.checkpoint.processedCount : 0;
        let totalDocuments = job.checkpoint.totalDocuments; // Use stored count, don't increment
        let skippedNonPdf = 0;
        let skippedBaseline = 0; // Track documents skipped due to baseline markers
        let weakEvidenceCount = 0;  // AI matched but evidence validation failed
        let vetoedDocuments = 0;    // Response documents that suppressed their project
        let unresolvedCount = 0;    // Could not be judged: parse/OCR/timeout/API failures
        const baselineProjectCache = new Map(); // Cache baseline check results per project
        // Baseline checks fail closed (an S3 error reports "baselined"), which is right
        // per-project but hides a bulk failure: a 403 on the prefix would make every
        // project look baselined and the night would scan nothing.
        s3Service.resetBaselineCheckErrorCount();
        // hasBaselineMarker fails closed, which is right per-project but hides a bulk
        // failure: a 403 on the whole prefix would make every project look baselined and
        // the night would scan nothing at all. Reset here, checked after the stream.
        s3Service.resetBaselineCheckErrorCount();
        let skipping = isResuming && (job.checkpoint.lastProcessedPath || job.checkpoint.lastProcessedFile);
        const resumePath = job.checkpoint.lastProcessedPath;
        const resumeFile = job.checkpoint.lastProcessedFile;
        let resumeSkipped = 0;

        // Now that checkpoint.allMatchDetails persists (it was previously dropped by
        // Mongoose strict mode), a resumed scan continues appending to the pre-crash
        // matches rather than starting from an empty array.
        if (isResuming && job.checkpoint.allMatchDetails?.length > 0) {
            logger.info('scan: matches recovered from checkpoint', { matches: job.checkpoint.allMatchDetails.length });
        }

        // Log baseline check date range for debugging
        const today = new Date().toISOString().split('T')[0];
        const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().split('T')[0];
        logger.debug('scan: baseline check enabled', { window: `${yesterday}..${today}` });

        // Helper to calculate actual eligible documents (excluding baselined)
        const getEligibleCount = () => totalDocuments - skippedBaseline;

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
                            logger.warn('scan: cancelled by user, aborting');

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

                        // Check if project is baselined (first-time ingestion, skip FI scan)
                        const projectId = document.projectId;
                        if (projectId) {
                            // Use cache to avoid repeated S3 checks for same project
                            if (!baselineProjectCache.has(projectId)) {
                                const isBaselined = await documentIngestionService.shouldSkipFIScan(projectId);
                                baselineProjectCache.set(projectId, isBaselined);
                                if (isBaselined) {
                                    logger.debug('scan: project baselined, skipping its documents', { proj: projectId });
                                }
                            }

                            if (baselineProjectCache.get(projectId)) {
                                skippedBaseline++;
                                return; // Skip this document - project is newly baselined
                            }
                        }

                        if (skipping) {
                            const currentKey = document.filePath || document.fileName;

                            // S3 returns keys in lexicographic order, so anything at or
                            // before the checkpoint has already been processed.
                            //
                            // Comparing by order rather than waiting to re-encounter the
                            // exact checkpoint key matters: if that key is gone from the
                            // stream - deleted, or the window shifted - equality never
                            // holds, every document is skipped, and the job "completes"
                            // having processed nothing and then clears its checkpoint.
                            if (resumePath) {
                                if (currentKey > resumePath) {
                                    skipping = false;
                                } else {
                                    resumeSkipped++;
                                    return;
                                }
                            } else if (resumeFile) {
                                resumeSkipped++;
                                if (document.fileName === resumeFile) {
                                    skipping = false;
                                }
                                return;
                            } else {
                                skipping = false;
                            }
                        }

                        // Yield control to event loop EVERY document to prevent health check timeouts
                        await new Promise(resolve => setImmediate(resolve));

                        totalProcessed++;
                        const eligibleCount = getEligibleCount();

                        // Additional yield before heavy processing
                        await new Promise(resolve => setImmediate(resolve));

                        // Everything the document touches - extraction, OCR, AI detection -
                        // is tagged with the file and project, so no downstream message has
                        // to repeat them and an error can be traced to one document.
                        const result = await runContext.runWith(
                            { file: document.fileName, proj: document.projectId },
                            () => this.processDocument(document, job)
                        );

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
                            logger.debug('scan: forced GC', { at: totalProcessed });
                        }

                        // Check memory usage and pause if approaching limit
                        const memUsage = process.memoryUsage();
                        if (memUsage.heapUsed > 1500 * 1024 * 1024) {
                            logger.warn('scan: high memory, pausing briefly', { heapMB: Math.round(memUsage.heapUsed / 1048576), at: totalProcessed });
                            await new Promise(resolve => setTimeout(resolve, 2000));
                            if (global.gc) global.gc();
                        }

                        if (result.isMatch) {
                            logger.info('MATCH', { type: job.documentType, confidence: (result.confidence * 100).toFixed(1) + '%' });
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
                                projectId: document.projectId,
                                fileName: document.fileName,
                                filePath: document.filePath,
                                fiType: job.documentType,
                                validationQuote: result.validationQuote || 'No quote captured',
                                confidence: result.confidence,
                                timestamp: new Date()
                            });
                        } else {
                            // Count the outcomes that indicate a possible recall problem
                            // rather than a genuine non-match, so they are measurable
                            // instead of being visible only as a log line.
                            if (result.needsReview || result.stage === 'weak-evidence') {
                                weakEvidenceCount++;
                                logger.warn('NEEDS REVIEW: AI matched but evidence validation failed', { type: job.documentType });
                            } else if (result.stage === 'fi-response-veto') {
                                vetoedDocuments++;
                            } else if (UNRESOLVED_STAGES.includes(result.stage)) {
                                unresolvedCount++;
                            }
                            logger.debug('no match', { stage: result.stage });
                        }

                        // Update checkpoint after each document
                        job.checkpoint.lastProcessedIndex = totalProcessed - 1;
                        job.checkpoint.lastProcessedFile = document.fileName;
                        job.checkpoint.lastProcessedPath = document.filePath;
                        job.checkpoint.processedCount = totalProcessed;
                        // Store eligible count (excludes baselined/new-project docs) so progress denominator is accurate
                        job.checkpoint.totalDocuments = getEligibleCount();
                        job.checkpoint.totalDocumentsRaw = totalDocuments;

                        // The one line per PROGRESS_INTERVAL documents that replaces the
                        // four per document: enough to see the run moving and how fast,
                        // without burying everything else. Deliberately outside the
                        // checkpoint branch below, which only fires on multiples of 100.
                        if (totalProcessed % PROGRESS_INTERVAL === 0) {
                            const elapsedSec = (Date.now() - scanStartedAt) / 1000;
                            logger.info('scan: progress', {
                                done: totalProcessed,
                                of: getEligibleCount(),
                                matched: job.checkpoint.matchesFound || 0,
                                unresolved: unresolvedCount,
                                perSec: elapsedSec > 0 ? (totalProcessed / elapsedSec).toFixed(1) : '0',
                                rssMB: Math.round(process.memoryUsage().rss / 1048576)
                            });
                        }

                        const shouldSave = totalProcessed <= 100 ||
                                         totalProcessed % SAVE_INTERVAL === 0 ||
                                         totalProcessed % CHECKPOINT_INTERVAL === 0;

                if (shouldSave) {
                    job.checkpoint.lastCheckpointTime = new Date();

                    const memUsage = process.memoryUsage();
                    const rssInMB = memUsage.rss / 1024 / 1024;
                    logger.debug('scan: checkpoint memory', {
                        heapMB: Math.round(memUsage.heapUsed / 1048576),
                        rssMB: Math.round(rssInMB)
                    });

                    // Circuit breaker: Stop if memory exceeds 1700MB (85% of 2GB Render limit)
                    if (rssInMB > 1700) {
                        logger.error('scan: memory limit approaching, pausing scan', {
                            rssMB: Math.round(rssInMB),
                            limitMB: 2048,
                            at: totalProcessed
                        });
                        job.checkpoint.isResuming = true;
                        job.status = 'PAUSED';
                        await job.save();
                        throw new Error(`Memory limit reached at ${rssInMB.toFixed(2)}MB - scan paused for safety`);
                    }

                    // Force garbage collection if available (run with --expose-gc flag)
                    if (global.gc && totalProcessed % 100 === 0) {
                        global.gc();
                        logger.debug('scan: forced garbage collection');
                    }

                    await job.save();

                    // Only send progress email at CHECKPOINT_INTERVAL milestones
                    if (totalProcessed % CHECKPOINT_INTERVAL === 0) {

                        // Never send customer emails at checkpoint milestones.
                        // Matches are persisted in checkpoint/allMatchDetails and delivered on delivery day.
                        // Clear local match buffer — matches are persisted in allMatchDetails (checkpoint)
                        // and will be delivered on the configured delivery day via deliverResultsForJob()
                        if (matches.length > 0) {
                            logger.info('scan: matches buffered for delivery day', { matches: matches.length, at: totalProcessed });
                            matches = [];
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
                                totalDocuments: getEligibleCount(), // Use eligible count (excluding baselined)
                                matchesFound: job.checkpoint.matchesFound || 0,
                                lastProcessedFile: document.fileName,
                                isCheckpoint: true,
                                skippedBaseline: skippedBaseline, // Include baseline skip count for transparency
                                baselinedProjects: baselineProjectCache.size,
                                // Include match details for visibility
                                recentMatches: recentMatches.map(m => ({
                                    fileName: m.fileName,
                                    fiType: m.fiType,
                                    validationQuote: m.validationQuote?.substring(0, 150) + (m.validationQuote?.length > 150 ? '...' : '')
                                }))
                            });
                            logger.info('scan: progress email sent', { to: triggeredByEmail, done: totalProcessed, matched: job.checkpoint.matchesFound || 0 });
                        } else {
                            logger.warn('scan: no triggeredBy address, progress email skipped');
                        }
                    } else {
                        logger.debug('scan: checkpoint saved', { at: totalProcessed });
                    }
                }

                    } catch (error) {
                        logger.error('scan: document FAILED', { err: error.message, stack: error.stack });

                        // Save checkpoint even on error to allow resume
                        job.checkpoint.lastProcessedIndex = totalProcessed - 1;
                        job.checkpoint.lastProcessedFile = document.fileName;
                        job.checkpoint.lastProcessedPath = document.filePath;
                        job.checkpoint.processedCount = totalProcessed;
                        // Store eligible count (excludes baselined/new-project docs) so progress denominator is accurate
                        job.checkpoint.totalDocuments = getEligibleCount();
                        job.checkpoint.totalDocumentsRaw = totalDocuments;
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
                logger.info('run end: scan cancelled by user');
                return; // Exit gracefully without throwing error
            }

            logger.error('scan: S3 stream failed', scanError);
            throw scanError;
        }

        // Final checkpoint save on completion
        job.checkpoint.processedCount = totalProcessed;
        job.checkpoint.isResuming = false; // Clear resume flag
        await job.save();

        // Counts land in the run summary below; only the case that signals a broken
        // pipeline is worth a line of its own.
        if (skippedBaseline === 0 && totalProcessed > 0 && baselineProjectCache.size === 0) {
            logger.warn('scan: no baseline markers found, every document was scanned - did the routing job run?', {
                processed: totalProcessed
            });
        }

        if (streamStats && streamStats.totalMatched !== undefined) {
            // Store eligible count (excludes baselined/new-project docs) so progress denominator is accurate
            job.checkpoint.totalDocuments = getEligibleCount();
            job.checkpoint.totalDocumentsRaw = totalDocuments;
        }

        // Use job.checkpoint.matchesFound for accurate count (matches array gets cleared after each checkpoint email)
        const totalMatchesFound = job.checkpoint.matchesFound || 0;
        const eligibleDocuments = getEligibleCount();

        // One record rather than the thirteen-line banner this used to print. Every number
        // a post-mortem needs is a field, so `npm run logs -- --run <id>` shows the whole
        // outcome on one line and --json | jq can pull any of it back out.
        logger.info('scan summary', {
            inRange: totalDocuments,
            eligible: eligibleDocuments,
            processed: totalProcessed,
            matched: totalMatchesFound,
            baselineSkipped: skippedBaseline,
            baselineProjects: baselineProjectCache.size,
            unsupportedSkipped: skippedNonPdf,
            resumeSkipped,
            vetoed: vetoedDocuments,
            weakEvidence: weakEvidenceCount,
            unresolved: unresolvedCount
        });

        // Promoted out of the summary because each means the counts above overstate what
        // the night actually covered.
        if (weakEvidenceCount > 0) {
            logger.warn('scan: AI matched but evidence validation failed - needs review', {
                count: weakEvidenceCount
            });
        }
        if (unresolvedCount > 0) {
            const pct = totalProcessed > 0 ? ((unresolvedCount / totalProcessed) * 100).toFixed(1) : '0.0';
            logger.warn('scan: documents could not be judged (parse/OCR/timeout/API failure)', {
                count: unresolvedCount,
                pctOfProcessed: pct
            });
        }

        // A large unresolved fraction means the day's coverage is not what the counts
        // suggest - these documents were never actually assessed.
        if (totalProcessed > 0 && unresolvedCount / totalProcessed > 0.2) {
            logger.error('scan: match count for this day is not trustworthy - too many documents unassessed', {
                unresolved: unresolvedCount,
                processed: totalProcessed
            });
        }

        // Baseline checks fail closed, so a widespread S3 failure presents as "everything
        // is baselined" and the scan quietly covers nothing at all.
        //
        // This check used to be written out twice, in two consecutive blocks that called
        // getBaselineCheckErrorCount() separately and logged and alerted on the same
        // condition - so one bad night sent the operator two identical critical emails.
        const baselineCheckErrors = s3Service.getBaselineCheckErrorCount();
        if (baselineCheckErrors > 0) {
            const checked = baselineProjectCache.size || 1;
            logger.error('scan: baseline marker checks failed and were treated as baselined - those projects were skipped without being examined', {
                failed: baselineCheckErrors,
                checked
            });

            if (baselineCheckErrors / checked > 0.5) {
                await this.sendJobAlert(job, {
                    severity: 'critical',
                    subject: `Scan job ${job.jobId} could not check baseline markers`,
                    headline:
                        `${baselineCheckErrors} of ${checked} baseline checks failed. Failed checks are treated as ` +
                        `"already baselined", so most of this night's projects were skipped rather than scanned. ` +
                        `The scan will report success with few or no matches.`,
                    details: {
                        'Failed checks': baselineCheckErrors,
                        'Projects checked': checked,
                        'Documents processed': totalProcessed,
                        'Matches found': totalMatchesFound
                    },
                    action: 'Check S3 credentials and read permissions on planning-docs/, then re-run this day with a targetDate.'
                });
            }
        }

        // A resume that processes nothing means the checkpoint was past the end of the
        // stream - the window moved, or the remaining keys are gone. Say so loudly: this
        // previously looked like a clean scan of a day that had no FI requests in it.
        if (isResuming && totalProcessed === 0 && eligibleDocuments > 0) {
            logger.error(
                `🚨 Job ${job.jobId} resumed and processed 0 of ${eligibleDocuments} eligible documents ` +
                `(${resumeSkipped} skipped past checkpoint "${resumePath || resumeFile}"). ` +
                `The stored results for this day are incomplete and the day should be rescanned.`
            );
        }

        // Validation quotes for any remaining matches (only those since last checkpoint).
        // Two lines and up to 300 characters per match at info level was the single
        // largest thing between a reader and the summary above; the quotes themselves are
        // also persisted on the match record, so debug is enough here.
        for (const match of matches) {
            logger.debug('scan: validation quote', {
                file: match.document.fileName,
                quote: (match.result.validationQuote || 'No quote captured').substring(0, 200)
            });
        }

        // Clear remaining local match buffer (all matches already in allMatchDetails via checkpoint)
        matches = [];

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
                totalDocuments: getEligibleCount(), // Use eligible count (excluding baselined)
                totalDocumentsRaw: totalDocuments, // Include raw count for reference
                matchesFound: totalMatchesFound,
                skippedBaseline: skippedBaseline, // Documents skipped due to baseline markers
                baselinedProjects: baselineProjectCache.size, // Number of baselined projects
                // Include all match details for final summary
                matches: allMatchDetails.map(m => ({
                    projectId: m.projectId,
                    fileName: m.fileName,
                    fiType: m.fiType,
                    validationQuote: m.validationQuote?.substring(0, 300) + (m.validationQuote?.length > 300 ? '...' : '')
                }))
            });
            logger.info('scan: final summary email sent', { to: triggeredByEmail });
        } else {
            logger.warn('scan: no triggeredBy address, final summary email skipped');
        }

        // Reset job status back to ACTIVE after completion (don't leave it as RUNNING)
        // SAVE TODAY'S SCAN RESULT (crash-safe — persisted independently per day)
        const scanDateKey = new Date(scanEndDate);
        scanDateKey.setHours(0, 0, 0, 0);
        await this.saveDailyScanResult(job, {
            scanDate: scanDateKey,
            scanStartDate,
            scanEndDate,
            matches: job.checkpoint.allMatchDetails || [],
            processedCount: totalProcessed,
            eligibleCount: getEligibleCount(),
            skippedBaseline,
            baselinedProjects: baselineProjectCache.size
        });

        // CUSTOMER DELIVERY — only on configured delivery day
        const autoProcess = job.config.autoProcess !== false;
        if (autoProcess && this.isDeliveryDay(job, today)) {
            if (!this.shouldApplyDeliveryTimeGate(job)) {
                logger.info('delivery: due now, no time gate', { schedule: job.schedule?.type || 'DAILY' });
                // Refresh recipients from DB so customers removed during this run are excluded
                await this.refreshJobCustomers(job);
                await this.deliverResultsForJob(job, scanDateKey);
                this.markDeliverySent(job, today);
            } else if (job.deliveryState?.sentForDate === today) {
                logger.info('delivery: already sent today, skipping duplicate', { today });
            } else if (this.hasReachedDeliveryTime(job, new Date())) {
                logger.info('delivery: due now, aggregating');
                // Refresh recipients from DB so customers removed during this run are excluded
                await this.refreshJobCustomers(job);
                // Deliver based on the latest fully scanned day (yesterday for scheduled runs).
                await this.deliverResultsForJob(job, scanDateKey);
                this.markDeliverySent(job, today);
            } else {
                const anchorDateStr = scanDateKey.toISOString().split('T')[0];
                this.markDeliveryPending(job, today, anchorDateStr);
                logger.info('delivery: deferred', { until: this.getDeliveryTimeParts(job).timeLabel });
            }
        } else {
            // Not a configured delivery day at completion time. However, if this scan ran
            // long (e.g. spanned past its delivery day), we may have MISSED that delivery
            // window entirely. In that case, deliver the accumulated results now rather
            // than waiting a full cycle.
            const dueDateStr = this.getMostRecentDeliveryDateStr(job, today);
            const lastSent = job.deliveryState?.sentForDate || null;
            const startStr = job.checkpoint?.scanStartTime
                ? new Date(job.checkpoint.scanStartTime).toISOString().split('T')[0]
                : null;
            // Established cadence: a prior delivery exists and the most recent due date wasn't sent.
            // First-time: never delivered, but the run was already in progress on/before the due date
            // (so the delivery day genuinely elapsed mid-scan) — avoids premature off-cycle sends.
            const missedDelivery = autoProcess && !!dueDateStr && (
                lastSent ? lastSent < dueDateStr : (!!startStr && startStr <= dueDateStr)
            );

            if (missedDelivery) {
                logger.info('delivery: catch-up for a missed delivery day', { due: dueDateStr, scanFinished: today, lastSent: lastSent || 'never' });
                await this.refreshJobCustomers(job);
                await this.deliverResultsForJob(job, scanDateKey);
                this.markDeliverySent(job, today);
            } else {
                logger.info('delivery: results saved, not a delivery day', { schedule: job.schedule?.type || 'DAILY' });
            }
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

        // Cleanup temp files after job completion to prevent disk filling up
        await diskCleanupService.runCleanup();

        const duration = ((Date.now() - startTime) / 1000).toFixed(2);
        logger.info('scan: job reset to ACTIVE', { sec: Math.round(Number(duration)) });
    }

    /**
     * Process a single document - check if it's an FI request for the report type
     */
    async processDocument(document, job) {
        try {
            const fileName = document.fileName;
            const documentType = job.documentType; // e.g., 'acoustic'

            logger.debug('doc: start', { type: documentType });

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
                logger.warn('doc: skipped to prevent health check timeout', { err: error.message });
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
            // VETO CHECK (filename): a response document suppresses the whole project for
            // this report type. Done before the download so a known response costs nothing.
            //
            // Only decisive verdicts act here. A filename that merely looks like a
            // deliverable is tentative and needs the content to confirm it, because
            // councils name their own consultee reports the same way.
            const filenameVerdict = fiDetectionService.classifyFIResponseByFilename(
                fileName,
                normalizeReportType(documentType)
            );
            if (filenameVerdict && !filenameVerdict.tentative) {
                await this.recordProjectVeto({
                    projectId: document.projectId,
                    reportType: documentType,
                    jobId: job.jobId,
                    fileName,
                    filePath: document.filePath,
                    ...filenameVerdict
                });
                return {
                    isMatch: false,
                    stage: 'fi-response-veto',
                    confidence: 0,
                    reasoning: filenameVerdict.reason,
                    vetoedProject: true
                };
            }

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
                    Bucket: getBucket(),
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
                        logger.warn('doc: skipped, over size limit', { sizeMB: (sizeBytes / 1048576).toFixed(1), limitMB: maxDocMb });
                        return {
                            isMatch: false,
                            stage: 'file-too-large',
                            confidence: 0,
                            reasoning: `File size ${(sizeBytes / 1024 / 1024).toFixed(1)}MB exceeds ${maxDocMb}MB limit`
                        };
                    }
                } catch (headError) {
                    logger.warn('doc: could not read size', { err: headError.message });
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
                        logger.error('doc: text extraction failed, streaming extractor returned empty text');
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
                            logger.debug('doc: could not delete temp file', { err: unlinkError.message });
                        }
                    }

                    // Null out buffer immediately after extraction
                    fileBuffer = null;

                    if (!extractionResult.success) {
                        logger.error('doc: text extraction failed', { err: extractionResult.error });
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
                    logger.debug('doc: insufficient text extracted', { chars: documentText.length });
                    return {
                        isMatch: false,
                        stage: 'text-extraction',
                        confidence: 0,
                        reasoning: 'Could not extract sufficient text from document'
                    };
                }

                logger.debug('doc: text extracted', { chars: documentText.length });

            } catch (error) {
                logger.error('doc: download/extract failed', { err: error.message, stack: error.stack });
                return {
                    isMatch: false,
                    stage: 'download-error',
                    confidence: 0,
                    error: error.message
                };
            }

            // LAYER 1: Fast structural rejection (no AI cost)
            const filenameLower = fileName.toLowerCase();

            // 1a. VETO CHECK (content): the target report has already been commissioned,
            // submitted or reviewed, so the project is no longer a lead for this type.
            // Runs before the AI layers - a response must never reach the customer, and
            // the AI reads the request text quoted inside it as a request.
            const responseVerdict = await fiDetectionService.classifyFIResponse(
                documentText,
                fileName,
                normalizeReportType(documentType)
            );
            if (responseVerdict.isResponse) {
                await this.recordProjectVeto({
                    projectId: document.projectId,
                    reportType: documentType,
                    jobId: job.jobId,
                    fileName,
                    filePath: document.filePath,
                    ...responseVerdict
                });
                return {
                    isMatch: false,
                    stage: 'fi-response-veto',
                    confidence: 0,
                    reasoning: responseVerdict.reason,
                    vetoedProject: true
                };
            }

            // 1b. Decision notices - the application is past the FI stage. Rejects the
            // document only; it does not veto the project.
            const decisionIndicators = [
                'final grant',
                'decision notification',
                'grant permission'
            ];

            if (decisionIndicators.some(indicator => filenameLower.includes(indicator))) {
                return {
                    isMatch: false,
                    stage: 'filename-reject',
                    confidence: 0,
                    reasoning: 'Filename indicates a decision document, not an FI request'
                };
            }

            // 1c. Document length rejection - reports are typically >100 pages
            // FI request letters are usually 2-5 pages
            const estimatedPages = Math.ceil(documentText.length / 2500); // ~2500 chars per page
            if (estimatedPages > 100) {
                logger.debug('doc: rejected, too long', { estPages: estimatedPages });
                return {
                    isMatch: false,
                    stage: 'length-reject',
                    confidence: 0,
                    reasoning: `Document too long (${estimatedPages} pages) - likely a report, not FI request letter`
                };
            }

            // 1d. Report structure markers - consultant reports have specific formatting
            const reportStructureMarkers = [
                /table of contents/i,
                /executive summary/i,
                /\d+\.\d+\s+(introduction|background|methodology)/i,
                /this report (?:was|has been) prepared by/i,
                /prepared on behalf of/i
            ];

            const hasReportStructure = reportStructureMarkers.some(pattern => pattern.test(documentText));
            if (hasReportStructure) {
                logger.debug('doc: rejected, has report structure markers');
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
            logger.debug('doc: layer 2 pass, sending to full AI', { chars: documentText.length });

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
                const isValidatedMatch = matchResult.matches === true && matchResult.hasValidEvidence === true;

                if (isValidatedMatch) {
                    logger.debug('doc: FI request match', { type: documentType });
                    return {
                        isMatch: true,
                        stage: 'fi-detection',
                        confidence: 0.95,
                        reasoning: `Document is an FI request asking for ${documentType} report`,
                        needsReview: false,
                        validationQuote: matchResult.validationQuote || 'No quote captured',
                        hasValidEvidence: true
                    };
                } else if (matchResult.aiConfirmedMatchButWeakEvidence) {
                    // AI said yes but evidence failed - log but don't emit to customer
                    logger.debug('doc: AI matched but evidence validation failed', { type: documentType });
                    return {
                        isMatch: false,
                        stage: 'weak-evidence',
                        confidence: 0.5,
                        reasoning: `AI detected ${documentType} request but evidence validation failed`,
                        needsReview: true, // Flag for internal review
                        validationQuote: matchResult.validationQuote,
                        hasValidEvidence: false
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
                logger.error('doc: FI detection failed', { err: error.message, stack: error.stack });
                return {
                    isMatch: false,
                    stage: 'detection-error',
                    confidence: 0,
                    error: error.message
                };
            }

        } catch (error) {
            logger.error('doc: processing failed', { err: error.message, stack: error.stack });
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
    async sendMatchEmails(matches, job, prefetchedMetadataMap = null) {
        logger.info('delivery: preparing batch notifications', { matches: matches.length });

        try {
            // Group matches by customer email
            const customerMatchesMap = new Map();

            for (const match of matches) {
                const { document, result, customers } = match;

                for (const customer of customers) {
                    if (!customer.customerId?.email) continue;

                    const email = customer.customerId.email;

                    if (!customerMatchesMap.has(email)) {
                        // Get filters from customer document
                        const customerFilters = customer.customerId.filters || {};
                        const hasFilters = (customerFilters.allowedCounties?.length > 0) || (customerFilters.allowedSectors?.length > 0);

                        // Debug log customer filter setup
                        if (hasFilters) {
                            logger.debug('delivery: customer filters loaded', { to: email, counties: (customerFilters.allowedCounties || []).length, sectors: (customerFilters.allowedSectors || []).length });
                        } else {
                            logger.debug('delivery: customer has no subscription filters', { to: email });
                        }

                        customerMatchesMap.set(email, {
                            customerId: customer.customerId._id.toString(), // Store MongoDB _id for FIReport
                            email: email,
                            name: customer.customerId.name,
                            filters: customerFilters, // Store customer's subscription filters
                            matches: []
                        });
                    }

                    // Add match with document and project info (including validation quote)
                    // DEFENSE-IN-DEPTH: Filter weak/placeholder evidence before customer assembly
                    const validationQuote = result.validationQuote || 'No quote captured';
                    const isPlaceholder = validationQuote.includes('Match confirmed by AI') ||
                                          validationQuote.includes('No specific quote extracted') ||
                                          validationQuote === 'No quote captured';

                    if (!isPlaceholder) {
                        customerMatchesMap.get(email).matches.push({
                            reportType: job.documentType,
                            projectId: document.projectId,
                            documentName: document.fileName,
                            validationQuote: validationQuote,
                            requestingAuthority: 'Planning Authority',
                            deadline: 'See document for details',
                            summary: result.reasoning || `FI request detected for ${job.documentType} report`,
                            specificRequests: result.reasoning || 'See document for specific requirements',
                            projectMetadata: null // Will be populated below
                        });
                    } else {
                        logger.debug('delivery: weak-evidence match skipped', { file: document.fileName, quote: validationQuote.substring(0, 80) });
                    }
                }
            }

            // Use prefetched metadata when provided (delivery path); otherwise fetch here
            let projectMetadataMap = prefetchedMetadataMap;
            if (!projectMetadataMap) {
                // Get unique project IDs to fetch metadata
                const uniqueProjectIds = new Set();
                matches.forEach(match => {
                    if (match.document.projectId) {
                        uniqueProjectIds.add(match.document.projectId);
                    }
                });

                logger.info('delivery: fetching project metadata', { projects: uniqueProjectIds.size });

                // Fetch all project metadata from Building Info API
                projectMetadataMap = new Map();
                for (const projectId of uniqueProjectIds) {
                    try {
                        const metadata = await buildingInfoService.getProjectMetadata(projectId);
                        if (metadata) {
                            projectMetadataMap.set(projectId, metadata);
                        }
                    } catch (error) {
                        logger.warn('delivery: project metadata fetch failed', { proj: projectId, err: error.message });
                    }
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

            // Defensive guard: never email matches whose metadata is unavailable
            // (delivery path holds these back for retry via PendingMetadataMatch)
            for (const customerData of customerMatchesMap.values()) {
                customerData.matches = customerData.matches.filter(match => {
                    if (match.projectMetadata?.metadataUnavailable) {
                        logger.warn('delivery: project excluded, metadata unavailable', { proj: match.projectId, to: customerData.email });
                        return false;
                    }
                    return true;
                });
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
                    logger.debug('delivery: applying subscription filters', { to: customerData.email, counties: allowedCounties.length, sectors: allowedSectors.length });
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
                        logger.warn('delivery: project excluded, no metadata to check against filters', { proj: match.projectId });
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
                        logger.debug('delivery: project excluded by filters', { proj: match.projectId, county: projectCounty, sector: projectSector, to: customerData.email, countyOK, sectorOK });
                    }

                    return countyOK && sectorOK;
                });

                if (originalCount !== customerData.matches.length) {
                    logger.debug('delivery: matches after filters', { to: customerData.email, kept: customerData.matches.length, of: originalCount });
                }
            }

            // Send batch emails to each customer (only if they have eligible matches)
            let emailsSent = 0;
            let customersSkipped = 0;
            for (const customerData of customerMatchesMap.values()) {
                // Skip if no matches remain after filtering
                if (customerData.matches.length === 0) {
                    logger.debug('delivery: customer skipped, no matches after filters', { to: customerData.email });
                    customersSkipped++;
                    continue;
                }

                const startTime = Date.now();
                let emailStatus = 'FAILED';
                let emailError = null;

                try {
                    const sendResult = await emailService.sendBatchFINotification(
                        customerData.email,
                        customerData.name,
                        {
                            matches: customerData.matches,
                            reportTypes: [job.documentType],
                            jobId: job.jobId,
                            generatedAt: new Date()
                        }
                    );

                    // sendBatchFINotification returns {skipped:true} when every match was
                    // filtered out at send time. That used to be counted as a send and
                    // written to FIReport as SENT, so a report nobody received looked
                    // delivered in the UI and in the stats.
                    if (sendResult?.skipped) {
                        emailStatus = 'SKIPPED';
                        logger.warn(
                            `⏭️ No email sent to ${customerData.email} - ${sendResult.reason || 'all matches filtered at send time'} ` +
                            `(${customerData.matches.length} match(es) discarded)`
                        );
                    } else {
                        emailsSent++;
                        emailStatus = 'SENT';
                        logger.info('delivery: email sent', { to: customerData.email, matches: customerData.matches.length });
                    }

                    // Update Customer record with email statistics - only when an email
                    // actually went out.
                    try {
                        const customerRecord = emailStatus === 'SENT'
                            ? await Customer.findById(customerData.customerId)
                            : null;
                        if (customerRecord) {
                            await customerRecord.recordEmailSent();
                            logger.debug('delivery: customer email stats updated', { to: customerData.email });
                        }
                    } catch (customerUpdateError) {
                        logger.warn('delivery: customer email stats update failed', { to: customerData.email, err: customerUpdateError.message });
                    }

                } catch (error) {
                    emailError = error.message;
                    logger.error('delivery: email FAILED', { to: customerData.email, err: error.message, stack: error.stack });
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

                    logger.debug('delivery: FIReport created', { to: customerData.email, matches: customerData.matches.length, status: emailStatus });

                } catch (reportError) {
                    logger.error('delivery: FIReport creation FAILED', { to: customerData.email, err: reportError.message, stack: reportError.stack });
                }
            }

            // Update job statistics
            job.statistics.totalEmailsSent = (job.statistics.totalEmailsSent || 0) + emailsSent;
            await job.save();

            logger.info('delivery summary', { emailsSent, matches: matches.length, customersSkippedByFilters: customersSkipped });

        } catch (error) {
            logger.error('delivery: batch email send FAILED', error);
        }
    }

    /**
     * Recover jobs that have fallen out of the pipeline, and alert when they cannot be.
     *
     * scanJobWorker sets PAUSED on failure and rethrows so Bull retries three times. But
     * processActiveJobs only queries { status: { $in: ['ACTIVE','RUNNING'] } }, so once
     * those attempts are exhausted nothing ever looks at the job again: no dead-letter
     * consumer, no alert, and the job silently stops producing leads for its customers.
     * scripts/check-stuck-jobs.js and clear-stuck-jobs.js exist because this happens.
     */
    async sweepStuckJobs() {
        return runContext.runWith({ runId: runContext.newRunId('SWEEP') }, async () => {
            const outcome = await withLock(
                'scan-stuck-job-sweep',
                { ttlMs: 5 * 60 * 1000, skipMessage: false },
                () => this.recoverStuckJobs()
            );
            return outcome.ran ? outcome.result : undefined;
        });
    }

    async recoverStuckJobs() {
        const maxAutoRecovery = parseInt(process.env.SCAN_MAX_AUTO_RECOVERY || '3', 10);
        // Bull retries with exponential backoff from 5s over three attempts. Waiting out
        // a grace period keeps the sweeper from racing those retries and double-queueing.
        const graceMs = parseInt(process.env.SCAN_PAUSED_GRACE_MINUTES || '30', 10) * 60 * 1000;
        const runningStaleMs = parseInt(process.env.SCAN_RUNNING_STALE_MINUTES || '60', 10) * 60 * 1000;
        const now = Date.now();

        const summary = { resumed: 0, needsAttention: 0, runningReset: 0, drained: 0 };

        try {
            const stuckJobs = await ScanJob.find({
                $or: [
                    // PAUSED is the schema default, so it also means "created but never
                    // started". Only a job the worker actually failed carries a non-zero
                    // consecutiveFailures - without this the sweeper would launch jobs an
                    // admin had never enabled and email their customers unbidden.
                    // (The memory circuit breaker throws into that same catch, so it is
                    // covered too.)
                    { status: 'PAUSED', 'recovery.consecutiveFailures': { $gte: 1 } },
                    { status: 'RUNNING' }
                ]
            }).select('jobId name status checkpoint recovery');

            for (const job of stuckJobs) {
                try {
                    if (job.status === 'PAUSED') {
                        await this.recoverPausedJob(job, { now, graceMs, maxAutoRecovery, summary });
                    } else {
                        await this.recoverStalledRunningJob(job, { now, runningStaleMs, summary });
                    }
                } catch (error) {
                    logger.error('sweep: stuck job recovery failed', { job: job.jobId, err: error.message, stack: error.stack });
                }
            }

            summary.drained = await this.drainFailedQueueJobs();

            if (summary.resumed || summary.needsAttention || summary.runningReset || summary.drained) {
                logger.info(
                    `🩺 Stuck-job sweep: ${summary.resumed} resumed, ${summary.runningReset} stalled RUNNING reset, ` +
                    `${summary.needsAttention} needing attention, ${summary.drained} dead-letter job(s) drained`
                );
            }

            return summary;

        } catch (error) {
            logger.error('sweep: stuck-job sweep FAILED', error);
            return summary;
        }
    }

    /**
     * A PAUSED job: resume it, or give up and alert once.
     */
    async recoverPausedJob(job, { now, graceMs, maxAutoRecovery, summary }) {
        const recovery = job.recovery || {};
        const pausedAt = recovery.pausedAt ? new Date(recovery.pausedAt).getTime() : null;

        // The worker always stamps pausedAt alongside the failure count, so anything
        // reaching here has one. A job predating this field falls back to its checkpoint
        // heartbeat; if it has neither it cannot be dated, and guessing would risk
        // resuming something that was paused deliberately - leave it for
        // scripts/check-stuck-jobs.js.
        const referenceTime = pausedAt || (job.checkpoint?.lastCheckpointTime
            ? new Date(job.checkpoint.lastCheckpointTime).getTime()
            : null);

        if (!referenceTime) {
            logger.warn(
                `⚠️ Job ${job.jobId} is PAUSED with ${recovery.consecutiveFailures || 0} failure(s) but no ` +
                `pausedAt or checkpoint time - cannot date it, leaving for manual review`
            );
            return;
        }

        if (now - referenceTime < graceMs) {
            return;   // still inside Bull's own retry window
        }

        const failures = recovery.consecutiveFailures || 0;

        if (failures >= maxAutoRecovery) {
            if (!recovery.needsAttention) {
                job.recovery = { ...recovery, needsAttention: true };
                await job.save();
            }
            summary.needsAttention++;

            await this.sendJobAlert(job, {
                severity: 'critical',
                subject: `Scan job ${job.jobId} needs attention`,
                headline:
                    `This job has failed ${failures} consecutive times and automatic recovery has stopped. ` +
                    `It is not scanning, and its customers are receiving no leads.`,
                details: {
                    'Consecutive failures': failures,
                    'Last failure': recovery.lastFailureAt ? new Date(recovery.lastFailureAt).toISOString() : 'unknown',
                    'Last error': recovery.lastFailureReason || 'unknown',
                    'Progress at pause': `${job.checkpoint?.processedCount || 0} / ${job.checkpoint?.totalDocuments || 0} documents`
                },
                action:
                    `Investigate the error above, then clear recovery.consecutiveFailures and set the job ` +
                    `status back to ACTIVE to re-enable automatic recovery.`
            });
            return;
        }

        logger.warn(
            `🔄 Job ${job.jobId} has been PAUSED for ${((now - referenceTime) / 60000).toFixed(0)} min ` +
            `(${failures} consecutive failure(s)) - resuming`
        );

        job.status = 'ACTIVE';
        job.checkpoint = job.checkpoint || {};
        job.checkpoint.isResuming = true;
        await job.save();

        await scanJobQueue.enqueueScanJob(job.jobId, { targetDate: null });
        summary.resumed++;

        await this.sendJobAlert(job, {
            severity: 'warning',
            subject: `Scan job ${job.jobId} auto-resumed after failure`,
            headline: `The job failed and was re-queued automatically (attempt ${failures + 1} of ${maxAutoRecovery}).`,
            details: {
                'Consecutive failures': failures,
                'Last error': recovery.lastFailureReason || 'unknown',
                'Progress at pause': `${job.checkpoint?.processedCount || 0} / ${job.checkpoint?.totalDocuments || 0} documents`
            },
            action: 'No action needed unless this repeats. Automatic recovery stops after ' + maxAutoRecovery + ' failures.'
        });
    }

    /**
     * A RUNNING job whose heartbeat stopped: the worker was killed (OOM, SIGKILL) without
     * ever reaching the catch that would have set PAUSED, so nothing marks it recoverable.
     */
    async recoverStalledRunningJob(job, { now, runningStaleMs, summary }) {
        const lastBeat = job.checkpoint?.lastCheckpointTime
            ? new Date(job.checkpoint.lastCheckpointTime).getTime()
            : null;

        if (!lastBeat || now - lastBeat < runningStaleMs) {
            return;   // genuinely running, or too soon to tell
        }

        // Confirm no live queue job before touching it - a slow-but-alive scan that simply
        // has not checkpointed recently must not be duplicated.
        try {
            const queue = scanJobQueue.getScanQueue();
            const existing = await queue.getJob(scanJobQueue.buildJobKey(job.jobId, null));
            if (existing) {
                const state = await existing.getState();
                if (state === 'active') return;
            }
        } catch (error) {
            // Redis unreachable: leave the job alone rather than guess.
            logger.warn('sweep: could not check queue state', { job: job.jobId, err: error.message });
            return;
        }

        logger.warn(
            `🔄 Job ${job.jobId} is RUNNING but has not checkpointed for ` +
            `${((now - lastBeat) / 60000).toFixed(0)} min and has no active queue job - resetting to ACTIVE`
        );

        job.status = 'ACTIVE';
        job.checkpoint.isResuming = true;
        job.recovery = job.recovery || {};
        job.recovery.pausedAt = new Date();
        await job.save();

        await scanJobQueue.enqueueScanJob(job.jobId, { targetDate: null });
        summary.runningReset++;
    }

    /**
     * Drain Bull's failed set.
     *
     * removeOnFail: 100 keeps the last hundred failures in Redis with nothing consuming
     * them. Left there, the fixed job key stays occupied and blocks every future enqueue
     * for that job.
     */
    async drainFailedQueueJobs() {
        let drained = 0;

        try {
            const queue = scanJobQueue.getScanQueue();
            const failed = await queue.getFailed(0, 50);

            for (const queueJob of failed) {
                try {
                    const jobId = queueJob.data?.jobId;
                    const reason = queueJob.failedReason || 'unknown';

                    if (jobId) {
                        await ScanJob.updateOne(
                            { jobId },
                            {
                                $set: {
                                    'recovery.lastFailureAt': new Date(queueJob.finishedOn || Date.now()),
                                    'recovery.lastFailureReason': String(reason).slice(0, 500)
                                }
                            }
                        );
                    }

                    logger.warn('sweep: draining dead-letter queue job', { bullId: queueJob.id, reason });
                    await queueJob.remove();
                    drained++;
                } catch (error) {
                    logger.warn('sweep: could not drain failed queue job', { bullId: queueJob.id, err: error.message });
                }
            }
        } catch (error) {
            // Redis may be down; the sweep's other work is still worth doing.
            logger.warn('sweep: could not drain the failed queue', { err: error.message });
        }

        return drained;
    }

    /**
     * Send an operational alert about a job, rate-limited per job.
     *
     * Without the cooldown a permanently broken job would email every 15 minutes.
     */
    async sendJobAlert(job, alert) {
        const cooldownHours = parseFloat(process.env.ALERT_COOLDOWN_HOURS || '6');
        const alertedAt = job.recovery?.alertedAt ? new Date(job.recovery.alertedAt).getTime() : 0;

        if (alertedAt && Date.now() - alertedAt < cooldownHours * 3600000) {
            return { success: false, reason: 'cooldown' };
        }

        const recipient = process.env.ALERT_EMAIL || process.env.ADMIN_EMAIL || 'afatogun@buildinginfo.com';

        const result = await emailService.sendJobAlertEmail(recipient, {
            ...alert,
            jobId: job.jobId,
            jobName: job.name
        });

        // Stamp regardless of send outcome: a failing transporter must not turn the
        // cooldown off and let every subsequent sweep retry a send that cannot work.
        await ScanJob.updateOne({ jobId: job.jobId }, { $set: { 'recovery.alertedAt': new Date() } });

        return result;
    }

    /**
     * Stop the processor
     */
    stop() {
        if (this.scheduledJob) {
            this.scheduledJob.cancel();
        }
        if (this.deliverySweepJob) {
            this.deliverySweepJob.cancel();
        }
        if (this.stuckJobSweepJob) {
            this.stuckJobSweepJob.cancel();
        }
        logger.info('scan job processor stopped');
    }

    /**
     * Check if a job should run today.
     * Recurring jobs scan daily; delivery frequency is handled by isDeliveryDay().
     */
    shouldJobRun(job, today) {
        const lastScanDate = job.statistics.lastScanDate
            ? new Date(job.statistics.lastScanDate)
            : null;

        if (!lastScanDate) {
            // Never run before, should run now
            return true;
        }

        const lastScanDateStr = lastScanDate.toISOString().split('T')[0];

        // Scan once per day for all recurring schedule types.
        return lastScanDateStr !== today;
    }

    /**
     * Get processor status
     */
    /**
     * Check if today is a delivery day for the given job.
     * schedule.type now refers to delivery frequency only — all jobs scan daily.
     */
    isDeliveryDay(job, today) {
        const scheduleType = job.schedule?.type || 'DAILY';
        const date = new Date(today);

        switch (scheduleType) {
            case 'DAILY':
            case 'CUSTOM':
                return true;

            case 'WEEKLY': {
                // daysOfWeek[0] is the persisted value; dayOfWeek is accepted as a fallback from UI payloads.
                const deliveryDow = job.schedule?.daysOfWeek?.[0] ?? job.schedule?.dayOfWeek ?? 1;
                return date.getDay() === deliveryDow;
            }

            case 'MONTHLY': {
                // dayOfMonth = day of month for delivery (1-31). Default: 1st
                const deliveryDom = job.schedule?.dayOfMonth ?? 1;
                return date.getDate() === deliveryDom;
            }

            default:
                return true;
        }
    }

    /**
     * Return the most recent configured delivery date (YYYY-MM-DD) on or before `today`.
     * Used to detect a missed delivery when a long-running scan finishes after its
     * delivery day. Date handling mirrors isDeliveryDay() for consistency.
     */
    getMostRecentDeliveryDateStr(job, today) {
        const scheduleType = job.schedule?.type || 'DAILY';
        const date = new Date(today);
        date.setHours(0, 0, 0, 0);

        switch (scheduleType) {
            case 'DAILY':
            case 'CUSTOM':
                return date.toISOString().split('T')[0];

            case 'WEEKLY': {
                const deliveryDow = job.schedule?.daysOfWeek?.[0] ?? job.schedule?.dayOfWeek ?? 1;
                const diff = (date.getDay() - deliveryDow + 7) % 7;
                date.setDate(date.getDate() - diff);
                return date.toISOString().split('T')[0];
            }

            case 'MONTHLY': {
                const deliveryDom = job.schedule?.dayOfMonth ?? 1;
                if (date.getDate() >= deliveryDom) {
                    date.setDate(deliveryDom);
                } else {
                    date.setMonth(date.getMonth() - 1, deliveryDom);
                }
                return date.toISOString().split('T')[0];
            }

            default:
                return date.toISOString().split('T')[0];
        }
    }

    /**
     * Parse configured delivery time from schedule.timeOfDay (HH:mm).
     * Falls back to 09:00 for invalid/missing values.
     */
    getDeliveryTimeParts(job) {
        const timeOfDay = job.schedule?.timeOfDay || '09:00';
        const match = /^(\d{1,2}):(\d{2})$/.exec(timeOfDay);

        if (!match) {
            return { hour: 9, minute: 0, timeLabel: '09:00' };
        }

        const hour = parseInt(match[1], 10);
        const minute = parseInt(match[2], 10);

        if (Number.isNaN(hour) || Number.isNaN(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
            return { hour: 9, minute: 0, timeLabel: '09:00' };
        }

        return {
            hour,
            minute,
            timeLabel: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
        };
    }

    /**
     * Check if current server-local time has reached configured delivery time.
     */
    hasReachedDeliveryTime(job, now = new Date()) {
        const { hour, minute } = this.getDeliveryTimeParts(job);
        const currentMinutes = now.getHours() * 60 + now.getMinutes();
        const deliveryMinutes = hour * 60 + minute;
        return currentMinutes >= deliveryMinutes;
    }

    /**
     * Apply delivery-time gating only to schedules that have a selected delivery day.
     */
    shouldApplyDeliveryTimeGate(job) {
        const scheduleType = job.schedule?.type || 'DAILY';
        return scheduleType === 'WEEKLY' || scheduleType === 'MONTHLY';
    }

    /**
     * Refresh the in-memory job.customers list from the database.
     * The worker holds a snapshot of customers loaded when the run started, so a
     * customer removed from the job mid-run would otherwise still be emailed on the
     * completion (immediate) delivery path. Re-reading here keeps recipients current.
     */
    async refreshJobCustomers(job) {
        try {
            const fresh = await ScanJob.findOne({ jobId: job.jobId })
                .populate('customers.customerId', 'email company name projectId filters')
                .select('customers');
            if (fresh) {
                job.customers = fresh.customers;
                logger.debug('delivery: recipient list refreshed', { customers: job.customers.length });
            }
        } catch (error) {
            logger.warn('delivery: could not refresh customers, using snapshot from run start', { job: job.jobId, err: error.message });
        }
    }

    /**
     * Mark a job as pending deferred delivery for a specific delivery day.
     */
    markDeliveryPending(job, deliveryDateStr, anchorDateStr) {
        if (!job.deliveryState) {
            job.deliveryState = {};
        }
        job.deliveryState.pendingForDate = deliveryDateStr;
        job.deliveryState.pendingAnchorDate = anchorDateStr;
        job.deliveryState.readyAt = new Date();
        job.deliveryState.lastAttemptAt = new Date();
    }

    /**
     * Mark a delivery as sent and clear pending flags.
     */
    markDeliverySent(job, deliveryDateStr) {
        if (!job.deliveryState) {
            job.deliveryState = {};
        }
        job.deliveryState.pendingForDate = null;
        job.deliveryState.pendingAnchorDate = null;
        job.deliveryState.sentForDate = deliveryDateStr;
        job.deliveryState.sentAt = new Date();
        job.deliveryState.lastAttemptAt = new Date();
    }

    /**
     * Process deferred deliveries once configured delivery time has been reached.
     */
    async processPendingDeliveries() {
        // Fires every minute. Locked so a second process can never send the same
        // customer their leads twice; silent on skip to keep the log readable.
        return runContext.runWith({ runId: runContext.newRunId('DELIVER') }, async () => {
            const outcome = await withLock(
                'scan-delivery-sweep',
                { ttlMs: 5 * 60 * 1000, skipMessage: false },
                () => this.deliverPendingJobs()
            );

            return outcome.ran ? outcome.result : undefined;
        });
    }

    async deliverPendingJobs() {
        try {
            const now = new Date();
            const today = now.toISOString().split('T')[0];

            const pendingJobs = await ScanJob.find({
                status: { $in: ['ACTIVE', 'RUNNING'] },
                'deliveryState.pendingForDate': today
            }).populate('customers.customerId', 'email company name filters');

            if (!pendingJobs.length) {
                return;
            }

            for (const job of pendingJobs) {
                try {
                    // If delivery was already sent for today, clear stale pending state and skip.
                    if (job.deliveryState?.sentForDate === today) {
                        this.markDeliverySent(job, today);
                        await job.save();
                        continue;
                    }

                    // Don't send while the scan is still running; completion path will send if past time.
                    if (job.status === 'RUNNING') {
                        continue;
                    }

                    if (!this.hasReachedDeliveryTime(job, now)) {
                        continue;
                    }

                    const anchorDateStr = job.deliveryState?.pendingAnchorDate || today;
                    const anchorDate = new Date(anchorDateStr);
                    anchorDate.setHours(0, 0, 0, 0);

                    logger.info('delivery: pending trigger fired at configured time', { job: job.jobId, at: job.schedule?.timeOfDay || '09:00' });
                    await this.deliverResultsForJob(job, anchorDate);
                    this.markDeliverySent(job, today);
                    await job.save();
                } catch (error) {
                    logger.error('delivery: pending delivery FAILED', { job: job.jobId, err: error.message, stack: error.stack });
                    if (!job.deliveryState) {
                        job.deliveryState = {};
                    }
                    job.deliveryState.lastAttemptAt = new Date();
                    await job.save();
                }
            }
        } catch (error) {
            logger.error('delivery: pending delivery sweep FAILED', error);
        }
    }

    /**
     * Persist a single day's scan results to MongoDB (crash-safe, one record per job per day).
     */
    async saveDailyScanResult(job, { scanDate, scanStartDate, scanEndDate, matches, processedCount, eligibleCount, skippedBaseline, baselinedProjects }) {
        try {
            const scanDateNormalized = new Date(scanDate);
            scanDateNormalized.setHours(0, 0, 0, 0);

            // Merge rather than replace.
            //
            // This upsert used to overwrite `matches` wholesale, so any re-run for a day
            // already scanned - a restart triggers one - replaced a complete result with
            // whatever the new pass happened to find, and reset `delivered`. Union the
            // two sets on projectId::fileName so a partial re-run can only ever add.
            const existing = await ScanJobDailyResult.findOne({
                jobId: job.jobId,
                scanDate: scanDateNormalized
            }).lean();

            const mergedMatches = [];
            const seen = new Set();
            for (const match of [...(existing?.matches || []), ...matches]) {
                const key = `${match.projectId}::${match.fileName}`;
                if (seen.has(key)) continue;
                seen.add(key);
                mergedMatches.push(match);
            }

            const addedCount = mergedMatches.length - (existing?.matches?.length || 0);

            await ScanJobDailyResult.findOneAndUpdate(
                { jobId: job.jobId, scanDate: scanDateNormalized },
                {
                    $set: {
                        jobId: job.jobId,
                        scanDate: scanDateNormalized,
                        scanStartDate,
                        scanEndDate,
                        matches: mergedMatches,
                        // Counts reflect the most complete pass, not the latest one.
                        processedCount: Math.max(processedCount || 0, existing?.processedCount || 0),
                        eligibleCount: Math.max(eligibleCount || 0, existing?.eligibleCount || 0),
                        skippedBaseline: Math.max(skippedBaseline || 0, existing?.skippedBaseline || 0),
                        baselinedProjects: Math.max(baselinedProjects || 0, existing?.baselinedProjects || 0),
                        // Never un-deliver a day that has already gone out.
                        delivered: existing?.delivered || false
                    },
                    // Counts passes, not documents. Gap detection uses it to stop
                    // re-scanning a day that is genuinely empty rather than missed.
                    $inc: { scanAttempts: 1 }
                },
                { upsert: true, new: true, setDefaultsOnInsert: true }
            );

            if (existing) {
                logger.info(
                    `💾 Daily result merged for job ${job.jobId} on ${scanDateNormalized.toISOString().split('T')[0]}: ` +
                    `${existing.matches?.length || 0} existing + ${matches.length} from this pass = ${mergedMatches.length} (${addedCount} new)`
                );
            } else {
                logger.info('scan: daily result saved', { date: scanDateNormalized.toISOString().split('T')[0], matches: mergedMatches.length });
            }
        } catch (error) {
            logger.error('scan: saving daily result FAILED', { job: job.jobId, err: error.message, stack: error.stack });
            throw error;
        }
    }

    /**
     * Days inside the horizon that this job has no usable result for, oldest first.
     *
     * A day counts as a gap when:
     *   - there is no row at all (the scan never ran - an overrun scan means the next
     *     day is never enqueued, and nothing ever goes back for it); or
     *   - the row has processedCount 0 and fewer than MAX_EMPTY_ATTEMPTS attempts. A
     *     resume that never re-finds its checkpoint marker skips every document and
     *     then writes a 0-match result that is indistinguishable from a quiet day.
     *
     * After MAX_EMPTY_ATTEMPTS the day is accepted as genuinely empty, so a bank
     * holiday is not re-scanned every night forever.
     *
     * @returns {Promise<string[]>} YYYY-MM-DD, oldest first
     */
    /**
     * YYYY-MM-DD from a Date's LOCAL parts.
     *
     * scanDate is normalised with setHours(0,0,0,0), which is local midnight, so a day
     * key must be read back the same way. Using toISOString() here would shift the key
     * by a day on any host that is not UTC - which is every developer machine west or
     * east of Greenwich, and any deployment whose TZ is set.
     */
    toLocalDateKey(date) {
        const d = new Date(date);
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${d.getFullYear()}-${month}-${day}`;
    }

    async findCoverageGaps(job, { horizonDays, endDate } = {}) {
        const MAX_EMPTY_ATTEMPTS = 2;

        // How far back to look for gaps. Deliberately NOT job.schedule.lookbackDays:
        // that governs delivery and is 1 for essentially every job, which would limit
        // gap detection to yesterday - the one day the nightly run has just enqueued -
        // and the feature would never find anything.
        //
        // It is the same horizon buildDeliveryWindowFilter uses for its backfillFloor,
        // so a day that can be found can also be delivered. Capped because every extra
        // day is a full bucket walk (~570k objects).
        const cap = parseInt(process.env.SCAN_BACKFILL_HORIZON_DAYS || '14', 10);
        const horizon = Math.max(1, Math.min(horizonDays || cap, cap));

        // Yesterday is the newest day a scan can cover; today is still accumulating.
        const windowEnd = endDate ? new Date(endDate) : new Date();
        if (!endDate) windowEnd.setDate(windowEnd.getDate() - 1);
        windowEnd.setHours(0, 0, 0, 0);

        const windowStart = new Date(windowEnd);
        windowStart.setDate(windowStart.getDate() - horizon + 1);
        windowStart.setHours(0, 0, 0, 0);

        const rows = await ScanJobDailyResult.find({
            jobId: job.jobId,
            scanDate: { $gte: windowStart, $lte: windowEnd }
        }).select('scanDate processedCount eligibleCount scanAttempts').lean();

        const byDate = new Map();
        for (const row of rows) {
            byDate.set(this.toLocalDateKey(row.scanDate), row);
        }

        const gaps = [];
        for (let day = new Date(windowStart); day <= windowEnd; day.setDate(day.getDate() + 1)) {
            const key = this.toLocalDateKey(day);
            const row = byDate.get(key);

            if (!row) {
                gaps.push(key);
            } else if ((row.processedCount || 0) === 0 && (row.scanAttempts || 0) < MAX_EMPTY_ATTEMPTS) {
                gaps.push(key);
            }
        }

        return gaps;   // ascending, because the loop walks forward from windowStart
    }

    /**
     * Queue a bounded number of missed days for this job.
     *
     * fastS3Scanner.streamDocumentsSince lists the whole planning-docs prefix and filters
     * on LastModified client-side, so every backfill day costs a full bucket walk
     * (~570k objects) regardless of how little it finds. One day per night by default;
     * the oldest gap goes first so nothing starves.
     */
    async enqueueBackfill(job, { maxDays } = {}) {
        if (process.env.SCAN_BACKFILL_ENABLED !== 'true') {
            return { enqueued: [], skipped: 'disabled' };
        }

        const limit = maxDays || parseInt(process.env.SCAN_BACKFILL_MAX_DAYS_PER_NIGHT || '1', 10);

        try {
            const gaps = await this.findCoverageGaps(job);

            if (gaps.length === 0) {
                return { enqueued: [], skipped: 'no-gaps' };
            }

            // Never hand a job a second copy of the day it is already part-way through.
            const inFlight = job.checkpoint?.isResuming && job.checkpoint?.scanStartDate
                ? this.toLocalDateKey(job.checkpoint.scanStartDate)
                : null;

            const candidates = gaps.filter(day => day !== inFlight).slice(0, limit);

            for (const targetDate of candidates) {
                logger.info('backfill: enqueuing missed day', { job: job.jobId, date: targetDate, gapsOutstanding: gaps.length });
                await scanJobQueue.enqueueScanJob(job.jobId, { targetDate });
            }

            if (gaps.length > candidates.length) {
                logger.info(
                    `🕳️ ${gaps.length - candidates.length} further gap(s) remain for job ${job.jobId}; ` +
                    `capped at ${limit} per night (SCAN_BACKFILL_MAX_DAYS_PER_NIGHT)`
                );
            }

            return { enqueued: candidates, outstanding: gaps.length };

        } catch (error) {
            // Backfill is best-effort - it must never take down the nightly run.
            logger.error('backfill: check FAILED', { job: job.jobId, err: error.message, stack: error.stack });
            return { enqueued: [], skipped: 'error' };
        }
    }

    /**
     * The set of daily results a delivery should cover.
     *
     * Expressed once because three call sites need it and must not drift: the read, and
     * the two updateMany calls that mark results delivered. A backfilled day falls
     * outside the normal lookback window, so without the second clause it would be
     * scanned and then never sent to anyone.
     */
    buildDeliveryWindowFilter(job, deliveryAnchorDate) {
        const lookbackDays = job.schedule?.lookbackDays || 1;

        const windowEnd = new Date(deliveryAnchorDate);
        windowEnd.setHours(23, 59, 59, 999);

        const windowStart = new Date(deliveryAnchorDate);
        windowStart.setDate(windowStart.getDate() - lookbackDays + 1);
        windowStart.setHours(0, 0, 0, 0);

        // How far back a late-arriving backfill result may still be delivered.
        const horizonDays = parseInt(process.env.SCAN_BACKFILL_HORIZON_DAYS || '14', 10);
        const backfillFloor = new Date(windowEnd);
        backfillFloor.setDate(backfillFloor.getDate() - horizonDays);
        backfillFloor.setHours(0, 0, 0, 0);

        return {
            filter: {
                jobId: job.jobId,
                $or: [
                    { scanDate: { $gte: windowStart, $lte: windowEnd } },
                    // Older days only if they never went out, so a re-delivery cannot
                    // resend weeks of leads a customer has already had.
                    { scanDate: { $gte: backfillFloor, $lt: windowStart }, delivered: false }
                ]
            },
            windowStart,
            windowEnd,
            backfillFloor
        };
    }

    /**
     * Collapse matches to one per project and report type, choosing the strongest.
     *
     * Councils routinely republish the same FI text across several documents - project
     * 408961 produced three, whose quotes differed only by OCR noise ("c ontrol" vs
     * "control"). Previously emailService kept the first by array order while the stored
     * FIReport kept all of them, so the email, the UI and the audit export disagreed
     * about the same project.
     */
    selectBestMatchPerProject(matches, defaultReportType) {
        const best = new Map();

        for (const match of matches) {
            const type = normalizeReportType(match.fiType || defaultReportType);
            const key = `${match.projectId}::${type}`;
            const current = best.get(key);

            if (!current || this.scoreMatchEvidence(match, type) > this.scoreMatchEvidence(current, type)) {
                best.set(key, match);
            }
        }

        const selected = [...best.values()];
        if (selected.length < matches.length) {
            logger.info('delivery: matches collapsed to unique rows', { from: matches.length, to: selected.length });
        }
        return selected;
    }

    /**
     * Rank a match by how good its evidence is. Higher wins.
     *
     * Order of preference: a quote showing an explicit request for the report type, then
     * one merely mentioning it, then stated confidence, then the earliest sighting so a
     * repeat of the same request does not displace the original.
     */
    scoreMatchEvidence(match, reportType) {
        const quote = String(match.validationQuote || '').toLowerCase().replace(/\s+/g, ' ').trim();

        if (!quote || PLACEHOLDER_QUOTES.some(p => quote.includes(p.toLowerCase()))) {
            return 0;
        }

        const mentionsType = getQuoteTerms(reportType).some(term => quote.includes(term));
        const hasRequestVerb = REQUEST_VERBS.some(verb => quote.includes(verb));

        let score = 1;
        if (mentionsType) score += 2;
        if (mentionsType && hasRequestVerb) score += 3;
        score += Math.min(Number(match.confidence) || 0, 1);

        // Prefer a fuller quote, but only as a tie-breaker - cap the contribution well
        // below a single evidence step so length can never outrank real evidence.
        score += Math.min(quote.length / 4000, 0.4);

        // Earliest wins on an exact tie.
        const ts = match.timestamp ? new Date(match.timestamp).getTime() : Number.MAX_SAFE_INTEGER;
        score -= Math.min(ts / 1e15, 0.01);

        return score;
    }

    /**
     * Record that a project must never be delivered for a report type, because one of
     * its documents responds to - rather than requests - that report.
     *
     * Upserted, so the first observation wins and repeat sightings are cheap. Failures
     * are logged but never thrown: a veto that cannot be written must not abort a scan.
     */
    async recordProjectVeto({ projectId, reportType, jobId, fileName, filePath, source, reason, quote }) {
        if (!projectId) return;

        const canonicalType = normalizeReportType(reportType);
        try {
            const result = await ProjectReportVeto.findOneAndUpdate(
                { projectId, reportType: canonicalType },
                {
                    $setOnInsert: {
                        projectId,
                        reportType: canonicalType,
                        source,
                        reason,
                        evidenceFileName: fileName,
                        evidenceFilePath: filePath,
                        evidenceQuote: (quote || '').slice(0, 1000),
                        detectedAt: new Date(),
                        detectedByJobId: jobId
                    }
                },
                { upsert: true, new: false }
            );

            if (!result) {
                logger.debug('veto: project vetoed', { proj: projectId, type: canonicalType, source, reason, file: fileName });
            }
        } catch (error) {
            logger.warn('veto: could not record', { proj: projectId, type: canonicalType, err: error.message });
        }
    }

    /**
     * Load the set of vetoed "projectId::reportType" keys for the given matches.
     */
    async loadVetoKeys(matches) {
        const projectIds = [...new Set(matches.map(m => m.projectId).filter(Boolean))];
        if (projectIds.length === 0) return new Set();

        try {
            const vetoes = await ProjectReportVeto.find({ projectId: { $in: projectIds } }).lean();
            return new Set(vetoes.map(v => `${v.projectId}::${v.reportType}`));
        } catch (error) {
            // Fail open: if the veto store is unreadable we deliver as before rather
            // than silently dropping every match.
            logger.error('veto: could not load vetoes, delivering unfiltered', { err: error.message });
            return new Set();
        }
    }

    /**
     * Scan the rest of each candidate project's documents for a response that was never
     * seen by a daily scan.
     *
     * Needed because a scan only ever looks at one day of documents, while the response
     * typically arrives well after the request - 28 days later for project 384778. Only
     * the filename layer is used here: it needs no download, so the sweep stays cheap
     * even for projects with hundreds of documents.
     */
    async sweepProjectsForResponses(projectIds, reportType) {
        const canonicalType = normalizeReportType(reportType);
        let vetoed = 0;

        // Skip projects already vetoed - the verdict is permanent, so re-listing their
        // S3 prefix every delivery run would be pure waste.
        let alreadyVetoed = new Set();
        try {
            const existing = await ProjectReportVeto
                .find({ projectId: { $in: projectIds }, reportType: canonicalType })
                .select('projectId')
                .lean();
            alreadyVetoed = new Set(existing.map(v => v.projectId));
        } catch (error) {
            logger.warn('veto: could not read existing vetoes before sweep', { err: error.message });
        }

        for (const projectId of projectIds) {
            if (alreadyVetoed.has(projectId)) continue;

            try {
                const docs = await s3Service.listPlanningDocsProject(projectId);
                for (const doc of docs) {
                    const verdict = fiDetectionService.classifyFIResponseByFilename(doc.fileName, canonicalType);
                    if (verdict) {
                        await this.recordProjectVeto({
                            projectId,
                            reportType: canonicalType,
                            fileName: doc.fileName,
                            filePath: doc.key,
                            ...verdict
                        });
                        vetoed++;
                        break;
                    }
                }
            } catch (error) {
                logger.warn('veto: response sweep failed', { proj: projectId, err: error.message });
            }
        }

        if (vetoed > 0) {
            logger.info('veto: response sweep complete', { vetoed, type: canonicalType });
        }
    }

    /**
     * Fetch BuildingInfo metadata once per unique project and partition raw stored
     * matches into deliverable (real metadata) vs held (metadata not yet available).
     */
    async partitionMatchesByMetadata(rawMatches) {
        const uniqueProjectIds = new Set();
        for (const m of rawMatches) {
            if (m.projectId) uniqueProjectIds.add(m.projectId);
        }

        logger.debug('delivery: fetching project metadata', { projects: uniqueProjectIds.size });

        const metadataMap = new Map();
        for (const projectId of uniqueProjectIds) {
            try {
                const metadata = await buildingInfoService.getProjectMetadata(projectId);
                if (metadata) {
                    metadataMap.set(projectId, metadata);
                }
            } catch (error) {
                logger.warn('delivery: project metadata fetch failed', { proj: projectId, err: error.message });
            }
        }

        const deliverable = [];
        const held = [];
        for (const m of rawMatches) {
            if (!m.projectId) {
                // Retry can never succeed without a projectId — keep current behavior
                logger.warn('delivery: match has no projectId, delivering without metadata', { file: m.fileName });
                deliverable.push(m);
                continue;
            }
            const md = metadataMap.get(m.projectId);
            if (md && !md.metadataUnavailable) {
                deliverable.push(m);
            } else {
                held.push(m);
            }
        }

        return { deliverable, held, metadataMap };
    }

    /**
     * Aggregate stored daily results across the lookback window and deliver to customers.
     * Deduplicates matches by projectId+fileName to prevent double-counting.
     * Matches whose project metadata is unavailable in BuildingInfo are held back
     * and retried on subsequent delivery runs (up to MAX_METADATA_RETRIES).
     */
    async deliverResultsForJob(job, deliveryAnchorDate) {
        try {
            // One definition, used by the read below and by both updateMany calls that
            // mark results delivered - they must not drift, or a backfilled day would be
            // sent and then never marked, or marked and never sent.
            const deliveryWindow = this.buildDeliveryWindowFilter(job, deliveryAnchorDate);
            const { windowStart, windowEnd } = deliveryWindow;

            const windowEndStr = windowEnd.toISOString().split('T')[0];

            const dailyResults = await ScanJobDailyResult.find(deliveryWindow.filter);

            const pendingDocs = await PendingMetadataMatch.find({
                jobId: job.jobId,
                status: 'PENDING'
            });

            if (dailyResults.length === 0 && pendingDocs.length === 0) {
                logger.info('delivery: no stored results in window', { job: job.jobId, from: windowStart.toISOString().split('T')[0], to: windowEnd.toISOString().split('T')[0] });
                return;
            }

            // Flatten and deduplicate by projectId+fileName
            const seen = new Set();
            const allMatches = [];
            for (const daily of dailyResults) {
                for (const m of (daily.matches || [])) {
                    const key = `${m.projectId}::${m.fileName}`;
                    if (!seen.has(key)) {
                        seen.add(key);
                        allMatches.push(m);
                    }
                }
            }

            // Merge pending metadata retries from previous runs (daily copy wins dedup)
            const pendingByKey = new Map();
            for (const p of pendingDocs) {
                const key = `${p.projectId}::${p.fileName}`;
                pendingByKey.set(key, p);
                if (!seen.has(key)) {
                    seen.add(key);
                    allMatches.push({
                        projectId: p.projectId,
                        fileName: p.fileName,
                        filePath: p.filePath,
                        fiType: p.fiType,
                        validationQuote: p.validationQuote,
                        confidence: p.confidence,
                        timestamp: p.timestamp
                    });
                }
            }

            if (pendingDocs.length > 0) {
                logger.info('delivery: retrying pending matches with previously unavailable metadata', { job: job.jobId, matches: pendingDocs.length });
            }

            // PROJECT VETO - the authoritative gate.
            //
            // A response for this report type suppresses the entire project: the report
            // has already been commissioned or produced, so the lead is dead. Enforced
            // here rather than only at scan time because a veto recorded on any earlier
            // day must still suppress a request found today.
            //
            // The sweep first looks for response documents that no daily scan ever saw,
            // since a scan only covers a single day's uploads.
            const candidateProjectIds = [...new Set(allMatches.map(m => m.projectId).filter(Boolean))];
            await this.sweepProjectsForResponses(candidateProjectIds, job.documentType);

            const vetoKeys = await this.loadVetoKeys(allMatches);
            const survivingMatches = [];
            const vetoedProjects = new Set();

            for (const match of allMatches) {
                const matchType = normalizeReportType(match.fiType || job.documentType);
                if (vetoKeys.has(`${match.projectId}::${matchType}`)) {
                    vetoedProjects.add(match.projectId);
                    continue;
                }
                survivingMatches.push(match);
            }

            if (vetoedProjects.size > 0) {
                logger.info(
                    `🚫 Suppressed ${allMatches.length - survivingMatches.length} match(es) across ` +
                    `${vetoedProjects.size} vetoed project(s) for job ${job.jobId}: ${[...vetoedProjects].join(', ')}`
                );

                // Close out any held matches for these projects. They can never be
                // delivered now, and left PENDING they would be reloaded and re-dropped
                // on every future delivery run.
                try {
                    const closed = await PendingMetadataMatch.updateMany(
                        { jobId: job.jobId, projectId: { $in: [...vetoedProjects] }, status: 'PENDING' },
                        { $set: { status: 'EXPIRED', lastAttemptAt: new Date() } }
                    );
                    if (closed.modifiedCount > 0) {
                        logger.info('delivery: expired pending matches for vetoed projects', { matches: closed.modifiedCount });
                    }
                } catch (error) {
                    logger.warn('delivery: could not expire pending matches for vetoed projects', { err: error.message });
                }
            }

            if (survivingMatches.length === 0) {
                logger.info('delivery: no deliverable matches remain after project vetoes', { job: job.jobId });
                await ScanJobDailyResult.updateMany(
                    deliveryWindow.filter,
                    { $set: { delivered: true, deliveredAt: new Date() } }
                );
                return;
            }

            // Collapse to one row per project so the email, the stored FIReport and the
            // audit export all describe the same document.
            const dedupedMatches = this.selectBestMatchPerProject(survivingMatches, job.documentType);

            // Partition once at project level: deliverable vs held (no metadata yet)
            const { deliverable, held, metadataMap } = await this.partitionMatchesByMetadata(dedupedMatches);

            // Persist held matches BEFORE emailing (crash-safe)
            const now = new Date();
            for (const m of held) {
                const key = `${m.projectId}::${m.fileName}`;
                const existing = pendingByKey.get(key);
                if (existing) {
                    existing.retryCount += 1;
                    existing.lastAttemptAt = now;
                    if (existing.retryCount >= MAX_METADATA_RETRIES) {
                        existing.status = 'EXPIRED';
                        logger.warn(`⏳ Match ${key} exhausted ${MAX_METADATA_RETRIES} metadata retries - marking EXPIRED`);
                    }
                    await existing.save();
                } else {
                    // $setOnInsert-only fields ensure an existing RESOLVED/EXPIRED doc is never resurrected
                    await PendingMetadataMatch.findOneAndUpdate(
                        { jobId: job.jobId, projectId: m.projectId, fileName: m.fileName },
                        {
                            $setOnInsert: {
                                filePath: m.filePath,
                                fiType: m.fiType,
                                validationQuote: m.validationQuote,
                                confidence: m.confidence,
                                timestamp: m.timestamp,
                                firstSeenAt: now,
                                retryCount: 1,
                                status: 'PENDING'
                            },
                            $set: { lastAttemptAt: now }
                        },
                        { upsert: true }
                    );
                    logger.debug('delivery: match held back, metadata not yet in Building Info API', { match: key });
                }
            }

            if (held.length > 0) {
                logger.info('delivery: matches held back pending Building Info metadata', { job: job.jobId, held: held.length });
            }

            logger.info('delivery: delivering deduplicated matches', { job: job.jobId, matches: deliverable.length, dailyResults: dailyResults.length });

            if (deliverable.length > 0) {
                // Reconstruct matches in the format sendMatchEmails expects
                const reconstructedMatches = deliverable.map(m => ({
                    document: { projectId: m.projectId, fileName: m.fileName, filePath: m.filePath || '' },
                    result: {
                        isMatch: true,
                        validationQuote: m.validationQuote || 'No quote captured',
                        confidence: m.confidence || 0.95,
                        reasoning: `FI request for ${m.fiType || job.documentType} detected`
                    },
                    customers: job.customers
                }));

                await this.sendMatchEmails(reconstructedMatches, job, metadataMap);
            } else {
                logger.info('delivery: no matches to deliver in this window', { job: job.jobId });
            }

            // Resolve pending docs whose project metadata is now available
            const resolvedIds = pendingDocs
                .filter(p => {
                    const md = metadataMap.get(p.projectId);
                    return md && !md.metadataUnavailable;
                })
                .map(p => p._id);
            if (resolvedIds.length > 0) {
                await PendingMetadataMatch.updateMany(
                    { _id: { $in: resolvedIds } },
                    { $set: { status: 'RESOLVED', lastAttemptAt: now } }
                );
                logger.info('delivery: pending matches resolved, metadata now available', { job: job.jobId, resolved: resolvedIds.length });
            }

            // Mark daily results as delivered
            await ScanJobDailyResult.updateMany(
                deliveryWindow.filter,
                { $set: { delivered: true, deliveredAt: new Date() } }
            );

            logger.debug('delivery: daily results marked delivered', { job: job.jobId, results: dailyResults.length });
        } catch (error) {
            logger.error('delivery: FAILED for job', { job: job.jobId, err: error.message, stack: error.stack });
            throw error;
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
