# FI Email Automation - Deployment Guide

This guide covers deployment of the FI Email Automation system for production environments.

## System Requirements

### Backend (Node.js API)
- Node.js v18 or higher
- MongoDB 5.0 or higher
- SSL certificate for HTTPS
- SMTP server access for email sending

### Frontend (Angular)
- Web server (Nginx, Apache, or similar)
- SSL certificate for HTTPS
- CDN (optional but recommended)

## Environment Setup

### Backend Environment Variables

Create a `.env` file in the backend directory:

```env
# Server Configuration
PORT=3000
NODE_ENV=production

# Database
MONGODB_URI=mongodb://localhost:27017/fi-email-automation

# JWT Configuration
JWT_SECRET=your-super-secure-jwt-secret-here
JWT_EXPIRES_IN=7d

# OpenAI Configuration
OPENAI_API_KEY=sk-your-openai-api-key-here

# Email Configuration (SMTP)
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-email@gmail.com
SMTP_PASS=your-app-password

# Email Settings
FROM_EMAIL=noreply@yourdomain.com
FROM_NAME=FI Email Automation

# File Upload
MAX_FILE_SIZE=10485760  # 10MB in bytes
UPLOAD_DIR=./uploads

# CORS Settings
CORS_ORIGIN=https://yourdomain.com

# Rate Limiting
RATE_LIMIT_WINDOW_MS=900000  # 15 minutes
RATE_LIMIT_MAX=100  # requests per window
```

### Frontend Environment

Update the API base URL in the Angular services or create environment files:

```typescript
// src/environments/environment.prod.ts
export const environment = {
  production: true,
  apiUrl: 'https://api.yourdomain.com/api'
};
```

## Deployment Steps

### 1. Backend Deployment

#### Option A: Traditional Server (Ubuntu/CentOS)

1. **Install Node.js and MongoDB**:
```bash
# Install Node.js
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# Install MongoDB
wget -qO - https://www.mongodb.org/static/pgp/server-5.0.asc | sudo apt-key add -
echo "deb [ arch=amd64,arm64 ] https://repo.mongodb.org/apt/ubuntu focal/mongodb-org/5.0 multiverse" | sudo tee /etc/apt/sources.list.d/mongodb-org-5.0.list
sudo apt-get update
sudo apt-get install -y mongodb-org
sudo systemctl start mongod
sudo systemctl enable mongod
```

2. **Deploy the application**:
```bash
# Clone or upload your project
cd /var/www/fi-email-automation

# Install dependencies
npm install --production

# Create uploads directory
mkdir -p uploads
chmod 755 uploads

# Start with PM2 (recommended)
sudo npm install -g pm2
pm2 start server.js --name "fi-email-api"
pm2 startup
pm2 save
```

3. **Configure Nginx reverse proxy**:
```nginx
# /etc/nginx/sites-available/fi-email-api
server {
    listen 80;
    server_name api.yourdomain.com;

    # Redirect HTTP to HTTPS
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name api.yourdomain.com;

    ssl_certificate /path/to/your/certificate.crt;
    ssl_certificate_key /path/to/your/private.key;

    # File upload size limit
    client_max_body_size 10M;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
```

#### Option B: Docker Deployment

1. **Create Dockerfile** (backend):
```dockerfile
FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY . .

EXPOSE 3000

CMD ["node", "server.js"]
```

2. **Docker Compose**:
```yaml
# docker-compose.yml
version: '3.8'

services:
  mongodb:
    image: mongo:5.0
    restart: unless-stopped
    volumes:
      - mongodb_data:/data/db
    environment:
      MONGO_INITDB_ROOT_USERNAME: admin
      MONGO_INITDB_ROOT_PASSWORD: your-secure-password

  backend:
    build: ./backend
    restart: unless-stopped
    ports:
      - "3000:3000"
    environment:
      MONGODB_URI: mongodb://admin:your-secure-password@mongodb:27017/fi-email-automation?authSource=admin
    depends_on:
      - mongodb
    volumes:
      - ./uploads:/app/uploads

volumes:
  mongodb_data:
```

### 2. Frontend Deployment

#### Build the Application

```bash
cd frontend
npm install
ng build --configuration production
```

#### Option A: Static Hosting (Nginx)

1. **Configure Nginx**:
```nginx
# /etc/nginx/sites-available/fi-email-frontend
server {
    listen 80;
    server_name yourdomain.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name yourdomain.com;

    ssl_certificate /path/to/your/certificate.crt;
    ssl_certificate_key /path/to/your/private.key;

    root /var/www/fi-email-automation/frontend/dist/frontend;
    index index.html;

    # Gzip compression
    gzip on;
    gzip_types text/plain text/css application/json application/javascript text/xml application/xml application/xml+rss text/javascript;

    # Cache static assets
    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg)$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    # Handle Angular routing
    location / {
        try_files $uri $uri/ /index.html;
    }

    # API proxy (if needed)
    location /api {
        proxy_pass https://api.yourdomain.com;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

2. **Deploy files**:
```bash
sudo cp -r dist/frontend/* /var/www/fi-email-automation/frontend/
sudo chown -R www-data:www-data /var/www/fi-email-automation/frontend/
sudo systemctl reload nginx
```

#### Option B: Docker Deployment

1. **Create Dockerfile** (frontend):
```dockerfile
# Build stage
FROM node:18-alpine as builder

WORKDIR /app
COPY package*.json ./
RUN npm install

COPY . .
RUN npm run build --prod

# Production stage
FROM nginx:alpine

COPY --from=builder /app/dist/frontend /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
```

2. **Nginx configuration for Docker**:
```nginx
# nginx.conf
server {
    listen 80;
    root /usr/share/nginx/html;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg)$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }
}
```

## SSL/HTTPS Setup

### Using Let's Encrypt (Free SSL)

```bash
# Install Certbot
sudo apt-get install certbot python3-certbot-nginx

# Obtain certificates
sudo certbot --nginx -d yourdomain.com -d api.yourdomain.com

# Auto-renewal
sudo crontab -e
# Add: 0 12 * * * /usr/bin/certbot renew --quiet
```

## Monitoring and Logs

### Backend Monitoring with PM2

```bash
# Monitor processes
pm2 monit

# View logs
pm2 logs fi-email-api

# Restart application
pm2 restart fi-email-api
```

### Log Rotation

```bash
# Setup logrotate for application logs
sudo nano /etc/logrotate.d/fi-email-automation
```

```
/var/log/fi-email-automation/*.log {
    daily
    missingok
    rotate 14
    compress
    delaycompress
    notifempty
    copytruncate
}
```

## Database Management

### Backup MongoDB

```bash
# Create backup
mongodump --db fi-email-automation --out /backup/$(date +%Y%m%d)

# Restore backup
mongorestore --db fi-email-automation /backup/20240101/fi-email-automation
```

### Database Indexes

Connect to MongoDB and create recommended indexes:

```javascript
// Connect to MongoDB
use fi-email-automation

// Create indexes for better performance
db.firequests.createIndex({ "createdAt": -1 })
db.firequests.createIndex({ "customerId": 1 })
db.firequests.createIndex({ "projectId": 1 })
db.firequests.createIndex({ "status": 1 })

db.customers.createIndex({ "email": 1 }, { unique: true })
db.customers.createIndex({ "isActive": 1 })

db.users.createIndex({ "email": 1 }, { unique: true })
```

## Performance Optimization

### Backend Optimizations

1. **Enable Redis caching** (optional):
```bash
sudo apt-get install redis-server
npm install redis
```

2. **Database connection pooling** is already configured in the application

3. **File cleanup job** - Add a cron job to clean old uploads:
```bash
# Clean files older than 30 days
0 2 * * * find /var/www/fi-email-automation/uploads -type f -mtime +30 -delete
```

### Frontend Optimizations

1. **CDN Integration** - Serve static assets from a CDN
2. **Service Worker** - Consider adding for offline functionality
3. **Bundle Analysis**:
```bash
npm install -g webpack-bundle-analyzer
ng build --stats-json
webpack-bundle-analyzer dist/frontend/stats.json
```

## Security Checklist

- [ ] Environment variables properly configured
- [ ] SSL/HTTPS enabled for both frontend and backend
- [ ] Database authentication enabled
- [ ] Regular security updates applied
- [ ] File upload restrictions enforced
- [ ] Rate limiting configured
- [ ] CORS properly configured
- [ ] JWT secrets are secure and rotated
- [ ] Firewall configured (only ports 80, 443, 22 open)
- [ ] Regular backups scheduled
- [ ] Monitoring and alerting setup

## Troubleshooting

### Common Issues

1. **CORS Errors**: Check CORS_ORIGIN environment variable
2. **File Upload Issues**: Verify upload directory permissions
3. **Database Connection**: Check MongoDB service status and connection string
4. **Email Not Sending**: Verify SMTP credentials and settings
5. **High Memory Usage**: Monitor Node.js process and add memory limits

### Health Check Endpoints

The backend includes health check endpoints:
- `GET /health` - Basic health check
- `GET /api/health` - Detailed system status

## Maintenance

### Regular Tasks

1. **Daily**: Check logs for errors
2. **Weekly**: Review system performance metrics
3. **Monthly**: Update dependencies and security patches
4. **Quarterly**: Review and rotate secrets/certificates

### Updates

```bash
# Backend updates
cd backend
npm update
npm audit fix

# Frontend updates
cd frontend
ng update
npm audit fix
```

This deployment guide should get your FI Email Automation system running in production. Adjust configurations based on your specific infrastructure and requirements.
