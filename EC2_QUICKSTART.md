# EC2 Migration Quickstart

## Why EC2?

- **Cost**: ~$28/month vs Render Pro $85/month (67% savings)
- **Reliability**: Full control, no vendor lock-in
- **Performance**: Same specs (4GB RAM, 2 vCPU) but more predictable
- **Integration**: Already have AWS account + S3

## Quick Start (5 minutes)

### Step 1: Create AWS Infrastructure
```bash
# On your local machine with AWS CLI configured
bash setup-aws-infrastructure.sh

# This creates:
# - EC2 t4g.medium instance
# - Security group (SSH, HTTP, HTTPS)
# - Elastic IP (static address)
# - CloudWatch monitoring

# Outputs: instance-info.txt with connection details
```

### Step 2: SSH into Instance
```bash
ssh -i fi-email-key.pem ubuntu@<ELASTIC_IP>
```

### Step 3: Deploy Application
```bash
# Clone repo
git clone https://github.com/karlennis/fi_email_automation.git
cd fi_email_automation

# Run automated deployment
bash deploy-ec2.sh

# Follow prompts to configure:
# 1. Update backend/.env with credentials
# 2. Setup SSL certificate for your domain
# 3. Verify services with: pm2 list
```

### Step 4: Point Domain to Elastic IP
Update DNS A record to Elastic IP from instance-info.txt

### Step 5: Verify Services
```bash
# Check all running
pm2 list

# Monitor in real-time
pm2 monit

# View logs
pm2 logs
```

## Deployment Methods

Choose one based on your preference:

### Option A: Manual Deploy (Recommended First Time)
```bash
bash deploy-ec2.sh
# Interactive setup, good for first deployment
```

### Option B: Docker Compose
```bash
# Requires Docker on instance
docker-compose up -d

# One command deployment, fully containerized
```

### Option C: Automated from Scratch
```bash
# From local machine
bash setup-aws-infrastructure.sh
# Fully automated EC2 creation + initial setup
```

## Cost Breakdown

| Component | Monthly Cost |
|-----------|--------------|
| EC2 t4g.medium | $25.33 |
| EBS 30GB gp3 | $2.40 |
| Elastic IP | Free (when associated) |
| Data transfer | $0-1 |
| **Total** | **~$28** |

**vs Render Pro: $85/month**  
**Savings: ~$57/month or 67%**

## Key Files

| File | Purpose |
|------|---------|
| `EC2_DEPLOYMENT.md` | Comprehensive setup guide |
| `deploy-ec2.sh` | Automated deployment script |
| `setup-aws-infrastructure.sh` | Automated AWS infrastructure |
| `ecosystem.config.js` | PM2 process management config |
| `Dockerfile` | Docker image build |
| `docker-compose.yml` | Docker Compose stack |
| `EC2_MONITORING.md` | Monitoring & troubleshooting |

## Essential Commands

```bash
# Process management
pm2 list              # View all processes
pm2 monit             # Real-time monitoring
pm2 logs              # View logs
pm2 restart all       # Restart services
pm2 stop all          # Stop services
pm2 start all         # Start services

# System monitoring
free -h               # Memory usage
df -h                 # Disk usage
ps aux --sort=-%mem  # Processes by memory

# Database/Redis
redis-cli ping        # Check Redis
mongosh               # MongoDB client (if using local)

# Nginx/SSL
sudo nginx -t         # Test Nginx config
sudo certbot certificates  # Check SSL status
```

## Monitoring

The application includes memory optimization from previous refactor:
- **Backend**: 200-300MB stable (streaming document processor)
- **Worker**: 200-300MB stable (one-page-at-a-time PDF processing)
- **Total**: ~800-1000MB including system

Expected log messages:
```
🗑️ Forced GC after 5 documents (mem: 289MB, heap: 156MB)
📄 PDF Processing Start (file: document.pdf)
📄 PDF Cleanup (mem: 290MB)
```

If memory grows linearly → see EC2_MONITORING.md for tuning.

## Troubleshooting

### Services won't start
```bash
pm2 logs --err
# Check: AWS credentials, MongoDB URI, Redis running
```

### High memory usage
```bash
pm2 logs fi-email-worker | grep "Forced GC"
# Should see GC every 5 documents
# If not: --expose-gc flag missing
```

### Domain not resolving
```bash
# DNS takes up to 48 hours to propagate
nslookup your-domain.com
# Should return Elastic IP
```

### SSL certificate issues
```bash
sudo certbot certificates
sudo certbot renew --force-renewal
sudo systemctl restart nginx
```

## Rollback Plan

If EC2 doesn't work:
1. Keep Render running during transition
2. Point domain back to Render IP
3. Delete EC2 instance to stop charges
4. No code changes needed - both use same code

## Support Resources

- **Full Setup Guide**: [EC2_DEPLOYMENT.md](EC2_DEPLOYMENT.md)
- **Monitoring Guide**: [EC2_MONITORING.md](EC2_MONITORING.md)
- **Memory Optimization**: [MEMORY_OPTIMIZATION.md](MEMORY_OPTIMIZATION.md)
- **AWS Console**: https://console.aws.amazon.com/ec2/

## Next Steps

1. ✅ Review EC2_DEPLOYMENT.md
2. ✅ Run setup-aws-infrastructure.sh (creates EC2 instance)
3. ✅ SSH into instance
4. ✅ Run deploy-ec2.sh (deploys application)
5. ✅ Configure domain DNS
6. ✅ Monitor with pm2 monit
7. ✅ Verify memory stays stable
8. ✅ Cancel Render subscription (if happy)

**Estimated Time**: 30 minutes for full setup

**Questions?** See EC2_MONITORING.md troubleshooting section or check logs with `pm2 logs`

---

**Total Cost Savings**: $57/month (67% reduction)  
**Performance**: Identical to Render Pro  
**Control**: 100% (no vendor lock-in)
