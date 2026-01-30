# AWS EC2 Deployment Guide

## Overview
Migrating from Render to AWS EC2 for cost savings while maintaining reliability. Using t4g.medium instance (~$25-30/month) with your existing AWS account.

## Instance Setup

### 1. Launch EC2 Instance

**Instance Type:** `t4g.medium`
- 2 vCPU (ARM64)
- 4GB RAM
- EBS: 30GB gp3 root volume
- Region: Same as your S3 bucket (eu-north-1 recommended for consistency)
- OS: Ubuntu 22.04 LTS (Arm64)

**Security Group Rules:**
```
Inbound:
  - SSH (22): Your IP only
  - HTTP (80): 0.0.0.0/0 (for Let's Encrypt ACME challenges)
  - HTTPS (443): 0.0.0.0/0
Outbound:
  - All traffic allowed
```

**Network Configuration:**
- VPC: Default or your existing
- Auto-assign public IP: Yes
- Monitoring: Enable detailed CloudWatch monitoring

### 2. Elastic IP
Allocate an Elastic IP to keep the same IP if instance restarts.

### 3. Security Credentials
Create/use IAM user with S3 and CloudWatch permissions:
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject",
        "s3:ListBucket"
      ],
      "Resource": [
        "arn:aws:s3:::planning-documents-2",
        "arn:aws:s3:::planning-documents-2/*"
      ]
    },
    {
      "Effect": "Allow",
      "Action": [
        "cloudwatch:PutMetricData",
        "logs:CreateLogGroup",
        "logs:CreateLogStream",
        "logs:PutLogEvents"
      ],
      "Resource": "*"
    }
  ]
}
```

## Instance Configuration

### 4. Connect & Update

```bash
ssh -i your-key.pem ubuntu@your-elastic-ip

# Update system
sudo apt update && sudo apt upgrade -y

# Install Node.js 20 (LTS)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs git redis-server

# Install MongoDB (if self-hosted; recommended: use MongoDB Atlas instead)
# OR use MongoDB Atlas (free tier available)

# Install PM2 for process management
sudo npm install -g pm2

# Install Docker (optional, for containerized deployment)
sudo apt install -y docker.io
sudo usermod -aG docker ubuntu
```

### 5. Clone Repository

```bash
cd /home/ubuntu
git clone https://github.com/karlennis/fi_email_automation.git
cd fi_email_automation
```

### 6. Environment Setup

Create `.env` file in `/home/ubuntu/fi_email_automation/backend/.env`:

```env
# Database
MONGODB_URI=mongodb+srv://your-user:your-pass@cluster.mongodb.net/fi_automation?retryWrites=true
# OR local: mongodb://localhost:27017/fi_automation

# Redis
REDIS_URL=redis://localhost:6379

# AWS
AWS_ACCESS_KEY_ID=your_access_key
AWS_SECRET_ACCESS_KEY=your_secret_key
AWS_REGION=eu-north-1
S3_BUCKET=planning-documents-2
S3_REGION=eu-north-1

# Email (SMTP)
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-email@gmail.com
SMTP_PASS=your-app-password

# OpenAI
OPENAI_API_KEY=your_openai_api_key

# Building Info API
BUILDING_INFO_API_BASE_URL=https://api.example.com
BUILDING_INFO_API_KEY=your_api_key
BUILDING_INFO_API_UKEY=your_ukey

# Application
NODE_ENV=production
PORT=3000
FRONTEND_URL=https://your-domain.com
API_URL=https://your-domain.com/api

# Scan Configuration
SCAN_SCHEDULER_ENABLED=true
SCAN_INTERVAL_MINUTES=60

# Logging
LOG_LEVEL=info
```

### 7. Install Dependencies

```bash
cd /home/ubuntu/fi_email_automation
npm install
cd backend && npm install
cd ../frontend && npm install --include=dev
cd ..
```

### 8. Build Frontend

```bash
cd frontend
npm run build
cd ..
```

### 9. Setup PM2 Ecosystem

Create `ecosystem.config.js` in project root:

```javascript
module.exports = {
  apps: [
    {
      name: 'fi-email-backend',
      script: './backend/server.js',
      instances: 2,
      exec_mode: 'cluster',
      node_args: '--expose-gc --max-old-space-size=1536',
      env: {
        NODE_ENV: 'production'
      },
      error_file: '/var/log/fi_email/backend-error.log',
      out_file: '/var/log/fi_email/backend-out.log',
      log_file: '/var/log/fi_email/backend-combined.log',
      time_format: 'YYYY-MM-DD HH:mm:ss Z',
      max_memory_restart: '1G',
      autorestart: true,
      max_restarts: 10,
      min_uptime: '30s'
    },
    {
      name: 'fi-email-worker',
      script: './backend/worker.js',
      instances: 1,
      exec_mode: 'fork',
      node_args: '--expose-gc --max-old-space-size=1536',
      env: {
        NODE_ENV: 'production'
      },
      error_file: '/var/log/fi_email/worker-error.log',
      out_file: '/var/log/fi_email/worker-out.log',
      log_file: '/var/log/fi_email/worker-combined.log',
      time_format: 'YYYY-MM-DD HH:mm:ss Z',
      max_memory_restart: '1.2G',
      autorestart: true,
      max_restarts: 10,
      min_uptime: '30s'
    },
    {
      name: 'fi-email-frontend',
      script: 'npx serve -s frontend/dist/frontend/browser -l 4000',
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production'
      },
      error_file: '/var/log/fi_email/frontend-error.log',
      out_file: '/var/log/fi_email/frontend-out.log',
      log_file: '/var/log/fi_email/frontend-combined.log',
      time_format: 'YYYY-MM-DD HH:mm:ss Z',
      autorestart: true,
      max_restarts: 5,
      min_uptime: '30s'
    }
  ]
};
```

### 10. Create Log Directory

```bash
sudo mkdir -p /var/log/fi_email
sudo chown ubuntu:ubuntu /var/log/fi_email
```

### 11. Start Services with PM2

```bash
cd /home/ubuntu/fi_email_automation

# Start all processes
pm2 start ecosystem.config.js

# Set up auto-startup
sudo pm2 startup
pm2 save

# Monitor
pm2 monit
pm2 logs
```

## Web Server Setup (Nginx)

### 12. Install & Configure Nginx

```bash
sudo apt install -y nginx certbot python3-certbot-nginx

# Create nginx config
sudo nano /etc/nginx/sites-available/fi_email_automation
```

Add this configuration:

```nginx
upstream backend {
    server localhost:3000;
    server localhost:3000;  # PM2 cluster instances
}

upstream frontend {
    server localhost:4000;
}

server {
    listen 80;
    server_name your-domain.com;
    
    # Let's Encrypt ACME challenge
    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }
    
    # Redirect all HTTP to HTTPS
    location / {
        return 301 https://$server_name$request_uri;
    }
}

server {
    listen 443 ssl http2;
    server_name your-domain.com;
    
    ssl_certificate /etc/letsencrypt/live/your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-domain.com/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    ssl_prefer_server_ciphers on;
    
    client_max_body_size 100M;
    proxy_connect_timeout 60s;
    proxy_send_timeout 60s;
    proxy_read_timeout 60s;
    
    # Backend API
    location /api/ {
        proxy_pass http://backend;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
    
    # Frontend
    location / {
        proxy_pass http://frontend;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        
        # Angular routing - send 404s to index.html
        error_page 404 =200 /index.html;
    }
    
    # Gzip compression
    gzip on;
    gzip_types text/html text/plain text/css application/json application/javascript;
    gzip_min_length 1000;
}
```

Enable the site:

```bash
sudo ln -s /etc/nginx/sites-available/fi_email_automation /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx
```

### 13. Setup SSL Certificate

```bash
sudo mkdir -p /var/www/certbot
sudo certbot certonly --webroot -w /var/www/certbot -d your-domain.com
sudo certbot renew --dry-run  # Test auto-renewal
sudo systemctl enable certbot.timer
```

## Database Setup (Recommended: MongoDB Atlas)

### Option A: MongoDB Atlas (Recommended)
1. Go to https://www.mongodb.com/cloud/atlas
2. Create free cluster (512MB - suitable for your needs)
3. Get connection string: `mongodb+srv://user:pass@cluster.mongodb.net/dbname?retryWrites=true`
4. Add to `.env` as `MONGODB_URI`

### Option B: Self-Hosted MongoDB on EC2
```bash
sudo apt install -y mongodb
sudo systemctl enable mongodb
sudo systemctl start mongodb
# Update MONGODB_URI=mongodb://localhost:27017/fi_automation in .env
```

## Redis Setup

```bash
sudo systemctl enable redis-server
sudo systemctl start redis-server
redis-cli ping  # Should return PONG
```

## Monitoring & Logging

### 14. CloudWatch Logs (Optional but Recommended)

Install CloudWatch agent:

```bash
wget https://s3.amazonaws.com/amazoncloudwatch-agent/ubuntu/arm64/latest/amazon-cloudwatch-agent.deb
sudo dpkg -i -E ./amazon-cloudwatch-agent.deb
```

Create config at `/opt/aws/amazon-cloudwatch-agent/etc/config.json`:

```json
{
  "logs": {
    "logs_collected": {
      "files": {
        "collect_list": [
          {
            "file_path": "/var/log/fi_email/backend-combined.log",
            "log_group_name": "/aws/ec2/fi_email/backend",
            "log_stream_name": "{instance_id}"
          },
          {
            "file_path": "/var/log/fi_email/worker-combined.log",
            "log_group_name": "/aws/ec2/fi_email/worker",
            "log_stream_name": "{instance_id}"
          }
        ]
      }
    }
  }
}
```

Start agent:

```bash
sudo /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl \
  -a query -m ec2 -c file:/opt/aws/amazon-cloudwatch-agent/etc/config.json -s
```

## Monitoring Commands

```bash
# View all processes
pm2 list

# Monitor in real-time
pm2 monit

# View logs
pm2 logs fi-email-backend
pm2 logs fi-email-worker
pm2 logs fi-email-frontend

# Check memory usage
free -h
ps aux | grep node

# Check disk space
df -h

# Check instance metrics
aws cloudwatch get-metric-statistics \
  --namespace AWS/EC2 \
  --metric-name CPUUtilization \
  --dimensions Name=InstanceId,Value=i-xxxxx \
  --start-time 2026-01-30T00:00:00Z \
  --end-time 2026-01-30T23:59:59Z \
  --period 300 \
  --statistics Average
```

## Cost Breakdown (Monthly)

| Component | Cost |
|-----------|------|
| t4g.medium instance | $25.33 |
| EBS 30GB gp3 | $2.40 |
| Data transfer (estimate) | $0-1 |
| **Total** | **~$28/month** |

vs Render Pro: $85/month = **57% savings**

## Scaling Notes

If you need more capacity:
- **t4g.large** (~$50/month): 4 vCPU, 8GB RAM
- **Add more instances behind load balancer**: Keep t4g.medium, add horizontal scaling with ELB

## Emergency Procedures

### Restart all services
```bash
pm2 restart all
```

### View recent crashes
```bash
pm2 logs --err
```

### Full restart (if needed)
```bash
pm2 stop all
# Fix issue
pm2 start all
```

### Recovery from low disk space
```bash
# Clear old logs
sudo journalctl --vacuum=50M

# Clear PM2 logs
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 10
```

## Domain Setup

Update your domain's DNS to point to the Elastic IP:

```
A record: your-domain.com → your-elastic-ip
CNAME: www.your-domain.com → your-domain.com
```

## Migration Checklist

- [ ] EC2 instance launched (t4g.medium, Ubuntu 22.04)
- [ ] Security group configured (SSH, HTTP, HTTPS)
- [ ] Elastic IP allocated
- [ ] Node.js 20 installed
- [ ] Repository cloned
- [ ] `.env` file created with all variables
- [ ] Dependencies installed (`npm install` in backend, frontend)
- [ ] Frontend built (`npm run build`)
- [ ] MongoDB configured (Atlas or self-hosted)
- [ ] Redis started
- [ ] PM2 ecosystem configured
- [ ] PM2 services started
- [ ] Nginx configured
- [ ] SSL certificate issued
- [ ] Domain DNS updated
- [ ] Services verified running
- [ ] Memory/CPU monitoring configured
- [ ] CloudWatch logs configured (optional)
- [ ] Backup strategy implemented

## Post-Deployment Testing

```bash
# Test backend API
curl https://your-domain.com/api/health

# Test frontend
curl https://your-domain.com

# Check service status
pm2 list

# Monitor memory (should stay ~200-300MB per backend worker)
pm2 monit
```

## Support & Troubleshooting

**Backend won't start:**
```bash
pm2 logs fi-email-backend --err
# Check: env vars, MongoDB connection, Redis connection
```

**High memory:**
```bash
pm2 logs fi-email-worker
# Look for "🗑️ Forced GC" messages - if absent, --expose-gc flag missing
# Check: GC_INTERVAL in optimizedPdfExtractor.js is working
```

**Domain not resolving:**
```bash
nslookup your-domain.com
# Wait up to 48 hours for DNS propagation
```

**Nginx errors:**
```bash
sudo nginx -t
sudo systemctl restart nginx
```

## Notes

- **Memory Optimization**: The streaming document processor limits memory growth. Monitor with `pm2 monit` - should see stable ~300MB per backend process.
- **GC Critical**: `--expose-gc --max-old-space-size=1536` must be in PM2 startup args. This is already configured in `ecosystem.config.js`.
- **Failover**: Set up Route 53 health checks if you add another instance.
- **Updates**: Run `git pull && npm install` to update code, then `pm2 restart all`.
