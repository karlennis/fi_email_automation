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
     * Get documents modified since a specific date
     * This is MUCH faster than the full scan approach
     * @param {Date} sinceDate - Get documents modified after this date
     * @param {number} maxDocuments - Maximum documents to return (default: 5000, reduced from 10000 for memory)
     * @returns {Promise<Array>} Array of document objects
     */
    async getDocumentsModifiedSince(sinceDate, maxDocuments = 5000) {
        const startTime = Date.now();
        logger.info(`📅 Fast scan: Getting documents modified since ${sinceDate.toISOString()}`);

        const documents = [];
        let totalScanned = 0;
        let continuationToken = null;
        let hasMore = true;

        try {
            while (hasMore && documents.length < maxDocuments) {
                const params = {
                    Bucket: this.bucketName,
                    MaxKeys: 500, // Reduced from 1000 to lower memory usage
                    ContinuationToken: continuationToken
                };

                const command = new ListObjectsV2Command(params);
                const response = await this.s3Client.send(command);

                if (response.Contents) {
                    for (const object of response.Contents) {
                        totalScanned++;

                        // Filter by last modified date
                        if (object.LastModified && object.LastModified >= sinceDate) {
                            // Parse the S3 key to extract project ID and file info
                            const pathParts = object.Key.split('/');

                            // Path structure: planning-docs/PROJECT_ID/file.pdf
                            // So project ID is at index 1
                            if (pathParts.length >= 3) {
                                const projectId = pathParts[1]; // Changed from pathParts[0]
                                const fileName = pathParts[pathParts.length - 1];

                                // Skip folders, system files, and docfiles.txt
                                if (fileName &&
                                    !fileName.startsWith('.') &&
                                    fileName.includes('.') &&
                                    fileName.toLowerCase() !== 'docfiles.txt') {
                                    documents.push({
                                        projectId,
                                        fileName,
                                        filePath: object.Key,
                                        lastModified: object.LastModified,
                                        size: object.Size,
                                        fileType: this.getFileType(fileName)
                                    });

                                    // Check if we've reached the limit
                                    if (documents.length >= maxDocuments) {
                                        logger.info(`⚠️ Reached maximum document limit (${maxDocuments})`);
                                        hasMore = false;
                                        break;
                                    }
                                }
                            }
                        }
                    }
                    
                    // Clear response.Contents from memory after processing to reduce memory footprint
                    response.Contents = null;
                    delete response.Contents;
                }

                // Check if there are more objects to process
                continuationToken = response.NextContinuationToken;
                hasMore = hasMore && !!continuationToken;

                // Log progress every 10,000 objects
                if (totalScanned % 10000 === 0) {
                    logger.info(`📊 Progress: Scanned ${totalScanned} objects, found ${documents.length} matching documents`);
                }
            }

            const duration = ((Date.now() - startTime) / 1000).toFixed(2);
            logger.info(`✅ Fast scan complete: Found ${documents.length} documents in ${duration}s (scanned ${totalScanned} objects)`);

            return documents;

        } catch (error) {
            logger.error('❌ Error in fast S3 scan:', error);
            throw error;
        }
    }

    /**
     * Get yesterday's documents (most common use case)
     * @returns {Promise<Array>}
     */
    async getYesterdaysDocuments() {
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        yesterday.setHours(0, 0, 0, 0); // Start of yesterday

        logger.info(`📅 Getting documents for ${yesterday.toDateString()}`);
        return await this.getDocumentsModifiedSince(yesterday);
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
