# FI Email Automation System

A comprehensive system for automatically detecting Further Information (FI) requests in planning documents and sending targeted email notifications to customers based on their report type preferences.

## 🚀 Features

- **AI-Powered FI Detection**: Uses OpenAI GPT-4o-mini to detect FI requests in planning documents with high accuracy
- **OCR Processing**: Integrated OCR capabilities using ocrmypdf for scanned documents
- **Batch Email Notifications**: Consolidated email notifications with deduplicated project listings
- **Customer Management**: Track customers and their report type preferences
- **Real-time Processing**: Monitor local project folders and process documents automatically
- **Dashboard Interface**: Clean Angular frontend for document browsing and customer management
- **Building Info Integration**: Enhanced metadata retrieval from Building Info API

## 🏗️ Architecture

### Backend (Node.js/Express)
- **FI Detection Service**: Core AI detection engine matching rag_pipeline reliability standards
- **Email Service**: Handlebars-templated email notifications with professional formatting
- **Customer Service**: Customer creation and management
- **Building Info Service**: Enhanced metadata integration
- **Document Processing**: Batch processing with S3 integration

### Frontend (Angular)
- **Dashboard**: Overview and quick actions
- **Document Browser**: File exploration and processing interface
- **Customer Management**: Admin interface for customer tracking
- **Authentication**: JWT-based auth system

### Database (MongoDB)
- Customer tracking and preferences
- Project metadata and processing history
- Email notification logs

## 📋 Prerequisites

- Node.js 16+ 
- MongoDB
- Python 3.8+ (for OCR)
- OpenAI API key
- SMTP server credentials
- ocrmypdf (`pip install ocrmypdf`)

## 🔧 Installation

1. **Clone the repository**
   ```bash
   git clone https://github.com/karlennis/fi_email_automation.git
   cd fi_email_automation
   ```

2. **Install backend dependencies**
   ```bash
   cd backend
   npm install
   ```

3. **Install frontend dependencies**
   ```bash
   cd frontend
   npm install
   ```

4. **Install OCR dependencies**
   ```bash
   pip install ocrmypdf
   ```

5. **Set up environment variables**
   
   Create `backend/.env`:
   ```env
   # Database
   MONGODB_URI=mongodb://localhost:27017/fi-email-automation
   
   # OpenAI
   OPENAI_API_KEY=your_openai_api_key_here
   
   # Email Configuration
   SMTP_HOST=smtp.gmail.com
   SMTP_PORT=587
   SMTP_USER=your-email@gmail.com
   SMTP_PASS=your-email-password
   
   # JWT
   JWT_SECRET=your-super-secret-jwt-key
   
   # URLs
   FRONTEND_URL=http://localhost:4200
   
   # Building Info API
   BII_API_BASE_URL=https://api.buildinginfo.com
   BII_API_KEY=your_bii_api_key
   
   # AWS S3 (optional)
   AWS_ACCESS_KEY_ID=your_aws_key
   AWS_SECRET_ACCESS_KEY=your_aws_secret
   AWS_REGION=eu-west-1
   S3_BUCKET_NAME=your-bucket-name
   ```

## 🚀 Usage

1. **Start the backend**
   ```bash
   cd backend
   npm start
   ```

2. **Start the frontend**
   ```bash
   cd frontend
   npm start
   ```

3. **Access the application**
   - Frontend: http://localhost:4200
   - Backend API: http://localhost:3000

## 📧 Email Features

- **Consolidated Notifications**: One email per customer per batch run
- **Deduplicated Projects**: No duplicate project listings in emails
- **Professional Formatting**: Clean Handlebars templates with proper styling
- **Masked Sender**: Emails appear from "FI Monitoring Team <noreply@buildinginfo.com>"
- **Enhanced Metadata**: Full project details from Building Info API

## 🔍 FI Detection

The system uses a sophisticated AI pipeline to:

1. **Detect FI Requests**: Identify formal Further Information requests from planning authorities
2. **Match Report Types**: Determine if requests relate to specific report types (acoustic, transport, ecological, etc.)
3. **Extract Information**: Pull key details like requesting authority, deadlines, and specific requirements

## 📁 Project Structure

```
fi-email-automation/
├── backend/
│   ├── models/          # MongoDB models
│   ├── routes/          # API endpoints
│   ├── services/        # Business logic
│   ├── middleware/      # Auth and validation
│   └── templates/       # Email templates
├── frontend/
│   ├── src/app/
│   │   ├── components/  # Angular components
│   │   ├── services/    # HTTP services
│   │   └── models/      # TypeScript interfaces
└── README.md
```

## 🔐 Authentication

The system uses JWT-based authentication with role-based access:
- **Admin**: Full access to customer management and system settings
- **User**: Access to document processing and basic features

## 🧪 Testing

Run tests for both backend and frontend:

```bash
# Backend tests
cd backend
npm test

# Frontend tests  
cd frontend
npm test
```

## 📝 API Endpoints

### Documents
- `POST /api/documents-browser/process-local-batch` - Process local document batch
- `POST /api/documents-browser/process-batch` - Process remote document batch
- `GET /api/documents-browser/local-projects` - List local projects

### Customers
- `GET /api/customers` - List all customers
- `POST /api/customers` - Create new customer
- `PUT /api/customers/:id` - Update customer
- `DELETE /api/customers/:id` - Delete customer

### Authentication
- `POST /api/auth/login` - User login
- `POST /api/auth/register` - User registration
- `GET /api/auth/me` - Get current user

## 🚀 Deployment

### Quick Deploy Options

#### **Option 1: AWS EC2 (Recommended - $28/month)**
Best for cost-conscious deployments with full control.

```bash
# Automated setup
bash setup-aws-infrastructure.sh

# Then SSH and run:
bash deploy-ec2.sh
```
📚 **Full Guide**: [EC2_DEPLOYMENT.md](EC2_DEPLOYMENT.md)  
📋 **Quick Start**: [EC2_QUICKSTART.md](EC2_QUICKSTART.md)  
📊 **Monitoring**: [EC2_MONITORING.md](EC2_MONITORING.md)

**Cost**: ~$28/month (EC2 t4g.medium + EBS)

#### **Option 2: Docker Compose**
Self-contained deployment with all services.

```bash
docker-compose up -d
```
Includes: Backend, Worker, Frontend, Redis, Nginx

#### **Option 3: Render (Current)**
Managed platform with automatic scaling.

- Backend: `backend/server.js` (Node.js 18)
- Worker: `backend/worker.js` (background tasks)
- Frontend: `frontend` (Angular 17)

Deployed at: https://fi-email-automation-backend-xvqm.onrender.com

**Cost**: $85/month (Pro plan)

### Production Setup Checklist

- [ ] MongoDB Atlas cluster configured (or self-hosted)
- [ ] Redis running (docker/local/Redis Labs)
- [ ] OpenAI API key obtained
- [ ] SMTP credentials configured
- [ ] S3 bucket accessible (AWS credentials)
- [ ] Building Info API configured
- [ ] SSL certificate configured
- [ ] Domain DNS updated
- [ ] Environment variables set (see `.env.example`)
- [ ] Backend deployed and running
- [ ] Frontend built and deployed
- [ ] Worker process running
- [ ] Monitoring/alerts configured

### Environment Variables Required

```bash
# Database
MONGODB_URI=mongodb+srv://user:pass@cluster.mongodb.net/db

# AWS S3
AWS_ACCESS_KEY_ID=your_key
AWS_SECRET_ACCESS_KEY=your_secret
S3_BUCKET=planning-documents-2
AWS_REGION=eu-north-1

# OpenAI
OPENAI_API_KEY=sk-...

# Email (SMTP)
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your-email@gmail.com
SMTP_PASS=app-password

# Building Info API
BUILDING_INFO_API_BASE_URL=https://api.example.com
BUILDING_INFO_API_KEY=your_key
BUILDING_INFO_API_UKEY=your_ukey

# Application
NODE_ENV=production
PORT=3000
FRONTEND_URL=https://your-domain.com
API_URL=https://your-domain.com/api
```

### Performance Optimization

Application includes memory-optimized document processing:

- **Streaming PDF Extraction**: One-page-at-a-time processing
- **Automatic Garbage Collection**: Global GC every 5 documents
- **Buffer Cleanup**: Explicit memory nulling after processing
- **Text Limiting**: 32KB max per document (prevents accumulation)

See [MEMORY_OPTIMIZATION.md](MEMORY_OPTIMIZATION.md) for details.

**Expected Memory Usage:**
- Backend process: 200-300MB stable
- Worker process: 200-300MB stable
- Total with system: ~800-1000MB

### Scaling

**Single Instance Limits:**
- Documents/hour: ~300 (depends on document size)
- Concurrent API requests: ~50
- Memory: Stable under 1GB

**To Scale Up:**
1. Upgrade to t4g.large (4 vCPU, 8GB RAM) - same code
2. Or add second t4g.medium behind load balancer
3. Or increase GC frequency in optimizedPdfExtractor.js

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature-name`
3. Make your changes
4. Run tests: `npm test`
5. Commit changes: `git commit -am 'Add feature'`
6. Push to branch: `git push origin feature-name`
7. Submit a pull request

## 📄 License

This project is proprietary software. All rights reserved.

## 🆘 Support

For support and questions, please contact the development team or create an issue in the repository.

## 🔄 Recent Updates

- ✅ Enhanced FI detection with rag_pipeline compatibility
- ✅ Batch email notifications with project deduplication
- ✅ Eliminated FI requests page for cleaner customer-centric workflow
- ✅ Professional email formatting with masked sender
- ✅ Real-time OCR processing integration
- ✅ Building Info API enhanced metadata integration