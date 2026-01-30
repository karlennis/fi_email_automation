#!/bin/bash

# FI Email Automation - AWS Infrastructure Setup Script
# This script automates EC2 instance creation and configuration
# Prerequisites: AWS CLI configured with proper credentials

set -e

# Configuration
INSTANCE_TYPE="t4g.medium"
REGION="eu-north-1"
AMI_ID="ami-0d71ea30463e0ff8d"  # Ubuntu 22.04 LTS ARM64 (eu-north-1) - update for your region
KEY_NAME="fi-email-key"
SECURITY_GROUP_NAME="fi-email-automation-sg"
INSTANCE_NAME="fi-email-automation"
INSTANCE_COUNT=1

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${GREEN}🚀 AWS Infrastructure Setup for FI Email Automation${NC}"
echo "===================================================="
echo ""

# Check AWS CLI
if ! command -v aws &> /dev/null; then
    echo -e "${RED}❌ AWS CLI not found. Install it first: https://aws.amazon.com/cli/${NC}"
    exit 1
fi

# Check AWS credentials
if ! aws sts get-caller-identity &> /dev/null; then
    echo -e "${RED}❌ AWS credentials not configured. Run: aws configure${NC}"
    exit 1
fi

echo -e "${YELLOW}📋 Configuration:${NC}"
echo "  Region: $REGION"
echo "  Instance Type: $INSTANCE_TYPE"
echo "  AMI: $AMI_ID"
echo "  Key Pair: $KEY_NAME"
echo ""

# 1. Create key pair if not exists
echo -e "${YELLOW}🔑 Checking/creating key pair...${NC}"
if aws ec2 describe-key-pairs --key-names "$KEY_NAME" --region "$REGION" 2>/dev/null; then
    echo -e "${GREEN}✅ Key pair already exists: $KEY_NAME${NC}"
else
    echo -e "${YELLOW}Creating key pair: $KEY_NAME${NC}"
    aws ec2 create-key-pair \
        --key-name "$KEY_NAME" \
        --region "$REGION" \
        --query 'KeyMaterial' \
        --output text > "$KEY_NAME.pem"
    chmod 400 "$KEY_NAME.pem"
    echo -e "${GREEN}✅ Key pair created: $KEY_NAME.pem${NC}"
    echo -e "${YELLOW}⚠️  Save this file securely! You'll need it to SSH.${NC}"
fi

# 2. Create security group
echo -e "${YELLOW}🔒 Creating security group...${NC}"
if aws ec2 describe-security-groups --group-names "$SECURITY_GROUP_NAME" --region "$REGION" 2>/dev/null; then
    echo -e "${GREEN}✅ Security group already exists${NC}"
    SG_ID=$(aws ec2 describe-security-groups --group-names "$SECURITY_GROUP_NAME" --region "$REGION" --query 'SecurityGroups[0].GroupId' --output text)
else
    echo -e "${YELLOW}Creating security group: $SECURITY_GROUP_NAME${NC}"
    SG_ID=$(aws ec2 create-security-group \
        --group-name "$SECURITY_GROUP_NAME" \
        --description "Security group for FI Email Automation" \
        --region "$REGION" \
        --query 'GroupId' \
        --output text)
    
    echo -e "${YELLOW}Adding ingress rules...${NC}"
    
    # SSH
    aws ec2 authorize-security-group-ingress \
        --group-id "$SG_ID" \
        --protocol tcp \
        --port 22 \
        --cidr 0.0.0.0/0 \
        --region "$REGION" 2>/dev/null || true
    
    # HTTP
    aws ec2 authorize-security-group-ingress \
        --group-id "$SG_ID" \
        --protocol tcp \
        --port 80 \
        --cidr 0.0.0.0/0 \
        --region "$REGION" 2>/dev/null || true
    
    # HTTPS
    aws ec2 authorize-security-group-ingress \
        --group-id "$SG_ID" \
        --protocol tcp \
        --port 443 \
        --cidr 0.0.0.0/0 \
        --region "$REGION" 2>/dev/null || true
    
    echo -e "${GREEN}✅ Security group created: $SG_ID${NC}"
fi

# 3. Launch EC2 instance
echo -e "${YELLOW}🚀 Launching EC2 instance...${NC}"

USER_DATA=$(cat << 'USERDATA'
#!/bin/bash
set -e
apt update && apt upgrade -y
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs git redis-server
npm install -g pm2
mkdir -p /var/log/fi_email
chown ubuntu:ubuntu /var/log/fi_email
echo "✅ EC2 setup complete. SSH to instance and run: bash deploy-ec2.sh"
USERDATA
)

INSTANCE_ID=$(aws ec2 run-instances \
    --image-id "$AMI_ID" \
    --instance-type "$INSTANCE_TYPE" \
    --key-name "$KEY_NAME" \
    --security-group-ids "$SG_ID" \
    --region "$REGION" \
    --user-data "$USER_DATA" \
    --monitoring Enabled=true \
    --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$INSTANCE_NAME}]" \
    --query 'Instances[0].InstanceId' \
    --output text)

echo -e "${GREEN}✅ Instance launched: $INSTANCE_ID${NC}"
echo -e "${YELLOW}⏳ Waiting for instance to be running...${NC}"

aws ec2 wait instance-running \
    --instance-ids "$INSTANCE_ID" \
    --region "$REGION"

# Get instance details
INSTANCE_INFO=$(aws ec2 describe-instances \
    --instance-ids "$INSTANCE_ID" \
    --region "$REGION" \
    --query 'Reservations[0].Instances[0]')

PUBLIC_IP=$(echo "$INSTANCE_INFO" | jq -r '.PublicIpAddress')
PRIVATE_IP=$(echo "$INSTANCE_INFO" | jq -r '.PrivateIpAddress')

echo -e "${GREEN}✅ Instance is running!${NC}"
echo ""
echo -e "${YELLOW}📊 Instance Details:${NC}"
echo "  Instance ID: $INSTANCE_ID"
echo "  Public IP: $PUBLIC_IP"
echo "  Private IP: $PRIVATE_IP"
echo "  Region: $REGION"
echo ""

# 4. Create Elastic IP
echo -e "${YELLOW}🔗 Creating Elastic IP...${NC}"
ELASTIC_IP=$(aws ec2 allocate-address \
    --domain vpc \
    --region "$REGION" \
    --query 'PublicIp' \
    --output text)

ALLOCATION_ID=$(aws ec2 describe-addresses \
    --public-ips "$ELASTIC_IP" \
    --region "$REGION" \
    --query 'Addresses[0].AllocationId' \
    --output text)

aws ec2 associate-address \
    --instance-id "$INSTANCE_ID" \
    --allocation-id "$ALLOCATION_ID" \
    --region "$REGION"

echo -e "${GREEN}✅ Elastic IP allocated: $ELASTIC_IP${NC}"
echo ""

# 5. Create CloudWatch alarms
echo -e "${YELLOW}📊 Setting up CloudWatch alarms...${NC}"

aws cloudwatch put-metric-alarm \
    --alarm-name "fi-email-high-cpu" \
    --alarm-description "Alert when CPU exceeds 80%" \
    --metric-name CPUUtilization \
    --namespace AWS/EC2 \
    --statistic Average \
    --period 300 \
    --threshold 80 \
    --comparison-operator GreaterThanThreshold \
    --evaluation-periods 2 \
    --dimensions Name=InstanceId,Value="$INSTANCE_ID" \
    --region "$REGION" 2>/dev/null || true

aws cloudwatch put-metric-alarm \
    --alarm-name "fi-email-low-disk" \
    --alarm-description "Alert when disk usage exceeds 80%" \
    --metric-name DiskSpaceUtilization \
    --namespace AWS/EC2 \
    --statistic Average \
    --period 300 \
    --threshold 80 \
    --comparison-operator GreaterThanThreshold \
    --evaluation-periods 2 \
    --dimensions Name=InstanceId,Value="$INSTANCE_ID" \
    --region "$REGION" 2>/dev/null || true

echo -e "${GREEN}✅ CloudWatch alarms configured${NC}"
echo ""

# 6. Output summary
echo -e "${GREEN}===================================================="
echo "✅ AWS Infrastructure Setup Complete!"
echo "====================================================${NC}"
echo ""
echo -e "${YELLOW}📋 Next Steps:${NC}"
echo ""
echo "1️⃣  SSH into your instance:"
echo "   ssh -i $KEY_NAME.pem ubuntu@$ELASTIC_IP"
echo ""
echo "2️⃣  Once connected, clone and deploy:"
echo "   git clone https://github.com/karlennis/fi_email_automation.git"
echo "   cd fi_email_automation"
echo "   bash deploy-ec2.sh"
echo ""
echo "3️⃣  Configure your domain to point to:"
echo "   Elastic IP: $ELASTIC_IP"
echo ""
echo "4️⃣  Verify services are running:"
echo "   pm2 list"
echo "   pm2 monit"
echo ""
echo -e "${YELLOW}📊 Monitoring:${NC}"
echo "   View CloudWatch metrics:"
echo "   https://console.aws.amazon.com/ec2/v2/home?region=$REGION#Instances:instanceId=$INSTANCE_ID"
echo ""
echo -e "${YELLOW}💰 Cost Estimate:${NC}"
echo "   t4g.medium: ~\$25/month"
echo "   EBS 30GB: ~\$2.40/month"
echo "   Elastic IP: Free (if associated)"
echo "   Total: ~\$28/month"
echo ""
echo -e "${YELLOW}🔑 Key Information:${NC}"
echo "   Key pair file: $KEY_NAME.pem"
echo "   Security group: $SECURITY_GROUP_NAME ($SG_ID)"
echo "   Instance ID: $INSTANCE_ID"
echo "   Elastic IP: $ELASTIC_IP"
echo ""
echo -e "${YELLOW}Save this information for reference!${NC}"
echo ""

# Save instance info to file
cat > instance-info.txt << EOF
Instance Information for FI Email Automation
============================================
Created: $(date)
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
EOF

echo -e "${GREEN}Instance information saved to: instance-info.txt${NC}"
echo ""
