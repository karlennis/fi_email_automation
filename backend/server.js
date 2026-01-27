const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const dotenv = require('dotenv');
const mongoose = require('mongoose');
const winston = require('winston');
const path = require('path');

// Load environment variables
dotenv.config();

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
const scanJobProcessor = require('./services/scanJobProcessor');
const dailyRunService = require('./services/dailyRunService');
const dailyRunWorker = require('./services/dailyRunWorker');

// Configure logger
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'fi-email-backend' },
  transports: [
    new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
    new winston.transports.File({ filename: 'logs/combined.log' }),
    new winston.transports.Console({
      format: process.env.NODE_ENV === 'production'
        ? winston.format.json()
        : winston.format.simple()
    })
  ]
});

const app = express();
const PORT = process.env.PORT || 3001;

// Health check endpoint - MUST be first, before any middleware
// This prevents Render health checks from being rate-limited (429 errors)
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
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
app.use(cors({
  origin: [
    process.env.FRONTEND_URL || 'http://localhost:4200',
    'http://localhost:4200',
    'http://127.0.0.1:4200',
    'https://fi-email-automation-frontend.onrender.com'
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept']
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Create necessary directories
const fs = require('fs');
const dirs = ['logs', 'temp', 'temp/ocr'];
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

  // Initialize document register scheduler after DB connection
  try {
    documentRegisterScheduler.initialize();
    logger.info('Document register scheduler initialized successfully');
  } catch (error) {
    logger.error('Failed to initialize document register scheduler:', error);
  }

  // Initialize scan job processor
  try {
    scanJobProcessor.initialize();
    logger.info('Scan job processor initialized successfully');
  } catch (error) {
    logger.error('Failed to initialize scan job processor:', error);
  }

  // Reset stale processing items for restart safety
  dailyRunService.resetStaleItems().then(count => {
    if (count > 0) {
      logger.info(`♻️ Reset ${count} stale items on startup`);
    }
  }).catch(err => {
    logger.error('Failed to reset stale items:', err);
  });

  // Start daily run worker
  try {
    dailyRunWorker.start();
    logger.info('Daily run worker started successfully');
  } catch (error) {
    logger.error('Failed to start daily run worker:', error);
  }
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
});

module.exports = app;
