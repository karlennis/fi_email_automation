const schedule = require('node-schedule');
const logger = require('../utils/logger');
const runContext = require('../utils/runContext');
const fastS3Scanner = require('./fastS3Scanner');
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { withLock } = require('./jobLock');

class DocumentRegisterScheduler {
    constructor() {
        this.job = null;
        this.isRunning = false;
        this.lastRunTime = null;
        this.lastRunStatus = null;
        
        // Start memory monitoring for production reliability
        this.startMemoryMonitoring();
    }

    /**
     * MEMORY DIAGNOSTICS - Track memory usage every 10s (lightweight)
     */
    startMemoryMonitoring() {
        setInterval(() => {
            const mem = process.memoryUsage();
            const memMB = {
                rss: Math.round(mem.rss / 1024 / 1024),
                heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
                heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
                external: Math.round(mem.external / 1024 / 1024)
            };
            
            // Log only if memory usage is concerning
            if (memMB.heapUsed > 1500) { // > 1.5GB on 2GB system
                logger.warn('high memory usage', memMB);
            } else if (memMB.heapUsed > 1000) { // > 1GB
                logger.debug('memory usage', memMB);
            }
        }, 10000); // Every 10 seconds
    }

    /**
     * Initialize the scheduler to run daily at midnight
     */
    initialize() {
        // Run every day at 12:05 AM (after midnight, to catch previous day's documents)
        const cronExpression = '5 0 * * *'; // minute hour day month day-of-week

        this.job = schedule.scheduleJob(cronExpression, async () => {
            await this.runDailyGeneration();
        });

        logger.info('document register scheduler ready', { daily: '00:05' });

        // Disabled startup check to prevent memory issues on deployment
        // The scheduled job will run at 12:05 AM daily
        // this.checkAndRunStartup();
    }

    /**
     * Check if generation has run today, if not, run it
     */
    async checkAndRunStartup() {
        try {
            // Check if we already have today's files
            const today = new Date().toISOString().split('T')[0];
            const metadataPath = path.join(__dirname, 'outputs', `register-metadata-${today}.json`);

            if (fs.existsSync(metadataPath)) {
                logger.info('register: already generated, skipping startup run', { today });

                // Load the metadata to set last run time
                try {
                    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
                    this.lastRunTime = new Date(metadata.generatedAt);
                    this.lastRunStatus = 'success';
                    logger.debug('register: last generation', { at: this.lastRunTime.toISOString() });
                } catch (err) {
                    logger.warn('register: could not read metadata file', { err: err.message });
                }
                return;
            }

            // Check if we have run today based on lastRunTime
            if (this.lastRunTime && this.isSameDay(this.lastRunTime, new Date())) {
                logger.info('register: already generated today, skipping startup run');
                return;
            }

            logger.info('register: none generated today, running startup generation');
            await this.runDailyGeneration();
        } catch (error) {
            logger.error('register: startup check failed', error);
        }
    }

    /**
     * Execute the STREAMING document register generation (MEMORY SAFE)
     * No longer accumulates documents in arrays - streams directly to CSV
     */
    async runDailyGeneration() {
        return runContext.runWith({ runId: runContext.newRunId('REGISTER') }, async () => {
            // this.isRunning is the cheap in-process short-circuit; the Mongo lock is what
            // actually prevents two PM2 cluster instances writing the same CSV concurrently.
            if (this.isRunning) {
                logger.warn('register: already running, skipping');
                return this.skippedResult('Already running');
            }

            const outcome = await withLock(
                'document-register-daily',
                {
                    ttlMs: 60 * 60 * 1000,
                    heartbeat: true,
                    skipMessage: 'register: lock held by another instance, skipping'
                },
                () => this.generateDailyRegister()
            );

            return outcome.ran ? outcome.result : this.skippedResult(outcome.reason);
        });
    }

    skippedResult(reason) {
        return {
            totalDocuments: 0,
            uniqueProjects: 0,
            csvPath: null,
            xlsxPath: null,
            metadataPath: null,
            stats: null,
            skipped: true,
            reason
        };
    }

    /**
     * The actual generation. Always call through runDailyGeneration() so it stays locked.
     */
    async generateDailyRegister() {
        this.isRunning = true;
        const startTime = new Date();
        logger.info('run start: document register');

        // Declared out here so the failure path can clear them.
        const tempPaths = [];

        try {
            const timestamp = new Date().toISOString().split('T')[0];
            const outputDir = path.join(__dirname, 'outputs');
            if (!fs.existsSync(outputDir)) {
                fs.mkdirSync(outputDir, { recursive: true });
            }

            const csvPath = path.join(outputDir, `document-register-${timestamp}.csv`);

            // Write to a process-private temp file and rename on success. Renames within
            // a directory are atomic, so the final name only ever exists complete - a
            // crashed or concurrent run can no longer leave a truncated CSV that looks
            // finished. (Two instances used to open a write stream on the same path and
            // interleave their output line by line.)
            const csvTempPath = `${csvPath}.${process.pid}.part`;
            tempPaths.push(csvTempPath);

            // STREAMING CSV GENERATION - No document arrays in memory
            logger.debug('register: streaming CSV for yesterday');
            const streamResult = await this.streamDailyRegisterToCSV({
                csvPath: csvTempPath,
                date: timestamp
            });

            fs.renameSync(csvTempPath, csvPath);

            // Generate safe metadata - NO DOCUMENTS ARRAY
            const metadataPath = path.join(outputDir, `register-metadata-${timestamp}.json`);
            const metadataTempPath = `${metadataPath}.${process.pid}.part`;
            tempPaths.push(metadataTempPath);
            const safeMetadata = {
                generatedAt: new Date().toISOString(),
                date: timestamp,
                totalDocuments: streamResult.totalDocuments,
                totalSize: streamResult.totalSize,
                uniqueProjects: streamResult.uniqueProjects,
                csvPath: csvPath,
                durationMs: streamResult.duration * 1000,
                // NO documents array - memory safe
                processing: {
                    method: 'streaming',
                    memoryFootprint: 'constant',
                    note: 'Documents not stored in memory'
                }
            };
            
            fs.writeFileSync(metadataTempPath, JSON.stringify(safeMetadata, null, 2));
            fs.renameSync(metadataTempPath, metadataPath);

            // XLSX is disabled for memory safety (can be re-enabled with streaming XLSX writer)
            const xlsxPath = null;
            logger.debug('register: XLSX output disabled for memory safety, CSV only');

            this.lastRunTime = new Date();
            this.lastRunStatus = 'success';

            logger.info('run end: document register', {
                documents: streamResult.totalDocuments,
                projects: streamResult.uniqueProjects,
                csv: path.basename(csvPath),
                sec: Math.round((new Date() - startTime) / 1000)
            });

            return {
                totalDocuments: streamResult.totalDocuments,
                uniqueProjects: streamResult.uniqueProjects,
                csvPath,
                xlsxPath,
                metadataPath,
                stats: safeMetadata
            };

        } catch (error) {
            this.lastRunTime = new Date();
            this.lastRunStatus = 'error';

            logger.error('run end: document register FAILED', error);
            throw error;
        } finally {
            // Partial output is never useful and would otherwise accumulate one file per
            // failed night. The already-renamed final files are untouched.
            for (const tempPath of tempPaths) {
                try {
                    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
                } catch (cleanupError) {
                    logger.warn('register: could not remove partial file', { file: path.basename(tempPath), err: cleanupError.message });
                }
            }
            this.isRunning = false;
        }
    }

    /**
     * STREAMING CSV GENERATION - Memory-safe document register
     * Processes documents one-by-one, never accumulating arrays
     */
    async streamDailyRegisterToCSV({ csvPath, date }) {
        const fs = require('fs');
        const { createWriteStream } = fs;
        
        // Setup date range for yesterday (or specified date)
        const targetDate = date ? new Date(date) : new Date();
        if (!date) {
            targetDate.setDate(targetDate.getDate() - 1); // Yesterday
        }
        targetDate.setHours(0, 0, 0, 0);
        
        const endDate = new Date(targetDate);
        endDate.setHours(23, 59, 59, 999);

        logger.debug('register: CSV generation started', { date: targetDate.toISOString().split('T')[0] });

        // Create CSV write stream
        const csvStream = createWriteStream(csvPath, { encoding: 'utf8' });
        
        // Write CSV header
        csvStream.write('Project ID,File Name,File Path,Last Modified,Size,File Type\n');

        // Streaming stats (bounded memory)
        let totalDocuments = 0;
        let totalSize = 0;
        const projectSet = new Set(); // Bounded - unique project IDs only
        
        try {
            // STREAM documents directly to CSV - NO ARRAY ACCUMULATION
            const scanResult = await fastS3Scanner.streamDocumentsSince(
                targetDate,
                endDate,
                async (doc) => {
                    // Write CSV row immediately - NO MEMORY RETENTION
                    const csvRow = `"${doc.projectId}","${doc.fileName}","${doc.filePath}","${doc.lastModified}","${doc.size}","${doc.fileType}"\n`;
                    csvStream.write(csvRow);
                    
                    // Update bounded stats only
                    totalDocuments++;
                    totalSize += doc.size;
                    projectSet.add(doc.projectId);
                },
                { maxObjects: 1000000, timeoutSeconds: 600 } // 10 min max
            );

            // Close CSV stream
            csvStream.end();
            
            const result = {
                totalDocuments,
                totalSize,
                uniqueProjects: projectSet.size,
                duration: scanResult.duration,
                csvPath
            };

            logger.debug('register: CSV streaming complete', { documents: totalDocuments, projects: projectSet.size });
            return result;

        } catch (error) {
            csvStream.end();
            logger.error('register: CSV streaming failed', error);
            throw error;
        }
    }

    /**
     * Generate CSV content from documents
     */
    generateCSV(documents) {
        const headers = 'Project ID,File Name,File Path,Last Modified,Size,File Type\n';
        const rows = documents.map(doc => {
            return `"${doc.projectId}","${doc.fileName}","${doc.filePath}","${doc.lastModified}","${doc.size || 0}","${doc.fileType}"`;
        }).join('\n');
        return headers + rows;
    }

    /**
     * Generate XLSX file from documents
     */
    generateXLSX(documents, outputPath) {
        const worksheet = XLSX.utils.json_to_sheet(documents.map(doc => ({
            'Project ID': doc.projectId,
            'File Name': doc.fileName,
            'File Path': doc.filePath,
            'Last Modified': new Date(doc.lastModified).toISOString(),
            'Size (bytes)': doc.size || 0,
            'File Type': doc.fileType
        })));

        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, 'Document Register');
        XLSX.writeFile(workbook, outputPath);
    }

    /**
     * Manually trigger a document register generation
     */
    async runManual() {
        logger.info('register: manual trigger');
        return await this.runDailyGeneration();
    }

    /**
     * Get the status of the scheduler
     */
    getStatus() {
        return {
            isInitialized: this.job !== null,
            isRunning: this.isRunning,
            lastRunTime: this.lastRunTime,
            lastRunStatus: this.lastRunStatus,
            nextRunTime: this.job ? this.job.nextInvocation() : null
        };
    }

    /**
     * Stop the scheduler
     */
    stop() {
        if (this.job) {
            this.job.cancel();
            this.job = null;
            logger.info('document register scheduler stopped');
        }
    }

    /**
     * Restart the scheduler
     */
    restart() {
        this.stop();
        this.initialize();
    }

    /**
     * Check if two dates are on the same day
     */
    isSameDay(date1, date2) {
        return date1.getFullYear() === date2.getFullYear() &&
               date1.getMonth() === date2.getMonth() &&
               date1.getDate() === date2.getDate();
    }
}

// Singleton instance
const documentRegisterScheduler = new DocumentRegisterScheduler();

module.exports = documentRegisterScheduler;
