#!/bin/bash

# FI Email Automation - EC2 Quick Deployment Script
# Run this on a fresh Ubuntu 22.04 t4g.medium instance
# Usage: bash deploy-ec2.sh

set -e

echo "🚀 FI Email Automation EC2 Deployment"
echo "======================================"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if running as ubuntu user
if [ "$USER" != "ubuntu" ]; then
    echo -e "${RED}❌ Must run as ubuntu user. Use: sudo su - ubuntu${NC}"
    exit 1
fi

# 1. Update system
echo -e "${YELLOW}📦 Updating system packages...${NC}"
sudo apt update && sudo apt upgrade -y

# 2. Install Node.js 20
echo -e "${YELLOW}📦 Installing Node.js 20 LTS...${NC}"
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs git redis-server

# 3. Install PM2
echo -e "${YELLOW}📦 Installing PM2...${NC}"
sudo npm install -g pm2

# 4. Create log directory
echo -e "${YELLOW}📁 Creating log directory...${NC}"
sudo mkdir -p /var/log/fi_email
sudo chown ubuntu:ubuntu /var/log/fi_email

# 5. Clone repository
echo -e "${YELLOW}🔄 Cloning repository...${NC}"
if [ -d "fi_email_automation" ]; then
    echo "Repository already exists, pulling latest changes..."
    cd fi_email_automation
    git pull origin main
else
    git clone https://github.com/karlennis/fi_email_automation.git
    cd fi_email_automation
fi

# 6. Install dependencies
echo -e "${YELLOW}📦 Installing backend dependencies...${NC}"
cd backend && npm install

echo -e "${YELLOW}📦 Installing frontend dependencies...${NC}"
cd ../frontend && npm install --include=dev

# 7. Build frontend
echo -e "${YELLOW}🔨 Building frontend...${NC}"
npm run build

cd ..

# 8. Setup Redis
echo -e "${YELLOW}🔴 Configuring Redis...${NC}"
sudo systemctl enable redis-server
sudo systemctl start redis-server
redis-cli ping

# 9. Environment variables
echo -e "${YELLOW}⚙️  Setting up environment variables...${NC}"
if [ ! -f "backend/.env" ]; then
    echo -e "${YELLOW}⚠️  backend/.env not found!${NC}"
    echo -e "${YELLOW}Please copy backend/.env.example to backend/.env and fill in your values:${NC}"
    echo -e "${YELLOW}Required variables:${NC}"
    echo "  - MONGODB_URI"
    echo "  - AWS_ACCESS_KEY_ID"
    echo "  - AWS_SECRET_ACCESS_KEY"
    echo "  - OPENAI_API_KEY"
    echo "  - SMTP_* (email credentials)"
    echo ""
    echo -e "${YELLOW}Create backend/.env now and then run: pm2 start ecosystem.config.js${NC}"
else
    echo -e "${GREEN}✅ backend/.env found${NC}"
fi

# 10. Start PM2
echo -e "${YELLOW}🚀 Starting services with PM2...${NC}"
pm2 start ecosystem.config.js

# 11. Setup PM2 auto-startup
echo -e "${YELLOW}🔧 Setting up PM2 auto-startup...${NC}"
sudo pm2 startup -u ubuntu --hp /home/ubuntu
pm2 save

# 12. Install Nginx
echo -e "${YELLOW}📦 Installing Nginx...${NC}"
sudo apt install -y nginx certbot python3-certbot-nginx

# 13. Create Nginx config
echo -e "${YELLOW}⚙️  Creating Nginx configuration...${NC}"

sudo tee /etc/nginx/sites-available/fi_email_automation > /dev/null << 'EOF'
upstream backend {
    least_conn;
    server localhost:3000;
}

upstream frontend {
    server localhost:4000;
}

server {
    listen 80 default_server;
    server_name _;
    
    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }
    
    location / {
        return 301 https://$host$request_uri;
    }
}

server {
    listen 443 ssl http2 default_server;
    server_name _;
    
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
        
        error_page 404 =200 /index.html;
    }
    
    # Gzip compression
    gzip on;
    gzip_types text/html text/plain text/css application/json application/javascript;
    gzip_min_length 1000;
    
    # SSL certificates - update these after certbot
    ssl_certificate /etc/letsencrypt/live/your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-domain.com/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    ssl_prefer_server_ciphers on;
}
EOF

sudo ln -sf /etc/nginx/sites-available/fi_email_automation /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default

echo -e "${YELLOW}⚠️  Update Nginx config with your domain:${NC}"
echo "  sudo nano /etc/nginx/sites-available/fi_email_automation"
echo ""

# 14. Verify Nginx config
echo -e "${YELLOW}🔍 Checking Nginx configuration...${NC}"
if sudo nginx -t; then
    echo -e "${GREEN}✅ Nginx config valid${NC}"
    sudo systemctl restart nginx
    sudo systemctl enable nginx
else
    echo -e "${RED}❌ Nginx config invalid! Fix it before continuing.${NC}"
fi

# 15. Summary
echo ""
echo -e "${GREEN}======================================"
echo "✅ EC2 Deployment Setup Complete!"
echo "=====================================${NC}"
echo ""
echo -e "${YELLOW}📋 Next Steps:${NC}"
echo ""
echo "1️⃣  Update Nginx configuration with your domain:"
echo "   sudo nano /etc/nginx/sites-available/fi_email_automation"
echo ""
echo "2️⃣  Create/copy backend/.env with your credentials:"
echo "   nano backend/.env"
echo ""
echo "3️⃣  Restart backend services after .env is set:"
echo "   pm2 restart all"
echo ""
echo "4️⃣  Setup SSL certificate (once domain is pointed to this IP):"
echo "   sudo mkdir -p /var/www/certbot"
echo "   sudo certbot certonly --webroot -w /var/www/certbot -d your-domain.com"
echo ""
echo "5️⃣  Monitor services:"
echo "   pm2 monit        # Real-time monitoring"
echo "   pm2 logs         # View logs"
echo ""
echo -e "${YELLOW}📊 Verify services:${NC}"
echo "   pm2 list"
echo ""
echo -e "${YELLOW}📚 Full documentation:${NC}"
echo "   See EC2_DEPLOYMENT.md for detailed instructions"
echo ""
