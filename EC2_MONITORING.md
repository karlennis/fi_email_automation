# EC2 Monitoring & Troubleshooting Guide

## Real-Time Monitoring

### PM2 Commands

```bash
# Live monitoring dashboard
pm2 monit

# View all processes
pm2 list

# Detailed process info
pm2 show fi-email-backend
pm2 show fi-email-worker
pm2 show fi-email-frontend

# View logs in real-time
pm2 logs                           # All services
pm2 logs fi-email-backend          # Backend only
pm2 logs fi-email-worker           # Worker only
pm2 logs --err                     # Error logs only
pm2 logs --lines 100               # Last 100 lines
pm2 logs --timestamp               # With timestamps
```

### System Metrics

```bash
# Memory usage
free -h
ps aux | grep node | grep -v grep

# CPU usage
top -bn1 | head -n 20

# Disk usage
df -h
du -sh /var/log/fi_email

# Process details
ps aux | grep "node --expose-gc"

# Network connections
netstat -tlnp | grep node
```

## Key Metrics to Monitor

### Memory (Expected Behavior)

**Healthy Pattern:**
- Backend process: 200-300MB stable
- Worker process: 200-300MB stable
- Total RAM usage: 800-1000MB (with system)

**Red Flags:**
- Memory growing linearly (memory leak)
- Backend exceeding 700MB
- Worker exceeding 800MB
- Swap memory being used

**Diagnostic Command:**
```bash
# Check memory breakdown
ps aux --sort=-%mem | head -5

# Watch memory in real-time
watch -n 1 'free -h && echo "---" && ps aux --sort=-%mem | head -5'
```

### GC Events (Critical)

**What to Look For:**
```
🗑️ Forced GC after 5 documents (docs: 0005, mem: 289MB, heap: 156MB)
🗑️ Forced GC after 5 documents (docs: 0010, mem: 301MB, heap: 158MB)
🗑️ Forced GC after 5 documents (docs: 0015, mem: 287MB, heap: 152MB)
```

**If NOT seeing GC messages:**
- `--expose-gc` flag missing (check `pm2 show` output)
- Restart: `pm2 restart all`

**If memory still grows:**
- GC isn't effective enough
- May need to increase GC frequency (every 3 documents instead of 5)
- Or reduce `MAX_TEXT_CHARS` in optimizedPdfExtractor.js

### CPU Usage

**Healthy:**
- Idle: <5%
- During scan: 30-60%
- Peaks acceptable, returns to baseline

**Issues:**
- CPU stuck at 100%
- CPU never drops below 50% when idle
- High CPU with low memory = infinite loop or stuck process

### Disk Usage

**Healthy:**
- Logs: <500MB (rotated daily)
- Temp files: Cleaned up
- Free space: >5GB

**Issues:**
```bash
# Clean old logs
sudo journalctl --vacuum=50M

# Clean PM2 logs
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 10

# Check large files
du -sh /var/log/fi_email/*
find /home/ubuntu/fi_email_automation -type f -size +100M
```

## Common Issues & Fixes

### Issue: Backend process crashes

**Check logs:**
```bash
pm2 logs fi-email-backend --err
# Look for: error, exception, uncaught, crash
```

**Common causes:**
1. **OutOfMemory**: Check memory monitoring above
2. **MongoDB connection lost**: Verify MONGODB_URI in .env
3. **Redis connection lost**: Check Redis is running
4. **Missing dependencies**: Run `cd backend && npm install`

**Fix:**
```bash
pm2 restart fi-email-backend
pm2 logs fi-email-backend
```

### Issue: Out of memory errors

**Immediate fix:**
```bash
# Increase GC frequency
nano backend/services/optimizedPdfExtractor.js
# Change: const GC_INTERVAL = 5; to GC_INTERVAL = 3;

# Or reduce text size limit
# Change: const MAX_TEXT_CHARS = 32000; to MAX_TEXT_CHARS = 16000;

# Restart
pm2 restart all
```

**Check if GC is working:**
```bash
pm2 logs fi-email-worker | grep "Forced GC"
# Should see messages every 5 documents
```

**If no GC messages:**
```bash
# Verify --expose-gc flag
pm2 show fi-email-worker | grep "node_args"
# Should show: node --expose-gc --max-old-space-size=1536

# If missing, restart with correct config
pm2 delete all
pm2 start ecosystem.config.js
```

### Issue: Frontend not loading

**Check Nginx:**
```bash
sudo systemctl status nginx
sudo nginx -t
sudo tail -20 /var/log/nginx/error.log
```

**Check frontend process:**
```bash
pm2 logs fi-email-frontend
curl http://localhost:4000
```

**Fix:**
```bash
pm2 restart fi-email-frontend
sudo systemctl restart nginx
```

### Issue: API endpoint returning 500 errors

**Check backend logs:**
```bash
pm2 logs fi-email-backend
# Look for: Error, exception, stack trace
```

**Common causes:**
1. **Database connection**: `MONGODB_URI` invalid
2. **S3 access**: AWS credentials missing/invalid
3. **OpenAI API**: `OPENAI_API_KEY` missing/invalid
4. **Dependencies**: Missing npm packages

**Fix:**
```bash
# Verify environment variables
cat backend/.env | grep -E "MONGODB|AWS|OPENAI"

# Reinstall dependencies
cd backend && npm install

# Restart
pm2 restart fi-email-backend
```

### Issue: Scan jobs not processing

**Check worker:**
```bash
pm2 logs fi-email-worker
# Look for: "Processing document", "Queue", "Job"
```

**Verify Redis:**
```bash
redis-cli ping
redis-cli keys "*"
redis-cli dbsize
```

**Check job queue:**
```bash
# From application logs or database
pm2 logs fi-email-worker | grep -i "job\|queue\|processing"
```

**Fix:**
```bash
# Restart worker
pm2 restart fi-email-worker

# If jobs stuck, clear queue (CAUTION - loses pending jobs)
redis-cli FLUSHDB
pm2 restart fi-email-worker
```

### Issue: High disk usage

**Find large files:**
```bash
du -sh /var/log/fi_email/*
find /home/ubuntu -type f -size +100M

# Clean logs
rm /var/log/fi_email/backend-*.log
pm2 kill && pm2 start ecosystem.config.js
```

### Issue: SSL certificate expired

**Check certificate:**
```bash
sudo certbot certificates
# Look for: "Valid until: YYYY-MM-DD"
```

**Renew:**
```bash
sudo certbot renew --force-renewal
sudo systemctl restart nginx
```

## Performance Tuning

### If memory still growing

1. **Reduce GC_INTERVAL** (more aggressive GC)
   ```bash
   nano backend/services/optimizedPdfExtractor.js
   # Change GC_INTERVAL = 5 to GC_INTERVAL = 3
   pm2 restart all
   ```

2. **Reduce MAX_TEXT_CHARS** (limit text per document)
   ```bash
   nano backend/services/optimizedPdfExtractor.js
   # Change MAX_TEXT_CHARS = 32000 to MAX_TEXT_CHARS = 16000
   pm2 restart all
   ```

3. **Increase max-old-space-size** (temporary, until root cause fixed)
   ```bash
   nano ecosystem.config.js
   # Change: --max-old-space-size=1536 to --max-old-space-size=2048
   pm2 restart all
   ```

### If CPU high

1. **Check for loops in logs:**
   ```bash
   pm2 logs fi-email-backend | head -100
   # Look for repeated lines or patterns
   ```

2. **Reduce concurrent operations:**
   ```bash
   nano backend/services/scanJobWorker.js
   # Reduce: MAX_CONCURRENT_JOBS or similar
   pm2 restart fi-email-worker
   ```

3. **Check for blocking database queries:**
   ```bash
   # Monitor MongoDB slow queries
   # Enable profiling in MongoDB Atlas or logs
   ```

## AWS CloudWatch Monitoring

### View metrics from AWS Console

```bash
# Open in browser:
# https://console.aws.amazon.com/ec2/v2/home?region=eu-north-1#Instances:

# Available metrics:
# - CPU Utilization
# - Network In/Out
# - Disk Read/Write
# - Status Check
```

### Set up custom metrics

```bash
# From EC2 instance, send custom metric
aws cloudwatch put-metric-data \
  --metric-name MemoryUtilization \
  --value $(free | awk '/^Mem:/{printf("%.0f", $3/$2 * 100.0)}') \
  --unit Percent \
  --namespace FIEmailAutomation \
  --region eu-north-1
```

## Log Rotation

### Automatic log rotation with PM2

```bash
pm2 install pm2-logrotate

# Configure
pm2 set pm2-logrotate:max_size 10M    # Max file size
pm2 set pm2-logrotate:retain 10        # Keep 10 files
pm2 set pm2-logrotate:compress true    # Compress old logs
pm2 set pm2-logrotate:dateFormat YYYY-MM-DD_HH-mm-ss

# Verify
pm2 config pm2-logrotate
```

## Backup & Recovery

### Backup database

```bash
# MongoDB Atlas (automatic)
# - Snapshots every 6 hours
# - Restore from AWS console

# If self-hosted:
mongodump --uri "mongodb://localhost:27017/fi_automation" --out backup/
```

### Backup application data

```bash
# Backup logs and config
tar -czf backup-$(date +%Y%m%d).tar.gz \
  /var/log/fi_email/ \
  /home/ubuntu/fi_email_automation/backend/.env

# Upload to S3
aws s3 cp backup-$(date +%Y%m%d).tar.gz s3://your-backup-bucket/
```

### Restore from backup

```bash
# Restore from S3
aws s3 cp s3://your-backup-bucket/backup-20260130.tar.gz .
tar -xzf backup-20260130.tar.gz

# Restart services
pm2 restart all
```

## Useful Commands Reference

| Task | Command |
|------|---------|
| View all processes | `pm2 list` |
| Monitor in real-time | `pm2 monit` |
| View specific logs | `pm2 logs fi-email-backend` |
| Restart all | `pm2 restart all` |
| Stop all | `pm2 stop all` |
| Start all | `pm2 start all` |
| Delete all | `pm2 delete all` |
| Memory stats | `free -h && ps aux --sort=-%mem \| head -5` |
| CPU usage | `top -bn1 \| head -20` |
| Disk usage | `df -h` |
| Check Redis | `redis-cli ping` |
| Clear Redis | `redis-cli FLUSHDB` |
| Check Nginx | `sudo nginx -t && sudo systemctl status nginx` |
| Check SSL | `sudo certbot certificates` |
| Renew SSL | `sudo certbot renew --force-renewal` |
| View system logs | `journalctl -u pm2-root -f` |
| Check Node version | `node -v` |
| Check npm version | `npm -v` |

## When to Scale Up

Consider upgrading instance if:

- Consistently using >75% CPU during normal operation
- Memory regularly exceeding 900MB
- Scan jobs taking longer than expected
- Response times degrading

**Upgrade path:**
1. t4g.medium → t4g.large (double CPU/RAM) (~$50/month)
2. Or add second t4g.medium behind load balancer (~$55/month)

## Alerting Setup

Create email alerts for critical issues:

```bash
# Set up SNS topic
aws sns create-topic --name fi-email-alerts --region eu-north-1

# Subscribe to topic
aws sns subscribe \
  --topic-arn arn:aws:sns:eu-north-1:ACCOUNT:fi-email-alerts \
  --protocol email \
  --notification-endpoint your-email@domain.com

# Create alarm for high memory
aws cloudwatch put-metric-alarm \
  --alarm-name "fi-email-memory-high" \
  --alarm-actions arn:aws:sns:eu-north-1:ACCOUNT:fi-email-alerts \
  --metric-name MemoryUtilization \
  --namespace AWS/EC2 \
  --statistic Average \
  --period 300 \
  --threshold 85 \
  --comparison-operator GreaterThanThreshold
```

---

**Last Updated:** 2026-01-30  
**Document:** EC2 Monitoring & Troubleshooting  
**Project:** FI Email Automation
