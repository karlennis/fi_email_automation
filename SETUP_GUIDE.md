# FI Email Automation - Complete Setup Guide

## ⚠️ SECURITY WARNING
**NEVER commit real credentials to version control!**
- Always use placeholder values in documentation
- Store actual credentials in `.env` files (which should be in `.gitignore`)
- Use environment variable placeholders like `your-api-key` in setup guides
- Rotate any credentials that may have been accidentally exposed

## 🔐 Credential Security Best Practices

1. **Environment Files**: Create a `.env` file in the backend directory with your actual credentials
2. **Never Commit**: The `.gitignore` file already excludes `.env` files from version control
3. **Use Placeholders**: This guide uses placeholder values - replace them with real credentials
4. **Rotate Exposed Keys**: If credentials were accidentally committed, rotate them immediately:
   - AWS: Create new IAM user and delete the old one
   - OpenAI: Generate new API key
   - Building Info API: Request new API keys
   - Database: Change connection string passwords

## Overview
This system now supports:
- **Overnight batch processing** of document suites from AWS S3
- **Scheduled email notifications** for FI requests
- **Building Info API integration** for project metadata
- **Queue-based job processing** for reliability

## Required Environment Configuration

### Email Configuration (SMTP)
You'll need an email provider. Here are common options:

#### Gmail (Recommended for testing)
```env
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-email@gmail.com
SMTP_PASS=your-app-password  # Generate this in Gmail settings
FROM_EMAIL=your-email@gmail.com
FROM_NAME=FI Email Automation
```

#### Office 365/Outlook
```env
SMTP_HOST=smtp-mail.outlook.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-email@outlook.com
SMTP_PASS=your-password
FROM_EMAIL=your-email@outlook.com
FROM_NAME=FI Email Automation
```

#### AWS SES (Production)
```env
SMTP_HOST=email-smtp.eu-north-1.amazonaws.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-ses-smtp-username
SMTP_PASS=your-ses-smtp-password
FROM_EMAIL=noreply@yourdomain.com
FROM_NAME=FI Email Automation
```

### Complete .env File
Your `.env` file should include all these variables:

> **Important**: Replace all placeholder values with your actual credentials

```env
NODE_ENV=development
PORT=3000

# Database
MONGODB_URI=mongodb+srv://username:password@cluster.mongodb.net/database

# JWT Configuration
JWT_SECRET=your-super-secure-jwt-secret-key-change-this-in-production
JWT_EXPIRES_IN=7d

# OpenAI Configuration
OPENAI_API_KEY=sk-your-openai-api-key

# Email Configuration (SMTP)
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-email@gmail.com
SMTP_PASS=your-app-password
FROM_EMAIL=your-email@gmail.com
FROM_NAME=FI Email Automation

# Building Info API Configuration
BUILDING_INFO_API_BASE_URL=https://api12.buildinginfo.com/api/v2/bi/projects/t-projects
BUILDING_INFO_API_KEY=your-building-info-api-key
BUILDING_INFO_API_UKEY=your-building-info-user-key

# AWS Configuration
AWS_ACCESS_KEY_ID=your-aws-access-key-id
AWS_SECRET_ACCESS_KEY=your-aws-secret-access-key
AWS_REGION=eu-north-1
S3_BUCKET=your-s3-bucket-name
S3_REGION=eu-north-1

# Job Queue Configuration
REDIS_URL=redis://localhost:6379
QUEUE_CONCURRENCY=3

# File Upload
MAX_FILE_SIZE=10485760
UPLOAD_DIR=./uploads
DOWNLOAD_DIR=./temp/downloads
```

## Required Infrastructure

### 1. Redis Server (Required for job queues)
#### Install Redis locally:
**Windows:**
```bash
# Using Chocolatey
choco install redis-64

# Or download from: https://github.com/microsoftarchive/redis/releases
```

**macOS:**
```bash
brew install redis
brew services start redis
```

**Ubuntu/Debian:**
```bash
sudo apt update
sudo apt install redis-server
sudo systemctl start redis-server
```

#### Or use Docker:
```bash
docker run -d -p 6379:6379 --name redis redis:alpine
```

### 2. Start the Application
```bash
cd backend
npm install
npm start
```

## API Usage Examples

### 1. Schedule Single Project Processing
```javascript
POST /api/jobs/schedule-project
{
  "projectId": "2460123",
  "reportTypes": ["acoustic", "transport"],
  "customerEmails": ["customer@example.com", "consultant@example.com"],
  "delay": 0  // Process immediately, or delay in milliseconds
}
```

### 2. Schedule Overnight Batch Processing
```javascript
POST /api/jobs/schedule-batch
{
  "projectIds": ["2460123", "2460124", "2460125"],
  "reportTypes": ["acoustic", "transport", "ecological"],
  "customerEmails": ["customer@example.com"],
  "scheduleTime": "2025-09-17T02:00:00.000Z"  // 2 AM tomorrow
}
```

### 3. List Available Projects in S3
```javascript
GET /api/jobs/s3/projects
// Returns: { success: true, data: { projects: ["2460123", "2460124", ...], count: 150 } }
```

### 4. Get Project Documents
```javascript
GET /api/jobs/s3/projects/2460123/documents
// Returns list of PDF documents for the project
```

### 5. Get Building Info API Data
```javascript
GET /api/jobs/building-info/2460123
// Returns project metadata from Building Info API
```

### 6. Monitor Job Status
```javascript
GET /api/jobs/stats
// Returns queue statistics and job counts
```

## Scheduling Options

### 1. Immediate Processing
```javascript
{
  "delay": 0  // Process immediately
}
```

### 2. Delayed Processing
```javascript
{
  "delay": 3600000  // Process in 1 hour (milliseconds)
}
```

### 3. Scheduled Processing
```javascript
{
  "scheduleTime": "2025-09-17T02:00:00.000Z"  // Process at specific time
}
```

## Workflow Overview

### Overnight Batch Processing Flow:
1. **Schedule batch job** via API with list of project IDs
2. **Job starts at scheduled time** (e.g., 2 AM)
3. **For each project:**
   - Download documents from S3
   - Get project metadata from Building Info API
   - Process documents for specified report types
   - Detect FI requests using AI
   - Create database records for FI requests found
   - Queue email notifications
4. **Send email notifications** to specified customers
5. **Cleanup temporary files**
6. **Log results** and completion status

### Email Template Data:
The system automatically populates email templates with:
- Project title and ID from Building Info API
- Planning authority information
- FI request details (deadline, specific requests)
- Link to dashboard for full details

## Monitoring and Management

### Queue Dashboard
The system provides endpoints to:
- Monitor job progress
- View queue statistics
- Cancel scheduled jobs
- Check processing errors

### Automatic Cleanup
The system includes scheduled cleanup jobs:
- **Daily (2 AM):** Clean up downloaded files and OCR cache
- **Weekly (Sunday 1 AM):** Clear Building Info API cache

## Error Handling
- **Failed jobs** are automatically retried with exponential backoff
- **Email failures** are logged but don't stop document processing
- **S3 download errors** skip the problematic document but continue processing
- **API timeouts** are handled gracefully with fallback data

## Scaling Considerations
- **Concurrent processing:** Configurable via `QUEUE_CONCURRENCY`
- **Rate limiting:** Built-in delays between API calls
- **Memory management:** Documents are processed one at a time and cleaned up
- **Queue persistence:** Redis ensures jobs survive application restarts

This system is now ready for production-scale overnight processing of hundreds of planning documents with automated FI detection and email notifications!