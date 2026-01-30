# Multi-stage Dockerfile for FI Email Automation
# Stage 1: Frontend build
FROM node:20-alpine AS frontend-builder

WORKDIR /app
COPY frontend/package*.json ./frontend/
RUN cd frontend && npm ci --only=production

COPY frontend ./frontend
WORKDIR /app/frontend
RUN npm run build

# Stage 2: Backend runtime
FROM node:20-alpine

WORKDIR /app

# Install dumb-init for proper signal handling
RUN apk add --no-cache dumb-init

# Copy backend dependencies
COPY backend/package*.json ./backend/
RUN cd backend && npm ci --only=production

# Copy backend code
COPY backend ./backend

# Copy built frontend
COPY --from=frontend-builder /app/frontend/dist ./frontend/dist

# Copy ecosystem config
COPY ecosystem.config.js .

# Create log directory
RUN mkdir -p /var/log/fi_email && chmod 777 /var/log/fi_email

# Environment
ENV NODE_ENV=production
ENV NODE_OPTIONS="--expose-gc --max-old-space-size=1536"

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3000/api/health', (r) => {if (r.statusCode !== 200) throw new Error(r.statusCode)})"

# Use dumb-init to handle signals properly
ENTRYPOINT ["/sbin/dumb-init", "--"]

# Start with PM2 (requires global PM2)
RUN npm install -g pm2

CMD ["pm2-runtime", "start", "ecosystem.config.js"]
