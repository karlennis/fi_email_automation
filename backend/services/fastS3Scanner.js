const { S3Client, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const logger = require('../utils/logger');

/**
 * Fast document scanner for S3 - filters by last modified date
 * This is much faster than scanning all objects
 */
class FastS3Scanner {
    constructor() {
        this.s3Client = new S3Client({
            region: process.env.AWS_REGION || 'eu-west-2',
            credentials: {
                accessKeyId: process.env.AWS_ACCESS_KEY_ID,
                secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
            }
        });
        this.bucketName = process.env.S3_BUCKET_NAME || 'planning-documents-2';
    }

    /**
     * STREAMING S3 SCANNER - No array accumulation, constant memory
     * Processes each document via callback to prevent OOM crashes
     * @param {Date} sinceDate - Get documents modified after this date
     * @param {Date} endDate - Get documents modified before this date (optional)
     * @param {Function} onDocument - Callback for each matching document: (doc) => void
     * @param {Object} options - { maxObjects, timeoutSeconds }
     * @returns {Promise<Object>} Stats only: { totalScanned, totalMatched, duration }
     */
    async streamDocumentsSince(sinceDate, endDate = null, onDocument, options = {}) {
        // Default: no timeout (null = infinite). Override with env var if needed for testing
        const { maxObjects = null, timeoutSeconds = null } = options;
        const startTime = Date.now();
        
        logger.info(`📅 STREAMING scan: ${sinceDate.toISOString()} to ${endDate ? endDate.toISOString() : 'now'}`);

        let totalScanned = 0;
        let totalMatched = 0;
        let continuationToken = null;
        let hasMore = true;

        try {
            while (hasMore && (maxObjects === null || totalScanned < maxObjects)) {
                const params = {
                    Bucket: this.bucketName,
                    Prefix: 'planning-docs/', // MANDATORY: Scope to planning docs only
                    MaxKeys: 1000, // MANDATORY: Max batch size as specified
                    ContinuationToken: continuationToken
                };

                const command = new ListObjectsV2Command(params);
                const response = await this.s3Client.send(command);

                if (response.Contents) {
                    // Process each object immediately - NO ARRAY ACCUMULATION
                    for (const object of response.Contents) {
                        totalScanned++;

                        // Filter by last modified date
                        if (object.LastModified && object.LastModified >= sinceDate) {
                            if (!endDate || object.LastModified <= endDate) {
                                // Parse S3 key structure
                                const pathParts = object.Key.split('/');
                                if (pathParts.length >= 3) {
                                    const projectId = pathParts[1];
                                    const fileName = pathParts[pathParts.length - 1];

                                    // Skip folders, system files, docfiles.txt, and non-PDF/DOCX files
                                    // MUST match the filter in countDocumentsSince() to ensure accurate counts
                                    if (fileName &&
                                        !fileName.startsWith('.') &&
                                        fileName.includes('.') &&
                                        fileName.toLowerCase() !== 'docfiles.txt' &&
                                        (fileName.toLowerCase().endsWith('.pdf') || fileName.toLowerCase().endsWith('.docx'))) {
                                        
                                        // Stream document immediately - NO MEMORY RETENTION
                                        const doc = {
                                            projectId,
                                            fileName,
                                            filePath: object.Key,
                                            lastModified: object.LastModified.toISOString(),
                                            size: object.Size || 0,
                                            fileType: this.getFileType(fileName)
                                        };
                                        
                                        await onDocument(doc); // Process immediately
                                        totalMatched++;
                                    }
                                }
                            }
                        }
                    }

                    // Aggressively clear response from memory
                    response.Contents.length = 0;
                    response.Contents = null;
                    delete response.Contents;
                }

                // Pagination control
                continuationToken = response.NextContinuationToken;
                hasMore = hasMore && !!continuationToken;

                // Timeout protection (only if timeoutSeconds is set)
                const elapsed = (Date.now() - startTime) / 1000;
                if (timeoutSeconds !== null && elapsed > timeoutSeconds) {
                    logger.warn(`⏱️ Stopping scan after ${timeoutSeconds}s timeout (scanned ${totalScanned} objects)`);
                    break;
                }
                
                // Progress logging
                if (totalScanned % 10000 === 0) {
                    logger.info(`📊 Streaming: ${totalScanned} scanned, ${totalMatched} matched (${elapsed.toFixed(1)}s)`);
                }
                
                // Memory management
                if (totalScanned % 5000 === 0 && global.gc) {
                    global.gc();
                }
            }

            const duration = ((Date.now() - startTime) / 1000).toFixed(2);
            logger.info(`✅ STREAMING scan complete: ${totalMatched} documents streamed in ${duration}s (scanned ${totalScanned} objects)`);

            return {
                totalScanned,
                totalMatched,
                duration: parseFloat(duration)
            };

        } catch (error) {
            logger.error('❌ Error in streaming S3 scan:', error);
            throw error;
        }
    }

    /**
     * LEGACY METHOD - DEPRECATED: Use streamDocumentsSince instead
     * Kept for backward compatibility but limited to prevent OOM
     */
    async getDocumentsModifiedSince(sinceDate, maxDocuments = 100) {
        logger.warn('⚠️ DEPRECATED: getDocumentsModifiedSince() - use streamDocumentsSince() instead');
        
        const documents = [];
        await this.streamDocumentsSince(sinceDate, null, async (doc) => {
            if (documents.length < maxDocuments) {
                documents.push(doc);
            }
        }, { maxObjects: maxDocuments * 10, timeoutSeconds: 60 });
        
        return documents.slice(0, maxDocuments);
    }

    /**
     * STREAMING method for yesterday's documents
     * @param {Function} onDocument - Callback for each document: (doc) => void
     * @returns {Promise<Object>} Stats only
     */
    async streamYesterdaysDocuments(onDocument) {
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        yesterday.setHours(0, 0, 0, 0);
        
        const endOfYesterday = new Date(yesterday);
        endOfYesterday.setHours(23, 59, 59, 999);

        logger.info(`📅 STREAMING yesterday's documents: ${yesterday.toDateString()}`);
        return await this.streamDocumentsSince(yesterday, endOfYesterday, onDocument);
    }

    /**
     * LEGACY - DEPRECATED: Use streamYesterdaysDocuments instead
     */
    async getYesterdaysDocuments() {
        logger.warn('⚠️ DEPRECATED: getYesterdaysDocuments() - use streamYesterdaysDocuments() instead');
        return await this.getDocumentsModifiedSince(
            (() => {
                const yesterday = new Date();
                yesterday.setDate(yesterday.getDate() - 1);
                yesterday.setHours(0, 0, 0, 0);
                return yesterday;
            })(),
            100 // Hard limit for legacy callers
        );
    }

    /**
     * Get documents for a specific date range
     * @param {Date} startDate
     * @param {Date} endDate
     * @returns {Promise<Array>}
     */
    async getDocumentsByDateRange(startDate, endDate) {
        logger.info(`📅 Getting documents from ${startDate.toDateString()} to ${endDate.toDateString()}`);

        const allDocuments = await this.getDocumentsModifiedSince(startDate);

        // Filter to only include documents within the end date
        const filteredDocuments = allDocuments.filter(doc => {
            const docDate = new Date(doc.lastModified);
            return docDate <= endDate;
        });

        logger.info(`✅ Found ${filteredDocuments.length} documents in date range`);
        return filteredDocuments;
    }

    /**
     * Get today's documents
     * @returns {Promise<Array>}
     */
    async getTodaysDocuments() {
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        logger.info(`📅 Getting documents for today (${today.toDateString()})`);
        return await this.getDocumentsModifiedSince(today);
    }

    /**
     * Get documents for the last N days
     * @param {number} days - Number of days to look back
     * @returns {Promise<Array>}
     */
    async getRecentDocuments(days = 7) {
        const sinceDate = new Date();
        sinceDate.setDate(sinceDate.getDate() - days);
        sinceDate.setHours(0, 0, 0, 0);

        logger.info(`📅 Getting documents from last ${days} days`);
        return await this.getDocumentsModifiedSince(sinceDate);
    }

    /**
     * Count documents in a date range WITHOUT processing them
     * Scans S3 for matching documents and returns only the count
     * @param {Date} sinceDate - Get documents modified after this date
     * @param {Date} endDate - Get documents modified before this date (optional)
     * @returns {Promise<number>} Total matching document count
     */
    async countDocumentsSince(sinceDate, endDate = null) {
        logger.info(`📊 Counting documents: ${sinceDate.toISOString()} to ${endDate ? endDate.toISOString() : 'now'}`);
        
        let totalCount = 0;
        let continuationToken = null;
        let hasMore = true;

        try {
            while (hasMore) {
                const params = {
                    Bucket: this.bucketName,
                    Prefix: 'planning-docs/',
                    MaxKeys: 1000,
                    ContinuationToken: continuationToken
                };

                const command = new ListObjectsV2Command(params);
                const response = await this.s3Client.send(command);

                if (response.Contents) {
                    for (const object of response.Contents) {
                        // Filter by last modified date
                        if (object.LastModified && object.LastModified >= sinceDate) {
                            if (!endDate || object.LastModified <= endDate) {
                                const pathParts = object.Key.split('/');
                                if (pathParts.length >= 3) {
                                    const fileName = pathParts[pathParts.length - 1];
                                    
                                    // Count PDF and DOCX files only
                                    if (fileName &&
                                        !fileName.startsWith('.') &&
                                        fileName.includes('.') &&
                                        fileName.toLowerCase() !== 'docfiles.txt' &&
                                        (fileName.toLowerCase().endsWith('.pdf') || fileName.toLowerCase().endsWith('.docx'))) {
                                        totalCount++;
                                    }
                                }
                            }
                        }
                    }
                    response.Contents = null;
                }

                continuationToken = response.NextContinuationToken;
                hasMore = !!continuationToken;
            }
        } catch (error) {
            logger.error(`❌ Error counting documents: ${error.message}`);
            throw error;
        }

        logger.info(`📊 Total documents in date range: ${totalCount}`);
        return totalCount;
    }

    /**
     * Get file type from filename
     */
    getFileType(fileName) {
        if (!fileName) return 'unknown';
        const ext = fileName.split('.').pop().toLowerCase();

        const typeMap = {
            'pdf': 'pdf',
            'doc': 'document',
            'docx': 'document',
            'xls': 'spreadsheet',
            'xlsx': 'spreadsheet',
            'jpg': 'image',
            'jpeg': 'image',
            'png': 'image',
            'zip': 'archive',
            'dwg': 'cad',
            'dxf': 'cad'
        };

        return typeMap[ext] || 'other';
    }

    /**
     * Get statistics about scanned documents
     * @param {Array} documents
     * @returns {Object}
     */
    getStatistics(documents) {
        const projectMap = new Map();
        const fileTypeMap = new Map();
        let totalSize = 0;

        for (const doc of documents) {
            // Count documents per project
            const count = projectMap.get(doc.projectId) || 0;
            projectMap.set(doc.projectId, count + 1);

            // Count file types
            const typeCount = fileTypeMap.get(doc.fileType) || 0;
            fileTypeMap.set(doc.fileType, typeCount + 1);

            // Sum total size
            totalSize += doc.size || 0;
        }

        // Get top projects
        const topProjects = Array.from(projectMap.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10)
            .map(([projectId, count]) => ({ projectId, count }));

        return {
            totalDocuments: documents.length,
            uniqueProjects: projectMap.size,
            totalSize,
            topProjects,
            fileTypes: Object.fromEntries(fileTypeMap)
        };
    }
}

module.exports = new FastS3Scanner();
