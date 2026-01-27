# Render Deployment Guide

## Prerequisites

1. **MongoDB Atlas Account** (Free tier available)
   - Create a cluster at https://www.mongodb.com/cloud/atlas
   - Get your connection string (format: mongodb+srv://username:password@cluster.mongodb.net/fi-email-automation)
   - Whitelist Render IPs or use 0.0.0.0/0 (allow from anywhere)

2. **AWS Credentials**
   - AWS_ACCESS_KEY_ID
   - AWS_SECRET_ACCESS_KEY
   - Ensure your IAM user has S3 read permissions for planning-documents-2 bucket

3. **OpenAI API Key**
   - Get from https://platform.openai.com/api-keys

4. **Email Configuration** (Gmail SMTP or other)
   - EMAIL_HOST (e.g., smtp.gmail.com)
   - EMAIL_PORT (e.g., 587 or 465)
   - EMAIL_USER (your email)
   - EMAIL_PASSWORD (app password for Gmail)
   - EMAIL_FROM_ADDRESS

5. **Building Info API**
   - BUILDING_INFO_API_KEY
   - BUILDING_INFO_API_URL

## Step 1: Prepare Your GitHub Repository

1. Commit all changes:
   ```bash
   git add .
   git commit -m "Prepare for Render deployment"
   git push origin main
   ```

2. Ensure render.yaml is in the root of your repository

## Step 2: Deploy on Render

### Option A: Using render.yaml (Recommended)

1. Go to https://render.com and sign in
2. Click **"New"**  **"Blueprint"**
3. Connect your GitHub repository (karlennis/fi_email_automation)
4. Render will detect the render.yaml file
5. Click **"Apply"** to create both services

### Option B: Manual Service Creation

#### Backend Service:
1. Click **"New"**  **"Web Service"**
2. Connect your repository
3. Configure:
   - **Name**: fi-email-automation-backend
   - **Region**: Frankfurt
   - **Branch**: main
   - **Root Directory**: Leave empty
   - **Build Command**: `cd backend && npm install`
   - **Start Command**: `cd backend && npm start`
   - **Plan**: Starter ($7/month) or Free

#### Frontend Service:
1. Click **"New"**  **"Web Service"**
2. Connect your repository
3. Configure:
   - **Name**: fi-email-automation-frontend
   - **Region**: Frankfurt
   - **Branch**: main
   - **Root Directory**: Leave empty
   - **Build Command**: `cd frontend && npm install && npm run build`
   - **Start Command**: `cd frontend && npm run serve:ssr:frontend`
   - **Plan**: Starter ($7/month) or Free

## Step 3: Configure Environment Variables

### Backend Environment Variables (REQUIRED):

Set these in Render Dashboard  Backend Service  Environment:

```
NODE_ENV=production
PORT=3001
MONGODB_URI=mongodb+srv://username:password@cluster.mongodb.net/fi-email-automation
JWT_SECRET=<generate-random-string-min-32-chars>
AWS_ACCESS_KEY_ID=<your-aws-key>
AWS_SECRET_ACCESS_KEY=<your-aws-secret>
AWS_REGION=eu-north-1
AWS_S3_BUCKET=planning-documents-2
OPENAI_API_KEY=<your-openai-key>
EMAIL_HOST=smtp.gmail.com
EMAIL_PORT=587
EMAIL_SECURE=true
EMAIL_USER=<your-email>
EMAIL_PASSWORD=<your-email-app-password>
EMAIL_FROM_ADDRESS=<your-email>
EMAIL_FROM_NAME=FI Email Automation
BUILDING_INFO_API_KEY=<your-building-api-key>
BUILDING_INFO_API_URL=<your-building-api-url>
FRONTEND_URL=https://fi-email-automation-frontend.onrender.com
RATE_LIMIT_WINDOW_MS=900000
RATE_LIMIT_MAX_REQUESTS=100
```

### Frontend Environment Variables:

```
NODE_ENV=production
PORT=4000
API_URL=https://fi-email-automation-backend.onrender.com
```

## Step 4: Update Service URLs (If Needed)

After deployment, Render will provide URLs for your services. If they differ from the defaults:

1. Update `FRONTEND_URL` in backend environment variables
2. Update `API_URL` in frontend environment variables
3. Update frontend/src/environments/environment.prod.ts if needed
4. Redeploy both services

## Step 5: Initialize Database

Once the backend is deployed and running:

1. Use Render Shell (Dashboard  Backend Service  Shell) or connect via SSH
2. Run the admin initialization script:
   ```bash
   cd backend
   node scripts/initialize-admin.js
   ```
3. Note the generated admin password

## Step 6: Verify Deployment

1. **Backend Health Check**: Visit https://fi-email-automation-backend.onrender.com/health
   - Should return: `{"status":"OK","timestamp":"...","environment":"production"}`

2. **Frontend**: Visit https://fi-email-automation-frontend.onrender.com
   - Should load the login page

3. **Login**: Use admin credentials to test full functionality

## Important Notes

### Free Tier Limitations:
- Services spin down after 15 minutes of inactivity
- First request after spin-down takes 30-60 seconds
- 750 hours/month free (requires credit card)

### Starter Plan Benefits ($7/month per service):
- Always-on (no spin-down)
- Better performance
- More memory and CPU

### Database Considerations:
- MongoDB Atlas Free tier: 512MB storage
- Upgrade if you exceed storage limits
- Consider automated backups

### Performance:
- Backend build takes ~2-3 minutes
- Frontend build takes ~3-5 minutes
- Total deployment time: ~10 minutes

### Debugging:
- Check logs: Dashboard  Service  Logs
- Use Shell: Dashboard  Service  Shell
- Health endpoint: /health

## Troubleshooting

### Build Failures:
- Check Node version compatibility (should use Node 18+)
- Verify package.json scripts
- Check build logs for missing dependencies

### MongoDB Connection Issues:
- Verify connection string format
- Check IP whitelist in Atlas
- Ensure network access is configured

### CORS Errors:
- Verify FRONTEND_URL in backend matches actual frontend URL
- Check backend logs for CORS-related errors

### Environment Variable Issues:
- Ensure all REQUIRED variables are set
- Check for typos in variable names
- Restart service after changing variables

## Post-Deployment Tasks

1. **Setup Monitoring**:
   - Configure uptime monitoring (e.g., UptimeRobot)
   - Set up error tracking (optional: Sentry)

2. **SSL/HTTPS**:
   - Render provides free SSL certificates automatically
   - All URLs use HTTPS by default

3. **Custom Domain** (Optional):
   - Add custom domain in Render dashboard
   - Update DNS records as instructed
   - Update FRONTEND_URL and API_URL accordingly

4. **Backup Strategy**:
   - Configure MongoDB Atlas automated backups
   - Export critical data regularly

## Cost Estimation

- **Free Tier**: $0/month (with spin-down limitations)
- **Starter Plan**: $14/month (backend + frontend, always-on)
- **MongoDB Atlas**: Free tier sufficient for development/testing
- **Total Minimum**: $0-14/month depending on plan choice

## Support

- Render Documentation: https://render.com/docs
- MongoDB Atlas Docs: https://docs.atlas.mongodb.com
- GitHub Issues: Create issue in your repository for bugs

