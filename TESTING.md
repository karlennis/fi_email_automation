# FI Email Automation - Testing Guide

This guide covers testing the FI Email Automation system end-to-end.

## Prerequisites

1. **Backend running** on `http://localhost:3000`
2. **Frontend running** on `http://localhost:4200`
3. **MongoDB** running and accessible
4. **OpenAI API key** configured
5. **SMTP credentials** configured (for email testing)

## Test Environment Setup

### 1. Start the Backend

```bash
cd backend
npm install
npm start
```

Verify backend is running:
- Visit `http://localhost:3000/health`
- Should return: `{"status":"OK","timestamp":"..."}`

### 2. Start the Frontend

```bash
cd frontend
npm install
ng serve
```

Verify frontend is running:
- Visit `http://localhost:4200`
- Should show the login page

### 3. Database Setup

Connect to MongoDB and create test data:

```javascript
// Connect to MongoDB
use fi-email-automation

// Create a test admin user (password: admin123)
db.users.insertOne({
  email: "admin@test.com",
  password: "$2b$10$rQJ8YQV8oVRmCjCjXxKqgOX8rL9mJCJmKrQqL3QqL3QqL3QqL3QqL3",
  role: "admin",
  createdAt: new Date(),
  updatedAt: new Date()
})

// Create test customers
db.customers.insertMany([
  {
    name: "Test Customer 1",
    email: "customer1@test.com",
    phone: "+1234567890",
    address: "123 Test St, Test City",
    isActive: true,
    subscriptions: ["planning_applications"],
    createdAt: new Date(),
    updatedAt: new Date()
  },
  {
    name: "Test Customer 2",
    email: "customer2@test.com",
    phone: "+1234567891",
    address: "456 Test Ave, Test City",
    isActive: true,
    subscriptions: ["planning_applications", "building_control"],
    createdAt: new Date(),
    updatedAt: new Date()
  }
])
```

## End-to-End Testing Scenarios

### Scenario 1: User Authentication

#### Test Steps:
1. **Login Test**
   - Navigate to `http://localhost:4200`
   - Enter credentials: `admin@test.com` / `admin123`
   - Click "Login"
   - **Expected**: Redirect to dashboard

2. **Dashboard Access**
   - Verify dashboard loads with statistics
   - Check recent activity feed
   - **Expected**: Dashboard shows system overview

3. **Logout Test**
   - Click user menu → Logout
   - **Expected**: Redirect to login page, token cleared

#### Test Registration (New User):
1. Click "Register" on login page
2. Fill form:
   - Email: `testuser@example.com`
   - Password: `testpass123`
   - Confirm Password: `testpass123`
3. Click "Register"
4. **Expected**: User created, redirect to dashboard

### Scenario 2: Document Upload and FI Detection

#### Prepare Test Documents:

Create test documents with FI content:

**test-fi-document.txt**:
```
PLANNING APPLICATION RESPONSE

Dear Applicant,

Further to your planning application ref: 2024/001, we require the following additional information:

1. Please provide a detailed flood risk assessment for the proposed development
2. Submit revised drawings showing the relationship to neighboring properties
3. Provide a transport statement addressing parking provisions
4. Submit a tree survey and arboricultural impact assessment

Please submit these documents within 21 days of this notice.

Regards,
Planning Department
```

**test-no-fi-document.txt**:
```
PLANNING APPLICATION APPROVAL

Dear Applicant,

We are pleased to inform you that your planning application ref: 2024/002 has been APPROVED subject to the following conditions:

1. Development must commence within 3 years
2. Materials must match existing building
3. No parking on the public highway

This approval is valid for 3 years from the date of this decision.

Regards,
Planning Department
```

#### Test Steps:

1. **Upload Document with FI**
   - Login as admin
   - Navigate to "Upload Document"
   - Upload `test-fi-document.txt`
   - Select customer: "Test Customer 1"
   - Add project ID: "TEST-001"
   - Click "Upload & Process"
   - **Expected**:
     - Upload progress shown
     - Processing notification appears
     - Document appears in FI Requests list
     - Status shows "FI Detected"

2. **Verify FI Detection Results**
   - Go to "FI Requests" page
   - Click on the processed document
   - **Expected**:
     - AI analysis shows FI detected: `true`
     - Lists 4 requirements found
     - Shows confidence scores
     - Email status shows "Pending" or "Sent"

3. **Upload Document without FI**
   - Upload `test-no-fi-document.txt`
   - Select customer: "Test Customer 2"
   - Add project ID: "TEST-002"
   - **Expected**:
     - Processing completes
     - Status shows "No FI Required"
     - No email triggered

### Scenario 3: Email Automation

#### Test Steps:

1. **Automatic Email Sending**
   - After uploading FI document (Scenario 2)
   - Check email logs in backend console
   - **Expected**: Email sent to customer automatically

2. **Manual Email Sending**
   - Go to FI Request detail page
   - Click "Send Email" button
   - **Expected**:
     - Email sent confirmation
     - Email status updated to "Sent"
     - Timestamp recorded

3. **Email Content Verification**
   - Check the recipient email inbox
   - **Expected Email Content**:
     - Subject contains project reference
     - Body lists all FI requirements
     - Professional formatting
     - Company branding (if configured)

#### Email Template Test:

Check that emails contain:
- ✅ Customer name personalization
- ✅ Project reference number
- ✅ List of FI requirements
- ✅ Clear call-to-action
- ✅ Contact information
- ✅ Professional formatting

### Scenario 4: Customer Management (Admin Only)

#### Test Steps:

1. **View Customers**
   - Navigate to "Customers" page
   - **Expected**: List of all customers with search/filter

2. **Add New Customer**
   - Click "Add Customer"
   - Fill form:
     - Name: "New Test Customer"
     - Email: "newcustomer@test.com"
     - Phone: "+1555123456"
     - Address: "789 New St"
   - Select subscriptions
   - Click "Save"
   - **Expected**: Customer added, appears in list

3. **Edit Customer**
   - Click edit button on existing customer
   - Modify details
   - Click "Update"
   - **Expected**: Changes saved and reflected

4. **Customer FI History**
   - Click "View" on customer with FI requests
   - **Expected**: Shows all FI requests for that customer

### Scenario 5: Advanced Features Testing

#### Test Document Reprocessing:
1. Go to FI Request detail page
2. Click "Reprocess Document"
3. **Expected**:
   - Document reanalyzed with current AI model
   - Results updated
   - Activity log shows reprocessing event

#### Test Filtering and Search:
1. Go to FI Requests page
2. Test filters:
   - Status filter (All, FI Detected, No FI, Pending)
   - Date range filter
   - Customer filter
3. Test search by project ID
4. **Expected**: Results filtered correctly

#### Test Pagination:
1. If you have many FI requests, test pagination
2. **Expected**: Proper page navigation and item counts

### Scenario 6: Error Handling and Edge Cases

#### Test File Upload Errors:

1. **Large File Upload**
   - Try uploading file > 10MB
   - **Expected**: Error message about file size limit

2. **Invalid File Type**
   - Try uploading `.exe` or other invalid file
   - **Expected**: Error message about unsupported file type

3. **Empty File**
   - Try uploading empty document
   - **Expected**: Graceful handling, appropriate message

#### Test API Errors:

1. **Network Disconnection**
   - Disconnect from internet during upload
   - **Expected**: Error handling with retry option

2. **Invalid Authentication**
   - Manually clear localStorage token
   - Try accessing protected route
   - **Expected**: Redirect to login

#### Test OpenAI API Issues:

1. **Invalid API Key**
   - Temporarily set invalid OpenAI key in backend
   - Upload document
   - **Expected**: Error message, document marked as failed

### Scenario 7: Performance Testing

#### Test Concurrent Operations:

1. **Multiple File Uploads**
   - Upload several documents simultaneously
   - **Expected**: All process correctly without conflicts

2. **Large Document Processing**
   - Upload large PDF (5-10MB)
   - **Expected**: Processing completes within reasonable time

#### Memory and Resource Usage:

1. Monitor backend process during testing
2. Check for memory leaks after multiple operations
3. Verify file cleanup after processing

## API Testing with Postman/curl

### Authentication Tests:

```bash
# Register new user
curl -X POST http://localhost:3000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"testpass123"}'

# Login
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@test.com","password":"admin123"}'

# Save the token from login response for subsequent requests
TOKEN="your-jwt-token-here"
```

### FI Request API Tests:

```bash
# Get all FI requests
curl -X GET http://localhost:3000/api/fi-requests \
  -H "Authorization: Bearer $TOKEN"

# Get specific FI request
curl -X GET http://localhost:3000/api/fi-requests/{id} \
  -H "Authorization: Bearer $TOKEN"

# Send email for FI request
curl -X POST http://localhost:3000/api/fi-requests/{id}/send-email \
  -H "Authorization: Bearer $TOKEN"
```

### Customer API Tests:

```bash
# Get all customers
curl -X GET http://localhost:3000/api/customers \
  -H "Authorization: Bearer $TOKEN"

# Create customer
curl -X POST http://localhost:3000/api/customers \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"API Test Customer","email":"api@test.com","phone":"+1234567890"}'
```

## Automated Testing Scripts

### Backend Unit Tests:

```bash
cd backend
npm test
```

### Frontend Unit Tests:

```bash
cd frontend
ng test
```

### E2E Tests with Playwright (Optional):

```javascript
// tests/e2e/fi-detection.spec.js
const { test, expect } = require('@playwright/test');

test('FI Detection Workflow', async ({ page }) => {
  // Login
  await page.goto('http://localhost:4200');
  await page.fill('[data-testid="email"]', 'admin@test.com');
  await page.fill('[data-testid="password"]', 'admin123');
  await page.click('[data-testid="login-button"]');

  // Upload document
  await page.goto('http://localhost:4200/upload');
  await page.setInputFiles('[data-testid="file-input"]', 'test-fi-document.txt');
  await page.selectOption('[data-testid="customer-select"]', 'Test Customer 1');
  await page.fill('[data-testid="project-id"]', 'TEST-E2E-001');
  await page.click('[data-testid="upload-button"]');

  // Verify processing
  await expect(page.locator('[data-testid="processing-status"]')).toContainText('Processing');

  // Check results
  await page.goto('http://localhost:4200/fi-requests');
  await expect(page.locator('[data-testid="fi-request-item"]').first()).toContainText('FI Detected');
});
```

## Testing Checklist

### Functional Tests:
- [ ] User registration and login
- [ ] Document upload (various file types)
- [ ] FI detection accuracy
- [ ] Email sending (automatic and manual)
- [ ] Customer management (CRUD operations)
- [ ] Dashboard statistics
- [ ] Search and filtering
- [ ] Pagination
- [ ] Document reprocessing

### Security Tests:
- [ ] Authentication required for protected routes
- [ ] Role-based access control (admin vs user)
- [ ] File upload restrictions
- [ ] SQL injection prevention
- [ ] XSS prevention
- [ ] CSRF protection

### Performance Tests:
- [ ] Large file upload handling
- [ ] Multiple concurrent users
- [ ] Database query performance
- [ ] Memory usage monitoring
- [ ] API response times

### Error Handling Tests:
- [ ] Network connection errors
- [ ] Invalid file uploads
- [ ] API service unavailability
- [ ] Database connection issues
- [ ] Invalid user inputs

### Browser Compatibility:
- [ ] Chrome (latest)
- [ ] Firefox (latest)
- [ ] Safari (latest)
- [ ] Edge (latest)
- [ ] Mobile responsiveness

## Test Data Cleanup

After testing, clean up test data:

```javascript
// Connect to MongoDB
use fi-email-automation

// Remove test data
db.firequests.deleteMany({ projectId: /TEST-/ })
db.customers.deleteMany({ email: /test\.com$/ })
db.users.deleteMany({ email: /test\.com$/ })
```

## Troubleshooting Common Test Issues

1. **Upload fails**: Check file permissions on uploads directory
2. **Emails not sending**: Verify SMTP configuration
3. **FI detection errors**: Check OpenAI API key and quota
4. **Database connection**: Ensure MongoDB is running
5. **CORS errors**: Check frontend/backend URL configuration

## Continuous Integration

For automated testing in CI/CD:

```yaml
# .github/workflows/test.yml
name: Test FI Email Automation

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest

    services:
      mongodb:
        image: mongo:5.0
        ports:
          - 27017:27017

    steps:
    - uses: actions/checkout@v2

    - name: Setup Node.js
      uses: actions/setup-node@v2
      with:
        node-version: '18'

    - name: Install backend dependencies
      run: cd backend && npm install

    - name: Run backend tests
      run: cd backend && npm test
      env:
        MONGODB_URI: mongodb://localhost:27017/test
        JWT_SECRET: test-secret
        OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}

    - name: Install frontend dependencies
      run: cd frontend && npm install

    - name: Run frontend tests
      run: cd frontend && ng test --watch=false --browsers=ChromeHeadless
```

This comprehensive testing guide should help ensure your FI Email Automation system works correctly across all scenarios and edge cases.
