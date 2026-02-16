const dotenv = require('dotenv');
const path = require('path');

// Load environment variables from backend directory
dotenv.config({ path: path.join(__dirname, '.env') });

const mongoose = require('mongoose');
const logger = require('./utils/logger');
const { startScanWorker } = require('./services/scanJobWorker');
const scanJobProcessor = require('./services/scanJobProcessor');

const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
  logger.error('❌ MONGODB_URI not set - worker cannot start');
  process.exit(1);
}

mongoose.connect(MONGODB_URI)
  .then(async () => {
    logger.info('✅ Worker connected to MongoDB');

    // Initialize scan job processor scheduler (runs daily at 12:10 AM)
    await scanJobProcessor.initialize();

    // Start the queue worker
    await startScanWorker();
  })
  .catch((error) => {
    logger.error('❌ Worker failed to connect to MongoDB:', error);
    process.exit(1);
  });
