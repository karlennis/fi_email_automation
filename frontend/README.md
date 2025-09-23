# FI Email Automation - Frontend

Angular 17 application for managing Further Information (FI) request detection and email automation.

## Features

- **Authentication System**: Login/register with JWT-based auth
- **Document Upload**: Drag & drop interface for PDF/DOC files
- **FI Detection**: AI-powered detection of Further Information requests
- **Email Automation**: Automated customer notifications
- **Customer Management**: Admin interface for managing customers
- **Dashboard**: Overview of requests, statistics, and recent activity
- **Responsive Design**: Works on desktop and mobile devices

## Prerequisites

- Node.js (v18 or higher)
- Angular CLI (v17)
- Backend API running on http://localhost:3000

## Installation

1. Install dependencies:
```bash
npm install
```

2. Start the development server:
```bash
ng serve
```

3. Open your browser to `http://localhost:4200`

## Build for Production

```bash
ng build --configuration production
```

## Project Structure

```
src/
├── app/
│   ├── components/           # UI Components
│   │   ├── auth/            # Login/Register components
│   │   ├── dashboard/       # Dashboard component
│   │   ├── document-upload/ # File upload component
│   │   ├── fi-requests/     # FI request list/detail components
│   │   ├── customers/       # Customer management components
│   │   └── shared/          # Shared components (navbar)
│   ├── services/            # Angular services
│   │   ├── auth.service.ts  # Authentication service
│   │   ├── customer.service.ts
│   │   └── fi-request.service.ts
│   ├── guards/              # Route guards
│   │   ├── auth.guard.ts    # Authentication guard
│   │   └── admin.guard.ts   # Admin role guard
│   ├── app.routes.ts        # Application routing
│   └── app.config.ts        # App configuration
└── ...
```

## Key Components

### Authentication
- Login/Register forms with validation
- JWT token management
- Role-based access control (admin/user)

### Document Upload
- Drag & drop file interface
- File validation (PDF, DOC, DOCX up to 10MB)
- Progress tracking during upload
- Automatic FI processing after upload

### FI Requests Management
- List view with filtering and pagination
- Detailed view showing AI analysis results
- Email sending capabilities
- Reprocessing options

### Customer Management (Admin Only)
- Customer CRUD operations
- Subscription management
- Email notification history

### Dashboard
- Statistics overview
- Recent activity feed
- Quick action buttons

## API Integration

The frontend connects to the Node.js backend API:

- **Base URL**: `http://localhost:3000/api`
- **Authentication**: JWT Bearer tokens
- **Endpoints**:
  - `/auth/*` - Authentication
  - `/fi-requests/*` - FI request management
  - `/customers/*` - Customer management
  - `/documents/*` - Document processing

## Environment Configuration

The application is configured to work with:
- Backend API on `http://localhost:3000`
- Development build with source maps
- SSR (Server-Side Rendering) support
- Angular Material components
- Toastr notifications

## Deployment

For production deployment:

1. Build the application:
```bash
ng build --configuration production
```

2. Deploy the `dist/frontend` folder to your web server

3. Configure the API base URL in the services if needed

4. Ensure proper routing configuration for SPA

## Development Commands

```bash
# Start development server
ng serve

# Run tests
ng test

# Run linting
ng lint

# Build for production
ng build --prod
```

This project was generated with [Angular CLI](https://github.com/angular/angular-cli) version 17.3.13.
