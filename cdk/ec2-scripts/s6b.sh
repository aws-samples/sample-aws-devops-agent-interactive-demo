#!/bin/bash
SESSION_ID="${1:-$(date +%s)}"
TOKEN=$(curl -s -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 300")
REGION=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/placement/region)
BUCKET=$(aws ssm get-parameter --name /pcap-mcp/storage-bucket --query Parameter.Value --output text --region $REGION 2>/dev/null || echo "")
MY_IP=$(hostname -I | awk '{print $1}')
DOMAIN="maps.geo.${REGION}.amazonaws.com"
if [ -z "$BUCKET" ]; then echo "Storage bucket not configured"; exit 1; fi

# Baseline capture (20s of healthy traffic)
sudo timeout 20 tcpdump -i any port 443 -w /tmp/baseline-${SESSION_ID}.pcap 2>/dev/null &
BASE_PID=$!
sleep 22
sudo kill $BASE_PID 2>/dev/null || true
wait $BASE_PID 2>/dev/null || true
aws s3 cp /tmp/baseline-${SESSION_ID}.pcap s3://${BUCKET}/captures/baseline-${SESSION_ID}.pcap --region $REGION
rm -f /tmp/baseline-${SESSION_ID}.pcap

# Poison DNS — redirect domain to self
sudo cp /etc/hosts /etc/hosts.bak
echo "$MY_IP $DOMAIN" | sudo tee -a /etc/hosts > /dev/null

# Wait for health check to detect (runs every 10s)
sleep 15

# Incident capture (30s of broken traffic)
sudo timeout 30 tcpdump -i any port 443 -w /tmp/incident-${SESSION_ID}.pcap 2>/dev/null &
INC_PID=$!
sleep 32
sudo kill $INC_PID 2>/dev/null || true
wait $INC_PID 2>/dev/null || true
aws s3 cp /tmp/incident-${SESSION_ID}.pcap s3://${BUCKET}/captures/incident-${SESSION_ID}.pcap --region $REGION
rm -f /tmp/incident-${SESSION_ID}.pcap
