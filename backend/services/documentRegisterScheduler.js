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
                logger.warn('🚨 High memory usage detected:', memMB);
            } else if (memMB.heapUsed > 1000) { // > 1GB
                logger.info('📊 Memory usage:', memMB);
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

        logger.info('Document register scheduler initialized - runs daily at 12:05 AM');

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
     * Execute the STREAMING document register generation (MEMORY SAFE)
     * No longer accumulates documents in arrays - streams directly to CSV
     */
    async runDailyGeneration() {
        if (this.isRunning) {
            logger.warn('Document register generation already running, skipping...');
            return {
                totalDocuments: 0,
                uniqueProjects: 0,
                csvPath: null,
                xlsxPath: null,
                metadataPath: null,
                stats: null,
                skipped: true,
                reason: 'Already running'
            };
        }

        this.isRunning = true;
        const startTime = new Date();
        logger.info('⚡ Starting STREAMING document register generation (memory safe)...');

        try {
            const timestamp = new Date().toISOString().split('T')[0];
            const outputDir = path.join(__dirname, 'outputs');
            if (!fs.existsSync(outputDir)) {
                fs.mkdirSync(outputDir, { recursive: true });
            }

            const csvPath = path.join(outputDir, `document-register-${timestamp}.csv`);

            // STREAMING CSV GENERATION - No document arrays in memory
            logger.info('📅 Starting streaming CSV generation for yesterday...');
            const streamResult = await this.streamDailyRegisterToCSV({
                csvPath,
                date: timestamp
            });

            // Generate safe metadata - NO DOCUMENTS ARRAY
            const metadataPath = path.join(outputDir, `register-metadata-${timestamp}.json`);
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
            
            fs.writeFileSync(metadataPath, JSON.stringify(safeMetadata, null, 2));

            // XLSX is disabled for memory safety (can be re-enabled with streaming XLSX writer)
            const xlsxPath = null;
            logger.warn('📊 XLSX generation disabled for memory safety - use CSV instead');

            this.lastRunTime = new Date();
            this.lastRunStatus = 'success';

            const totalDuration = ((new Date() - startTime) / 1000).toFixed(2);
            logger.info(`✅ STREAMING document register completed in ${totalDuration}s`, {
                totalDocuments: streamResult.totalDocuments,
                uniqueProjects: streamResult.uniqueProjects,
                csvPath,
                metadataPath
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

            logger.error('❌ Error in STREAMING document register generation:', error);
            logger.error('Stack trace:', error.stack);
            throw error;
        } finally {
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

        logger.info(`📊 STREAMING CSV generation: ${targetDate.toDateString()}`);

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

            logger.info(`✅ CSV streaming complete: ${totalDocuments} documents, ${projectSet.size} projects`);
            return result;

        } catch (error) {
            csvStream.end();
            logger.error('❌ Error in streaming CSV generation:', error);
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
