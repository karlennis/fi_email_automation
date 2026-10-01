# Backend image for FI Email Automation.
#
# One image, three services: docker-compose.yml runs it as the API (backend/server.js),
# the scan worker (backend/worker.js) and the ingestion worker (backend/ingestion-worker.js).
# The frontend has its own image - see frontend/Dockerfile.
#
# Debian rather than alpine: the native `canvas` module ships glibc prebuilds, and the OCR
# tools below are one apt line here.
FROM node:22-bookworm-slim

# poppler-utils (pdftoppm) + tesseract are the OCR fallback on the nightly scan path
# (backend/services/ocrService.js). Without pdftoppm OCR is silently disabled and scanned
# PDFs yield no text. ocrmypdf is used by fiDetectionService and documentProcessor.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        poppler-utils \
        tesseract-ocr \
        tesseract-ocr-eng \
        ocrmypdf \
        tzdata \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY backend/package*.json ./backend/
RUN cd backend && npm ci --omit=dev && npm cache clean --force

COPY backend ./backend

# Everything the app writes at runtime. Created here and owned by `node` so the named
# volumes mounted over them inherit that ownership. temp/ and .ocr_cache/ are relative to
# the working directory, which stays /app - the same layout pm2 gave them on EC2.
RUN mkdir -p /var/log/fi_email /app/temp/ocr /app/temp/downloads /app/.ocr_cache \
        /app/backend/temp /app/backend/services/outputs \
    && chown -R node:node /var/log/fi_email /app/temp /app/.ocr_cache \
        /app/backend/temp /app/backend/services/outputs

# TZ: scanJobProcessor derives "today" in UTC but the delivery day and the crons in local
# time, so the process must run in UTC or the Monday run sees Sunday and skips delivery.
ENV NODE_ENV=production \
    TZ=UTC \
    LOG_DIR=/var/log/fi_email \
    PORT=3000

USER node
EXPOSE 3000

CMD ["node", "--expose-gc", "--max-old-space-size=1536", "backend/server.js"]
