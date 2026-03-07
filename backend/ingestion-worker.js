/**
 * Ingestion Worker
 * 
 * Dedicated worker for document ingestion pipeline:
 * - Routes documents from filter-docs to planning-docs
 * - Handles baseline markers for new projects
 * - Cleans up old baseline markers
 * 
 * Schedule:
 * - 11:00 PM: Route filter-docs → planning-docs
 * - 12:05 AM: Clean up old baseline markers
 * 
 * This runs BEFORE the FI scan (12:10 AM) to ensure documents
 * are properly placed and baselined.
 */

const dotenv = require('dotenv');
const path = require('path');

// Load environment variables from backend directory
dotenv.config({ path: path.join(__dirname, '.env') });

const mongoose = require('mongoose');
const logger = require('./utils/logger');
const ingestionScheduler = require('./services/ingestionScheduler');
const s3Service = require('./services/s3Service');

const MONGODB_URI = process.env.MONGODB_URI;

// MongoDB is optional for ingestion worker (only uses S3)
// But we connect anyway for potential future logging/tracking
async function connectMongoDB() {
  if (!MONGODB_URI) {
    logger.warn('⚠️ MONGODB_URI not set - ingestion worker running without MongoDB');
    return false;
  }

  try {
    await mongoose.connect(MONGODB_URI);
    logger.info('✅ Ingestion worker connected to MongoDB');
    return true;
  } catch (error) {
    logger.warn('⚠️ Could not connect to MongoDB - continuing anyway:', error.message);
    return false;
  }
}

async function verifyS3Connection() {
  try {
    // Quick S3 health check
    const exists = await s3Service.objectExists('planning-docs/');
    logger.info('✅ S3 connection verified');
    return true;
  } catch (error) {
    logger.error('❌ S3 connection failed:', error.message);
    return false;
  }
}

async function ensureFilterDocsRootKeep() {
  try {
    await s3Service.ensureFilterDocsRootKeep();
    return true;
  } catch (error) {
    logger.error('❌ Could not ensure filter-docs root keep file:', error.message);
    return false;
  }
}

async function main() {
  logger.info('🚀 Starting Ingestion Worker...');
  logger.info(`   Bucket: ${s3Service.bucket}`);
  logger.info('   Schedule:');
  logger.info('     - 11:00 PM: Route filter-docs → planning-docs');
  logger.info('     - 12:05 AM: Cleanup old baseline markers');
  logger.info(`   Filter-docs deletion after routing: ${process.env.INGESTION_CLEANUP_FILTER_DOCS === 'true' ? 'ENABLED' : 'DISABLED'}`);

  // Connect to MongoDB (optional)
  await connectMongoDB();

  // Verify S3 connection (required)
  const s3Ok = await verifyS3Connection();
  if (!s3Ok) {
    logger.error('❌ Cannot start ingestion worker without S3 access');
    process.exit(1);
  }

  const filterDocsRootOk = await ensureFilterDocsRootKeep();
  if (!filterDocsRootOk) {
    logger.error('❌ Cannot start ingestion worker without filter-docs root keep file');
    process.exit(1);
  }

  // Initialize the ingestion scheduler
  await ingestionScheduler.initialize();

  logger.info('✅ Ingestion Worker initialized and running');
  logger.info('   Next routing job:', ingestionScheduler.getStatus().nextRoutingRun || 'Not scheduled');
  logger.info('   Next cleanup job:', ingestionScheduler.getStatus().nextCleanupRun || 'Not scheduled');

  // Run initial check on startup (if filter-docs has pending items)
  if (process.env.INGESTION_RUN_ON_STARTUP === 'true') {
    logger.info('🔄 Running initial routing check on startup...');
    setTimeout(async () => {
      try {
        const documentIngestionService = require('./services/documentIngestionService');
        const stagedProjects = await documentIngestionService.listStagedProjects();
        
        if (stagedProjects.length > 0) {
          logger.info(`📦 Found ${stagedProjects.length} projects in filter-docs - routing now`);
          await ingestionScheduler.triggerRouting();
        } else {
          logger.info('📭 No projects in filter-docs staging area');
        }
      } catch (error) {
        logger.error('Error during startup check:', error);
      }
    }, 5000);
  }

  // Keep the process alive
  process.on('SIGTERM', () => {
    logger.info('🛑 Received SIGTERM - shutting down ingestion worker');
    ingestionScheduler.stop();
    process.exit(0);
  });

  process.on('SIGINT', () => {
    logger.info('🛑 Received SIGINT - shutting down ingestion worker');
    ingestionScheduler.stop();
    process.exit(0);
  });
}

// Start the worker
main().catch((error) => {
  logger.error('❌ Ingestion worker failed to start:', error);
  process.exit(1);
});
