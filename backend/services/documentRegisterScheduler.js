const schedule = require('node-schedule');
const logger = require('../utils/logger');
const fastS3Scanner = require('./fastS3Scanner');
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

class DocumentRegisterScheduler {
    constructor() {
        this.job = null;
        this.isRunning = false;
        this.lastRunTime = null;
        this.lastRunStatus = null;
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

        logger.info('Document register scheduler initialized - runs daily at 12:05 AM');

        // Also run once on startup if it hasn't run today
        this.checkAndRunStartup();
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
                logger.info(`✅ Document register already generated for ${today} - skipping startup generation`);

                // Load the metadata to set last run time
                try {
                    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
                    this.lastRunTime = new Date(metadata.generatedAt);
                    this.lastRunStatus = 'success';
                    logger.info(`📋 Last generation was at ${this.lastRunTime.toLocaleString()}`);
                } catch (err) {
                    logger.warn('Could not read metadata file:', err.message);
                }
                return;
            }

            // Check if we have run today based on lastRunTime
            if (this.lastRunTime && this.isSameDay(this.lastRunTime, new Date())) {
                logger.info('✅ Document register already generated today - skipping startup generation');
                return;
            }

            logger.info('📋 No document register generated today - running startup generation');
            await this.runDailyGeneration();
        } catch (error) {
            logger.error('Error checking startup generation:', error);
        }
    }

    /**
     * Execute the daily document register generation using FAST scanning
     */
    async runDailyGeneration() {
        if (this.isRunning) {
            logger.warn('Document register generation already running, skipping...');
            return;
        }

        this.isRunning = true;
        const startTime = new Date();
        logger.info('⚡ Starting FAST scheduled document register generation...');

        try {
            // Use the fast S3 scanner for yesterday's documents
            const documents = await fastS3Scanner.getYesterdaysDocuments();

            // Get statistics
            const stats = fastS3Scanner.getStatistics(documents);

            // Save to files
            const outputDir = path.join(__dirname, 'outputs');
            if (!fs.existsSync(outputDir)) {
                fs.mkdirSync(outputDir, { recursive: true });
            }

            const timestamp = new Date().toISOString().split('T')[0];

            // Save CSV
            const csvPath = path.join(outputDir, `document-register-${timestamp}.csv`);
            const csvContent = this.generateCSV(documents);
            fs.writeFileSync(csvPath, csvContent);

            // Save XLSX
            const xlsxPath = path.join(outputDir, `document-register-${timestamp}.xlsx`);
            this.generateXLSX(documents, xlsxPath);

            // Save JSON metadata
            const metadataPath = path.join(outputDir, `register-metadata-${timestamp}.json`);
            fs.writeFileSync(metadataPath, JSON.stringify({
                generatedAt: new Date().toISOString(),
                ...stats,
                documents: documents
            }, null, 2));

            this.lastRunTime = new Date();
            this.lastRunStatus = 'success';

            const duration = ((new Date() - startTime) / 1000).toFixed(2);
            logger.info(`✅ FAST document register generation completed in ${duration}s`, {
                totalDocuments: stats.totalDocuments,
                uniqueProjects: stats.uniqueProjects,
                csvPath,
                xlsxPath,
                metadataPath
            });

            return {
                totalDocuments: stats.totalDocuments,
                uniqueProjects: stats.uniqueProjects,
                csvPath,
                xlsxPath,
                metadataPath,
                stats
            };
        } catch (error) {
            this.lastRunTime = new Date();
            this.lastRunStatus = 'error';

            logger.error('Error in scheduled document register generation:', error);
            throw error;
        } finally {
            this.isRunning = false;
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
        logger.info('Manual document register generation triggered');
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
            logger.info('Document register scheduler stopped');
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
