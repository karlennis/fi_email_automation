# EC2 Monitoring & Troubleshooting Guide

## Reading the logs

`pm2 logs` **tails** a file — it can only ever show you the end of a run, which is why
`--lines 1000` runs out part-way through a night's scan. Use it to watch live; use
`npm run logs` to read a run or a day in full.

Every line carries the **run id** of the work that produced it (`SCAN-20260813-a4f1`,
`NIGHTLY-…`, `ROUTE-…`, `DELIVER-…`, `REQ-…`), so one run can be pulled out of a file
that also holds three schedulers and two clustered API instances.

```bash
cd ~/fi_email_automation/backend

# What ran last night, did it finish, and how big was it?
npm run logs -- --runs --date 2026-08-12

# RUN                    START     END       OUTCOME     ERR  WARN  DETAIL
# NIGHTLY-20260813-ridn  00:10:01  00:10:04  ok            0     0  enqueued=2 resumed=1
# SCAN-20260813-38re     00:10:05  00:31:58  ok            7     1  matched=8 processed=3182
# SCAN-20260813-uf6h     00:32:01  00:38:12  FAILED        3     1  job=SCAN-1099

# One run, start to finish
npm run logs -- --run SCAN-20260813-38re

# Just what went wrong, and which document caused it
npm run logs -- --date 2026-08-12 --level error

# Everything that happened to one document / project / file
npm run logs -- --date 2026-08-12 --debug --grep 1188422

# Raw records for counting or charting
npm run logs -- --date 2026-08-12 --json | jq -r 'select(.message=="scan summary")'

# Which days are still on disk, and how big
npm run logs -- --list
```

Files in `/var/log/fi_email`, all rotated by date:

| File | Holds | Kept |
| --- | --- | --- |
| `app-YYYY-MM-DD.log` | INFO and above — the readable record of a day | 14 days |
| `debug-YYYY-MM-DD.log` | Everything, including the per-document trail | 3 days |
| `error-YYYY-MM-DD.log` | ERROR only | 30 days |
| `*-out.log`, `*-error.log` | PM2's raw stdout — crash output that never reached the logger | size-capped |

`LOG_LEVEL` controls **console output only**. The files are fixed, so raising it cannot
cost you the `app-` record and lowering it cannot cost you the debug trail.

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

# Watch logs live (tail only - use `npm run logs` to read a whole run)
pm2 logs                           # All services
pm2 logs fi-email-backend          # Backend only
pm2 logs fi-email-worker           # Worker only
pm2 logs --err                     # Error output only
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

**What to Look For** (GC and memory sampling are debug-level, so pass `--debug`):
```
$ cd backend && npm run logs -- --debug --grep "scan: forced"
00:14:02 DEBUG [SCAN-20260813-a4f1] scan: forced GC  at=100
00:14:19 DEBUG [SCAN-20260813-a4f1] scan: checkpoint memory  heapMB=289 rssMB=612
```
The INFO-level `scan: progress` line also carries `rssMB`, so `npm run logs -- --grep
"scan: progress"` shows the memory trend across a run without switching to debug.

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
- Logs: <500MB (dated files, 14d app / 3d debug / 30d error)
- Temp files: Cleaned up
- Free space: >5GB

**Issues:**
```bash
# Clean old logs
sudo journalctl --vacuum=50M

# The dated app-/debug-/error- files rotate and expire themselves (14d/3d/30d), and
# diskCleanupService size-caps PM2's *-out.log / *-error.log every 30 minutes. Only
# reach for pm2-logrotate if those PM2 files are still growing faster than the cap.
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 10

# Check large files
du -sh /var/log/fi_email/*
find /home/ubuntu/fi_email_automation -type f -size +100M
```

## Common Issues & Fixes

### Issue: `Cannot find module '...'` — every app errored after a deploy

**Symptom:** `pm2 list` shows `errored` with a high restart count, and PM2 has stopped
retrying (`max_restarts: 10`, `min_uptime: 30s`). All three Node apps go together, since
they share `utils/logger.js`.

**Cause:** a `git pull` brought code that needs a new dependency, and `npm install` was
not run **inside `backend/`**. There is no `package.json` at the repo root, so running it
there installs nothing.

```bash
cd ~/fi_email_automation/backend && npm install
NODE_ENV=production node -e "require('./utils/logger'); console.log('ok')"
cd ~/fi_email_automation && pm2 delete all && pm2 start ecosystem.config.js && pm2 save
```

See "Updating a running deployment" in EC2_DEPLOYMENT.md for the full sequence.

### Issue: `npm run logs` says "no log for today" but the app is running

Check which directory it read — the message names it. If it says `backend/logs` while the
files are in `/var/log/fi_email`, pass `--dir /var/log/fi_email`. If it reports finding an
undated `app.log`, the logger is in its fallback mode because
`winston-daily-rotate-file` is missing: `cd backend && npm install`.

### Issue: Backend process crashes

**Check logs:**
```bash
cd backend && npm run logs -- --level error          # today's errors, with the run id
pm2 logs fi-email-backend --err                      # crash output winston never saw
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
cd backend && npm run logs -- --debug --grep "forced garbage collection"
# GC is logged at debug, so this needs --debug (or debug-DATE.log directly)
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
cd backend && npm run logs -- --runs           # did a scan run start, and did it end?
cd backend && npm run logs -- --run SCAN-...   # then read that run in full
```

**Verify Redis:**
```bash
redis-cli ping
redis-cli keys "*"
redis-cli dbsize
```

**Check job queue:**
```bash
cd backend && npm run logs -- --debug --grep queue
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
   # Most frequent messages today - a runaway loop sits at the top
   cd backend && npm run logs -- --debug --json \
     | jq -r .message | sort | uniq -c | sort -rn | head -20
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
| Watch logs live | `pm2 logs fi-email-backend` |
| Read a whole run | `cd backend && npm run logs -- --runs` |
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
