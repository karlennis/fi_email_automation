# FI Email Automation Backend

A Node.js/Express API for detecting Further Information (FI) requests in planning documents and sending automated email notifications to customers.

## Features

- **AI-Powered FI Detection**: Uses OpenAI GPT-4o-mini to detect various types of FI requests in planning documents
- **Email Automation**: Automated email notifications to customers when FI requests are detected
- **Document Processing**: OCR and PDF text extraction capabilities
- **Customer Management**: Complete CRUD operations for customer data and subscriptions
- **Project Tracking**: Track planning projects and their associated documents
- **Authentication**: JWT-based authentication system
- **File Upload**: Secure document upload with validation

## Tech Stack

- **Runtime**: Node.js
- **Framework**: Express.js
- **Database**: MongoDB with Mongoose ODM
- **AI**: OpenAI GPT-4o-mini API
- **Email**: Nodemailer with SMTP
- **Authentication**: JWT with bcrypt
- **File Processing**: Multer, pdf-parse, OCR capabilities
- **Validation**: Joi
- **Logging**: Winston

## Installation

1. **Clone and Navigate**
   ```bash
   cd backend
   ```

2. **Install Dependencies**
   ```bash
   npm install
   ```

3. **Environment Setup**
   ```bash
   cp .env.template .env
   ```
   Then edit `.env` with your actual configuration values.

4. **Start MongoDB**
   Make sure MongoDB is running on your system.

5. **Start Development Server**
   ```bash
   npm run dev
   ```

## Health Check

The API exposes a `/health` endpoint for monitoring and load balancer checks:

- **Endpoint**: `GET /health`
- **Response**: `200 OK` with JSON status
- **Features**:
  - No authentication required
  - No rate limiting applied
  - No database dependency
  - Always returns quickly

**For Render.com deployment**: Set health check path to `/health` in service settings.

**IMPORTANT**: The health endpoint is registered BEFORE all middleware to prevent 429 rate limit errors that can cause service restarts.

The server will start on `http://localhost:3000` (or your configured PORT).

## Environment Variables

See `.env.template` for all required environment variables. Key ones include:

- `MONGODB_URI`: MongoDB connection string
- `JWT_SECRET`: Secret key for JWT tokens
- `OPENAI_API_KEY`: OpenAI API key for FI detection
- `SMTP_*`: Email configuration for notifications

## API Endpoints

### Authentication
- `POST /api/auth/register` - Register new user
- `POST /api/auth/login` - User login
- `GET /api/auth/profile` - Get user profile

### Customers
- `GET /api/customers` - List customers with filtering
- `POST /api/customers` - Create new customer
- `GET /api/customers/:id` - Get customer details
- `PUT /api/customers/:id` - Update customer
- `DELETE /api/customers/:id` - Delete customer

### FI Requests
- `POST /api/fi-requests/process` - Process document for FI detection
- `GET /api/fi-requests` - List FI requests
- `GET /api/fi-requests/:id` - Get FI request details
- `POST /api/fi-requests/:id/notify` - Send email notification

### Projects
- `GET /api/projects` - List projects with filtering
- `GET /api/projects/:id` - Get project details

### Documents
- `POST /api/documents/upload` - Upload document
- `GET /api/documents/:id` - Get document details

## FI Detection Types

The system can detect various types of Further Information requests:

- **Ecological Assessment**: EIA, AA screening, biodiversity reports
- **Traffic/Transportation**: Traffic impact, parking, access assessments
- **Engineering**: Structural, drainage, utilities reports
- **Heritage/Archaeology**: Archaeological, architectural heritage assessments
- **Environmental**: Noise, air quality, contamination studies
- **Landscape/Visual**: Visual impact, landscape assessments
- **Planning**: Design statements, compliance reports
- **Community**: Public consultation, social impact

## Development Scripts

- `npm run dev` - Start development server with nodemon
- `npm start` - Start production server
- `npm test` - Run tests (when implemented)

## Project Structure

```
backend/
├── models/          # MongoDB schemas
├── routes/          # API route handlers
├── services/        # Business logic services
├── middleware/      # Express middleware
├── templates/       # Email templates
├── uploads/         # File upload directory
├── server.js        # Main application file
└── package.json     # Dependencies and scripts
```

## Logging

The application uses Winston for structured logging. Logs include:
- API requests and responses
- FI detection results
- Email sending status
- Error tracking

## Security Features

- Rate limiting on all endpoints
- Helmet.js for security headers
- JWT token authentication
- Input validation with Joi
- File upload restrictions
- CORS configuration

## Email Templates

The system includes Handlebars email templates for:
- FI request notifications
- Welcome emails
- Customizable templates for different FI types

## Next Steps

1. Set up your environment variables
2. Configure MongoDB connection
3. Add your OpenAI API key
4. Configure SMTP email settings
5. Start the development server
6. Test with the Angular frontend (when available)

For production deployment, consider using services like:
- **Database**: MongoDB Atlas
- **Hosting**: Render, Railway, or Heroku
- **Email**: SendGrid, Mailgun, or AWS SES
