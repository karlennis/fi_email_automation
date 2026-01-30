# FI Email Automation - AWS Infrastructure Setup Script (PowerShell)
# Run this on Windows with AWS CLI configured

$ErrorActionPreference = "Stop"

# Configuration
$INSTANCE_TYPE = "t4g.medium"
$REGION = "eu-north-1"
$AMI_ID = "ami-0d71ea30463e0ff8d"  # Ubuntu 22.04 LTS ARM64 (eu-north-1)
$KEY_NAME = "fi-email-key"
$SECURITY_GROUP_NAME = "fi-email-automation-sg"
$INSTANCE_NAME = "fi-email-automation"

Write-Host "🚀 AWS Infrastructure Setup for FI Email Automation" -ForegroundColor Green
Write-Host "====================================================" -ForegroundColor Green
Write-Host ""

Write-Host "📋 Configuration:" -ForegroundColor Yellow
Write-Host "  Region: $REGION"
Write-Host "  Instance Type: $INSTANCE_TYPE"
Write-Host "  AMI: $AMI_ID"
Write-Host "  Key Pair: $KEY_NAME"
Write-Host ""

# 1. Create key pair if not exists
Write-Host "🔑 Checking/creating key pair..." -ForegroundColor Yellow
try {
    aws ec2 describe-key-pairs --key-names $KEY_NAME --region $REGION 2>$null
    Write-Host "✅ Key pair already exists: $KEY_NAME" -ForegroundColor Green
} catch {
    Write-Host "Creating key pair: $KEY_NAME" -ForegroundColor Yellow
    $keyMaterial = aws ec2 create-key-pair --key-name $KEY_NAME --region $REGION --query 'KeyMaterial' --output text
    $keyMaterial | Out-File -FilePath "$KEY_NAME.pem" -Encoding ASCII
    Write-Host "✅ Key pair created: $KEY_NAME.pem" -ForegroundColor Green
    Write-Host "⚠️  Save this file securely! You'll need it to SSH." -ForegroundColor Yellow
}

# 2. Create security group
Write-Host "🔒 Creating security group..." -ForegroundColor Yellow
try {
    $SG_ID = (aws ec2 describe-security-groups --group-names $SECURITY_GROUP_NAME --region $REGION --query 'SecurityGroups[0].GroupId' --output text 2>$null)
    Write-Host "✅ Security group already exists: $SG_ID" -ForegroundColor Green
} catch {
    Write-Host "Creating security group: $SECURITY_GROUP_NAME" -ForegroundColor Yellow
    $SG_ID = aws ec2 create-security-group --group-name $SECURITY_GROUP_NAME --description "Security group for FI Email Automation" --region $REGION --query 'GroupId' --output text
    
    Write-Host "Adding ingress rules..." -ForegroundColor Yellow
    
    # SSH
    aws ec2 authorize-security-group-ingress --group-id $SG_ID --protocol tcp --port 22 --cidr 0.0.0.0/0 --region $REGION 2>$null
    
    # HTTP
    aws ec2 authorize-security-group-ingress --group-id $SG_ID --protocol tcp --port 80 --cidr 0.0.0.0/0 --region $REGION 2>$null
    
    # HTTPS
    aws ec2 authorize-security-group-ingress --group-id $SG_ID --protocol tcp --port 443 --cidr 0.0.0.0/0 --region $REGION 2>$null
    
    Write-Host "✅ Security group created: $SG_ID" -ForegroundColor Green
}

# 3. Launch EC2 instance
Write-Host "🚀 Launching EC2 instance..." -ForegroundColor Yellow

$USER_DATA = @"
#!/bin/bash
set -e
apt update && apt upgrade -y
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs git redis-server
npm install -g pm2
mkdir -p /var/log/fi_email
chown ubuntu:ubuntu /var/log/fi_email
echo "✅ EC2 setup complete. SSH to instance and run: bash deploy-ec2.sh"
"@

$USER_DATA_BASE64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($USER_DATA))

$INSTANCE_ID = aws ec2 run-instances `
    --image-id $AMI_ID `
    --instance-type $INSTANCE_TYPE `
    --key-name $KEY_NAME `
    --security-group-ids $SG_ID `
    --region $REGION `
    --user-data $USER_DATA `
    --monitoring Enabled=true `
    --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$INSTANCE_NAME}]" `
    --query 'Instances[0].InstanceId' `
    --output text

Write-Host "✅ Instance launched: $INSTANCE_ID" -ForegroundColor Green
Write-Host "⏳ Waiting for instance to be running..." -ForegroundColor Yellow

aws ec2 wait instance-running --instance-ids $INSTANCE_ID --region $REGION

# Get instance details
$INSTANCE_INFO = aws ec2 describe-instances --instance-ids $INSTANCE_ID --region $REGION --output json | ConvertFrom-Json
$PUBLIC_IP = $INSTANCE_INFO.Reservations[0].Instances[0].PublicIpAddress
$PRIVATE_IP = $INSTANCE_INFO.Reservations[0].Instances[0].PrivateIpAddress

Write-Host "✅ Instance is running!" -ForegroundColor Green
Write-Host ""
Write-Host "📊 Instance Details:" -ForegroundColor Yellow
Write-Host "  Instance ID: $INSTANCE_ID"
Write-Host "  Public IP: $PUBLIC_IP"
Write-Host "  Private IP: $PRIVATE_IP"
Write-Host "  Region: $REGION"
Write-Host ""

# 4. Create Elastic IP
Write-Host "🔗 Creating Elastic IP..." -ForegroundColor Yellow
$ELASTIC_IP = aws ec2 allocate-address --domain vpc --region $REGION --query 'PublicIp' --output text
$ALLOCATION_ID = aws ec2 describe-addresses --public-ips $ELASTIC_IP --region $REGION --query 'Addresses[0].AllocationId' --output text

aws ec2 associate-address --instance-id $INSTANCE_ID --allocation-id $ALLOCATION_ID --region $REGION | Out-Null

Write-Host "✅ Elastic IP allocated: $ELASTIC_IP" -ForegroundColor Green
Write-Host ""

# 5. Create CloudWatch alarms
Write-Host "📊 Setting up CloudWatch alarms..." -ForegroundColor Yellow

try {
    aws cloudwatch put-metric-alarm `
        --alarm-name "fi-email-high-cpu" `
        --alarm-description "Alert when CPU exceeds 80%" `
        --metric-name CPUUtilization `
        --namespace AWS/EC2 `
        --statistic Average `
        --period 300 `
        --threshold 80 `
        --comparison-operator GreaterThanThreshold `
        --evaluation-periods 2 `
        --dimensions Name=InstanceId,Value=$INSTANCE_ID `
        --region $REGION 2>$null
} catch {
    Write-Host "CloudWatch alarm creation skipped (may need additional permissions)" -ForegroundColor Yellow
}

Write-Host "✅ CloudWatch alarms configured" -ForegroundColor Green
Write-Host ""

# 6. Output summary
Write-Host "====================================================" -ForegroundColor Green
Write-Host "✅ AWS Infrastructure Setup Complete!" -ForegroundColor Green
Write-Host "====================================================" -ForegroundColor Green
Write-Host ""
Write-Host "📋 Next Steps:" -ForegroundColor Yellow
Write-Host ""
Write-Host "1️⃣  Convert PEM key to compatible format (if using PuTTY):" -ForegroundColor White
Write-Host "   Or use SSH directly in PowerShell:" -ForegroundColor White
Write-Host "   ssh -i $KEY_NAME.pem ubuntu@$ELASTIC_IP" -ForegroundColor Cyan
Write-Host ""
Write-Host "2️⃣  Once connected, clone and deploy:" -ForegroundColor White
Write-Host "   git clone https://github.com/karlennis/fi_email_automation.git" -ForegroundColor Cyan
Write-Host "   cd fi_email_automation" -ForegroundColor Cyan
Write-Host "   bash deploy-ec2.sh" -ForegroundColor Cyan
Write-Host ""
Write-Host "3️⃣  Configure your domain to point to:" -ForegroundColor White
Write-Host "   Elastic IP: $ELASTIC_IP" -ForegroundColor Cyan
Write-Host ""
Write-Host "4️⃣  Verify services are running:" -ForegroundColor White
Write-Host "   pm2 list" -ForegroundColor Cyan
Write-Host "   pm2 monit" -ForegroundColor Cyan
Write-Host ""
Write-Host "💰 Cost Estimate:" -ForegroundColor Yellow
Write-Host "   t4g.medium: ~`$25/month"
Write-Host "   EBS 30GB: ~`$2.40/month"
Write-Host "   Elastic IP: Free (if associated)"
Write-Host "   Total: ~`$28/month"
Write-Host ""
Write-Host "🔑 Key Information:" -ForegroundColor Yellow
Write-Host "   Key pair file: $KEY_NAME.pem"
Write-Host "   Security group: $SECURITY_GROUP_NAME ($SG_ID)"
Write-Host "   Instance ID: $INSTANCE_ID"
Write-Host "   Elastic IP: $ELASTIC_IP"
Write-Host ""

# Save instance info to file
@"
Instance Information for FI Email Automation
============================================
Created: $(Get-Date)
Region: $REGION
Instance ID: $INSTANCE_ID
Instance Type: $INSTANCE_TYPE
Public IP: $PUBLIC_IP
Elastic IP: $ELASTIC_IP
Private IP: $PRIVATE_IP
Key Pair: $KEY_NAME.pem
Security Group: $SECURITY_GROUP_NAME ($SG_ID)

SSH Command:
ssh -i $KEY_NAME.pem ubuntu@$ELASTIC_IP

Deployment Command (after SSH):
bash deploy-ec2.sh

CloudWatch Dashboard:
https://console.aws.amazon.com/ec2/v2/home?region=$REGION#Instances:instanceId=$INSTANCE_ID
"@ | Out-File -FilePath "instance-info.txt" -Encoding UTF8

Write-Host "Instance information saved to: instance-info.txt" -ForegroundColor Green
Write-Host ""
