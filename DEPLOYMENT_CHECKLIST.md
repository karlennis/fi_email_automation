# Render Deployment Checklist

## Pre-Deployment Setup 

- [x] render.yaml created in project root
- [x] environment.prod.ts created for Angular production build
- [x] CORS configuration updated in backend/server.js
- [x] Angular build configuration updated with file replacements

## MongoDB Atlas Setup

- [ ] Create MongoDB Atlas account at https://www.mongodb.com/cloud/atlas
- [ ] Create a new cluster (free tier is fine)
- [ ] Create database user with password
- [ ] Configure network access (0.0.0.0/0 or specific Render IPs)
- [ ] Get connection string: `mongodb+srv://username:password@cluster.mongodb.net/fi-email-automation`

## Required Environment Variables

### Backend (Critical - App won''t work without these):
- [ ] MONGODB_URI - from MongoDB Atlas
- [ ] JWT_SECRET - generate random 32+ character string
- [ ] AWS_ACCESS_KEY_ID - your AWS credentials
- [ ] AWS_SECRET_ACCESS_KEY - your AWS credentials
- [ ] OPENAI_API_KEY - from OpenAI platform
- [ ] EMAIL_HOST - SMTP server (e.g., smtp.gmail.com)
- [ ] EMAIL_PORT - SMTP port (587 or 465)
- [ ] EMAIL_USER - your email address
- [ ] EMAIL_PASSWORD - email app password
- [ ] EMAIL_FROM_ADDRESS - sender email
- [ ] BUILDING_INFO_API_KEY - your building info API key
- [ ] BUILDING_INFO_API_URL - your building info API endpoint

### Frontend:
- [ ] API_URL - backend service URL (set after backend deploys)

## GitHub Repository

- [ ] All changes committed
- [ ] Changes pushed to main branch
- [ ] Repository accessible to Render

## Render Account Setup

- [ ] Create account at https://render.com
- [ ] Connect GitHub account
- [ ] Add payment method (required even for free tier)

## Deployment Steps

### Option 1: Blueprint Deployment (Easier)
1. [ ] Go to Render Dashboard
2. [ ] Click "New"  "Blueprint"
3. [ ] Select your GitHub repository
4. [ ] Render detects render.yaml
5. [ ] Review services (backend + frontend)
6. [ ] Click "Apply"
7. [ ] Wait for initial deployment (~10 minutes)

### Option 2: Manual Service Creation
1. [ ] Create backend service manually
2. [ ] Create frontend service manually
3. [ ] Configure build/start commands for each

## Post-Deployment Configuration

1. [ ] Note backend URL: https://fi-email-automation-backend.onrender.com
2. [ ] Note frontend URL: https://fi-email-automation-frontend.onrender.com
3. [ ] Update FRONTEND_URL in backend environment variables
4. [ ] Update API_URL in frontend environment variables
5. [ ] Redeploy both services if URLs changed

## Database Initialization

1. [ ] Open backend service shell in Render
2. [ ] Run: `cd backend && node scripts/initialize-admin.js`
3. [ ] Save admin credentials securely
4. [ ] Test login at frontend URL

## Verification

- [ ] Backend health check: https://fi-email-automation-backend.onrender.com/health
- [ ] Frontend loads: https://fi-email-automation-frontend.onrender.com
- [ ] Can login with admin credentials
- [ ] Can view projects/documents
- [ ] Can create scan jobs
- [ ] Can generate document registers
- [ ] Email notifications working (test with a scan job)

## Troubleshooting

If deployment fails:
- [ ] Check build logs in Render dashboard
- [ ] Verify all environment variables are set correctly
- [ ] Check MongoDB connection string format
- [ ] Ensure AWS credentials have S3 read permissions
- [ ] Check CORS configuration includes actual Render URLs

If services are slow:
- [ ] Consider upgrading to Starter plan ($7/month per service)
- [ ] Free tier spins down after 15 minutes of inactivity

## Optional Enhancements

- [ ] Set up custom domain
- [ ] Configure uptime monitoring (UptimeRobot, Pingdom)
- [ ] Set up error tracking (Sentry)
- [ ] Configure automated backups for MongoDB
- [ ] Set up CI/CD pipeline (automatic deploys on push)

## Deployment Complete! 

Your FI Email Automation system should now be live and accessible at:
- Frontend: https://fi-email-automation-frontend.onrender.com
- Backend API: https://fi-email-automation-backend.onrender.com

For detailed instructions, see RENDER_DEPLOYMENT.md
