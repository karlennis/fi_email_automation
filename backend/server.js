const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const dotenv = require('dotenv');
const mongoose = require('mongoose');
const path = require('path');

// Load environment variables from backend directory
dotenv.config({ path: path.join(__dirname, '.env') });

// Fail fast if two spellings of the bucket or region disagree. Several services
// resolve the bucket at require time, so this has to run before they are loaded -
// a mismatch means the scanner lists one bucket while downloads hit another, and
// that failure mode reports success with zero matches.
require('./utils/awsConfig').assertConsistentS3Env();

// Import routes
const authRoutes = require('./routes/auth');
const projectRoutes = require('./routes/projects');
const documentRoutes = require('./routes/documents');
const documentsBrowserRoutes = require('./routes/documents-browser');
const customerRoutes = require('./routes/customers');
const jobRoutes = require('./routes/jobs');
const scheduledJobsRoutes = require('./routes/scheduled-jobs');
const apiFilteringRoutes = require('./routes/api-filtering');
const testRoutes = require('./routes/test');
const reportsRoutes = require('./routes/reports');
const documentRegisterRoutes = require('./routes/document-register');
const registerFiRoutes = require('./routes/register-fi');
const documentScanRoutes = require('./routes/document-scan');
const runsRoutes = require('./routes/runs');

// Services and schedulers
const documentRegisterScheduler = require('./services/documentRegisterScheduler');
// NOTE: ingestionScheduler moved to ingestion-worker.js
// NOTE: scanJobProcessor moved to worker.js - backend only enqueues jobs
const dailyRunService = require('./services/dailyRunService');
const dailyRunWorker = require('./services/dailyRunWorker');
const scheduledJobManager = require('./services/scheduledJobManager');

// The shared logger. This file used to build a second winston instance of its own,
// writing to CWD-relative logs/error.log and logs/combined.log - which is why the repo
// grew both a logs/ and a backend/logs/ directory holding two halves of the same story.
const logger = require('./utils/logger');
const runContext = require('./utils/runContext');

const app = express();
const PORT = process.env.PORT || 3001;

// Trust proxy - REQUIRED for Render.com and other cloud platforms
// This allows Express to properly read X-Forwarded-For headers
app.set('trust proxy', 1);

// Health check endpoint - MUST be first, before any middleware
// This prevents Render health checks from being rate-limited (429 errors)
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// Give every request its own id, so the lines a single API call produced can be pulled
// out of a log that also holds two clustered instances and the schedulers.
// /health fires constantly and logs nothing; wrapping it would be pure overhead.
app.use((req, res, next) => {
  if (req.path === '/health') return next();
  runContext.runWith({ runId: runContext.newRunId('REQ'), route: req.path }, next);
});

// Monitor health check responses - log if ever non-200
app.use((req, res, next) => {
  if (req.path === '/health') {
    const originalSend = res.send;
    res.send = function(data) {
      if (res.statusCode !== 200) {
        logger.error(`🚨 CRITICAL: /health returned ${res.statusCode} - this will cause Render restarts!`, {
          statusCode: res.statusCode,
          headers: req.headers,
          ip: req.ip
        });
      }
      return originalSend.call(this, data);
    };
  }
  next();
});

// Rate limiting
const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000, // 15 minutes
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100, // limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later.',
  skip: (req) => req.path === '/health' // Never rate limit health checks
});

// Middleware
app.use(helmet());
app.use(limiter);

// CORS configuration - must handle OPTIONS preflight
const corsOptions = {
  origin: function (origin, callback) {
    const allowedOrigins = [
      process.env.FRONTEND_URL || 'http://localhost:4200',
      'http://localhost:4200',
      'http://127.0.0.1:4200',
      'http://13.61.136.57', // EC2 instance IP
      'https://fi-email-automation-frontend-xvqm.onrender.com' // Current Render frontend URL
    ];

    // Allow requests with no origin (mobile apps, Postman, etc.)
    if (!origin || allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      logger.warn(`CORS blocked request from origin: ${origin}`);
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'X-Requested-With'],
  exposedHeaders: ['Content-Range', 'X-Content-Range'],
  maxAge: 600, // Cache preflight for 10 minutes
  preflightContinue: false,
  optionsSuccessStatus: 204
};

app.use(cors(corsOptions));

// Explicitly handle OPTIONS requests
app.options('*', cors(corsOptions));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Create necessary directories. 'logs' is no longer among them - utils/logger.js owns
// LOG_DIR and creates it there.
const fs = require('fs');
const dirs = ['temp', 'temp/ocr'];
dirs.forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/projects', projectRoutes);
app.use('/api/documents', documentRoutes);
app.use('/api/documents-browser', documentsBrowserRoutes);
app.use('/api/customers', customerRoutes);
app.use('/api/jobs', jobRoutes);
app.use('/api/scheduled-jobs', scheduledJobsRoutes);
app.use('/api/filtering', apiFilteringRoutes);
app.use('/api/test', testRoutes);
app.use('/api/reports', reportsRoutes);
app.use('/api/document-register', documentRegisterRoutes);
app.use('/api/register-fi', registerFiRoutes);
app.use('/api/document-scan', documentScanRoutes);
app.use('/api/runs', runsRoutes);

// Error handling middleware
app.use((err, req, res, next) => {
  logger.error(err.message, { error: err.stack });

  if (err.name === 'ValidationError') {
    return res.status(400).json({
      error: 'Validation Error',
      details: Object.values(err.errors).map(e => e.message)
    });
  }

  if (err.name === 'UnauthorizedError') {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  res.status(500).json({
    error: 'Internal Server Error',
    message: process.env.NODE_ENV === 'production' ? 'Something went wrong' : err.message
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Database connection
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/fi-email-automation', {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
.then(() => {
  logger.info('Connected to MongoDB');

  // Ensure primary admin exists (idempotent - safe to run on every startup)
  const User = require('./models/User');
  User.ensurePrimaryAdmin()
    .then(() => logger.info('Primary admin account verified'))
    .catch(error => logger.error('Failed to ensure primary admin:', error));

  // This app runs with instances: 2 in PM2 cluster mode, so everything below would
  // otherwise be registered twice and every cron would fire twice. Only the primary
  // fork registers schedulers; the Mongo lock inside each job is the real guarantee.
  const { isPrimaryInstance, describeInstance } = require('./utils/clusterRole');

  if (!isPrimaryInstance()) {
    logger.info(`Schedulers not registered on this process (${describeInstance()}) - serving API only`);
  } else {
    logger.info(`Registering schedulers on the primary process (${describeInstance()})`);

    // Initialize scheduled job manager after DB connection
    scheduledJobManager.initialize()
      .then(() => logger.info('Scheduled job manager initialized successfully'))
      .catch(error => logger.error('Failed to initialize scheduled job manager:', error));

    // Initialize document register scheduler after DB connection
    try {
      documentRegisterScheduler.initialize();
      logger.info('Document register scheduler initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize document register scheduler:', error);
    }

    // Start daily run worker
    try {
      dailyRunWorker.start();
      logger.info('Daily run worker started successfully');
    } catch (error) {
      logger.error('Failed to start daily run worker:', error);
    }
  }

  // NOTE: Ingestion scheduler moved to ingestion-worker.js
  // It runs at 11:55 PM to route filter-docs → planning-docs

  // NOTE: Scan job processor removed from backend - now runs in worker.js
  // The backend API only enqueues jobs to Redis via scanJobQueue

  // Reset stale processing items for restart safety. Left ungated: it is an idempotent
  // updateMany, and both forks running it is harmless.
  dailyRunService.resetStaleItems().then(result => {
    const count = typeof result === 'number' ? result : (result?.modifiedCount || 0);
    if (count > 0) {
      logger.info(`♻️ Reset ${count} stale items on startup`);
    }
  }).catch(err => {
    logger.error('Failed to reset stale items:', err);
  });
})
.catch((err) => {
  logger.error('MongoDB connection error:', err);
  logger.warn('Server will continue without database connection for testing');
  // Don't exit - allow server to start for frontend testing
  // process.exit(1);
});

// Start server
app.listen(PORT, () => {
  logger.info(`Server running on port ${PORT} in ${process.env.NODE_ENV} mode`);

  // Log memory usage every 5 minutes in production
  if (process.env.NODE_ENV === 'production') {
    setInterval(() => {
      const mem = process.memoryUsage();
      logger.info(`📊 Memory: Heap ${(mem.heapUsed / 1024 / 1024).toFixed(2)}MB / ${(mem.heapTotal / 1024 / 1024).toFixed(2)}MB, RSS ${(mem.rss / 1024 / 1024).toFixed(2)}MB`);

      // Warn if memory exceeds 1200MB (60% of Render's 2GB limit) - LOWERED
      if (mem.rss > 1200 * 1024 * 1024) {
        logger.warn(`⚠️ HIGH MEMORY USAGE: ${(mem.rss / 1024 / 1024).toFixed(2)}MB / 2048MB limit`);
      }
    }, 5 * 60 * 1000);
  }
});

// Global error handlers for uncaught exceptions/rejections
// This helps save checkpoint state before crashes
process.on('uncaughtException', async (error) => {
  logger.error('❌ UNCAUGHT EXCEPTION - Process will terminate:', error);

  try {
    // Try to save checkpoint for any active or running scan jobs
    const ScanJob = require('./models/ScanJob');
    const activeScanJobs = await ScanJob.find({ status: { $in: ['ACTIVE', 'RUNNING'] } });

    for (const job of activeScanJobs) {
      // If job has a checkpoint with progress, mark for resume
      if (job.checkpoint && job.checkpoint.processedCount > 0 && !job.checkpoint.isResuming) {
        job.checkpoint.isResuming = true;
        await job.save();
        logger.info(`💾 Emergency checkpoint saved for job ${job.jobId} at ${job.checkpoint.processedCount} documents`);
      }
    }
  } catch (saveError) {
    logger.error('Failed to save emergency checkpoint:', saveError);
  }

  // Give it a second to flush logs, then exit
  setTimeout(() => {
    process.exit(1);
  }, 1000);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('❌ UNHANDLED REJECTION:', reason);
  // Don't exit on unhandled rejection - just log it
});

module.exports = app;
