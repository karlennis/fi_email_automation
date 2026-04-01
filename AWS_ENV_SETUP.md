# AWS EC2 Environment Variables Setup Guide

## Quick Reference: Email Configuration

When deploying to AWS EC2, your email configuration must be set in two places:

### 1. **Local Development** (`.env` file in `backend/`)
Done ✅ - Already updated with your company mailbox credentials

```env
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=intel@buildinginfo.com
SMTP_PASS=iamr uvsv kfxy nzib
FROM_EMAIL=intel@buildinginfo.com
FROM_NAME=Building Information Ireland
REPLY_TO_EMAIL=support@buildinginfo.com
```

### 2. **AWS EC2 Production** (Two methods below)

## Method A: Direct File Edit on EC2 (Simplest)

```bash
# SSH into your EC2 instance
ssh -i your-key.pem ubuntu@your-elastic-ip

# Navigate to backend directory
cd /home/ubuntu/fi_email_automation/backend

# Create/edit .env file
sudo nano .env
```

**Paste this content** (replace with your values):
```env
NODE_ENV=production
PORT=3000

# Database
MONGODB_URI=mongodb+srv://your-user:your-pass@cluster.mongodb.net/fi_automation

# Redis
REDIS_URL=redis://localhost:6379

# AWS
AWS_ACCESS_KEY_ID=your_access_key
AWS_SECRET_ACCESS_KEY=your_secret_key
AWS_REGION=eu-north-1
S3_BUCKET=planning-documents-2
S3_REGION=eu-north-1

# Email Configuration (SMTP + Sender)
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=intel@buildinginfo.com
SMTP_PASS=iamr uvsv kfxy nzib
FROM_EMAIL=intel@buildinginfo.com
FROM_NAME=Building Information Ireland
REPLY_TO_EMAIL=support@buildinginfo.com

# OpenAI
OPENAI_API_KEY=your_openai_api_key

# Building Info API
BUILDING_INFO_API_BASE_URL=https://api12.buildinginfo.com/api/v2/bi/projects/t-projects
BUILDING_INFO_API_KEY=your_api_key
BUILDING_INFO_API_UKEY=your_ukey

# Application
FRONTEND_URL=https://your-domain.com
API_URL=https://your-domain.com/api
LOG_LEVEL=info
```

**Save & exit:** Press `Ctrl+X`, then `Y`, then `Enter`

## Method B: Environment Variables (Recommended for Security)

Instead of storing credentials in a file, use PM2's environment system:

```bash
# Set env vars in PM2
pm2 set app:SMTP_USER intel@buildinginfo.com
pm2 set app:SMTP_PASS "iamr uvsv kfxy nzib"
pm2 set app:FROM_EMAIL intel@buildinginfo.com
pm2 set app:FROM_NAME "Building Information Ireland"
pm2 set app:REPLY_TO_EMAIL support@buildinginfo.com
```

Or add to `ecosystem.config.js` in the production section:
```javascript
env: {
  NODE_ENV: 'production',
  SMTP_HOST: 'smtp.gmail.com',
  SMTP_PORT: 587,
  SMTP_SECURE: false,
  SMTP_USER: 'intel@buildinginfo.com',
  SMTP_PASS: 'iamr uvsv kfxy nzib',
  FROM_EMAIL: 'intel@buildinginfo.com',
  FROM_NAME: 'Building Information Ireland',
  REPLY_TO_EMAIL: 'support@buildinginfo.com'
}
```

## Method C: AWS Systems Manager Parameter Store (Most Secure)

Store sensitive values in AWS Parameter Store:

```bash
aws ssm put-parameter \
  --name /fi-email/smtp-user \
  --value "intel@buildinginfo.com" \
  --type SecureString

aws ssm put-parameter \
  --name /fi-email/smtp-pass \
  --value "iamr uvsv kfxy nzib" \
  --type SecureString
```

Then retrieve in your Node.js app:
```javascript
const AWS = require('aws-sdk');
const ssm = new AWS.SSM();

async function getSmtpCredentials() {
  const params = {
    Names: ['/fi-email/smtp-user', '/fi-email/smtp-pass'],
    WithDecryption: true
  };
  const response = await ssm.getParameters(params).promise();
  return response.Parameters.reduce((acc, p) => ({
    ...acc,
    [p.Name.split('/').pop()]: p.Value
  }), {});
}
```

## Deployment Steps

### 1. SSH to EC2
```bash
ssh -i your-key.pem ubuntu@your-elastic-ip
```

### 2. Navigate to project
```bash
cd /home/ubuntu/fi_email_automation
```

### 3. Update .env (Method A above)
```bash
cd backend
sudo nano .env  # or use vim
# Paste the environment variables
```

### 4. Stop any running processes
```bash
pm2 stop all
```

### 5. Pull latest code
```bash
cd /home/ubuntu/fi_email_automation
git pull origin main
```

### 6. Reinstall dependencies
```bash
cd backend && npm install
```

### 7. Start with PM2
```bash
cd /home/ubuntu/fi_email_automation
pm2 start ecosystem.config.js
pm2 save
```

### 8. Verify deployment
```bash
pm2 logs fi-email-backend

# Should see: "SMTP server is ready to take our messages"
```

## Testing Email on EC2

Once deployed, test the email configuration:

```bash
# SSH to EC2
ssh -i your-key.pem ubuntu@your-elastic-ip

# Connect to running app and test
curl -X POST http://localhost:3000/api/test/email \
  -H "Content-Type: application/json" \
  -d '{"email":"your-test-email@gmail.com"}'
```

Check logs:
```bash
pm2 logs fi-email-backend | grep -i smtp
pm2 logs fi-email-backend | grep -i "test email"
```

## Troubleshooting

### Email not sending?
1. Check SMTP credentials are correct
2. Verify app password is 16 characters (remove spaces if pasting)
3. Confirm 2-Step Verification is enabled on Google Account
4. Check logs: `pm2 logs fi-email-backend`

### Wrong sender showing?
- Check `FROM_EMAIL` and `FROM_NAME` env vars are set correctly
- Restart app: `pm2 restart fi-email-backend`
- Verify with: `echo $FROM_EMAIL` on EC2

### Connection refused error?
- Check SMTP_HOST and SMTP_PORT are correct
- Ensure EC2 security group allows outbound traffic on port 587
- Gmail SMTP may block from new IPs (check Gmail security alerts)

## What changed in the code?

All emails now use environment variables instead of hardcoded sender:

**Before:**
```javascript
from: `"Building Info Team" <noreply@buildinginfo.com>`
```

**After:**
```javascript
from: this.getFromAddress()  // Uses FROM_EMAIL + FROM_NAME from env
replyTo: this.getReplyToEmail()  // Uses REPLY_TO_EMAIL from env
```

This ensures:
- ✅ Sender matches authenticated mailbox (passes SPF)
- ✅ Company branding (FROM_NAME displays correctly)
- ✅ Replies go to support@buildinginfo.com (not test email)
- ✅ No more hardcoded values in code
