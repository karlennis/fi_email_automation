const dotenv = require('dotenv');
const mongoose = require('mongoose');
const logger = require('./utils/logger');
const { startScanWorker } = require('./services/scanJobWorker');

// Load environment variables
dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
  logger.error('❌ MONGODB_URI not set - worker cannot start');
  process.exit(1);
}

mongoose.connect(MONGODB_URI)
  .then(async () => {
    logger.info('✅ Worker connected to MongoDB');
    await startScanWorker();
  })
  .catch((error) => {
    logger.error('❌ Worker failed to connect to MongoDB:', error);
    process.exit(1);
  });
