#!/bin/bash
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR"

echo ""
echo "============================================================"
echo "  AWS DevOps Agent Interactive Demo — Destroying all stacks"
echo "============================================================"
echo ""

# Ensure dependencies are installed
if [ ! -d "node_modules" ]; then
  echo "→ Installing dependencies..."
  npm install --silent
fi

REGION="${CDK_DEFAULT_REGION:-${AWS_DEFAULT_REGION:-us-east-1}}"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text 2>/dev/null || echo "")

if [ -z "$ACCOUNT_ID" ]; then
  echo "✗ Could not determine AWS account ID. Configure AWS credentials first."
  exit 1
fi

echo "→ Account: $ACCOUNT_ID | Region: $REGION"

# ── Step 1: Empty S3 buckets that may block stack deletion ─────────────
echo ""
echo "→ Emptying S3 buckets that may block deletion..."

# List of bucket name patterns used by this demo
BUCKET_PATTERNS=(
  "elb-access-logs-${ACCOUNT_ID}-${REGION}"
  "vpc-flow-logs-${ACCOUNT_ID}-${REGION}"
  "pcap-analyzer-storage-${ACCOUNT_ID}"
)

for BUCKET_NAME in "${BUCKET_PATTERNS[@]}"; do
  if aws s3api head-bucket --bucket "$BUCKET_NAME" 2>/dev/null; then
    echo "  → Emptying s3://$BUCKET_NAME ..."
    aws s3 rm "s3://$BUCKET_NAME" --recursive --region "$REGION" 2>/dev/null || true
    # Also delete any versioned objects
    VERSIONS=$(aws s3api list-object-versions --bucket "$BUCKET_NAME" --region "$REGION" \
      --query '{Objects: Versions[].{Key:Key,VersionId:VersionId}}' --output json 2>/dev/null || echo '{"Objects":null}')
    if [ "$VERSIONS" != '{"Objects":null}' ] && [ "$VERSIONS" != '{"Objects": null}' ]; then
      echo "  → Deleting versioned objects in s3://$BUCKET_NAME ..."
      aws s3api delete-objects --bucket "$BUCKET_NAME" --region "$REGION" --delete "$VERSIONS" 2>/dev/null || true
    fi
    DELETE_MARKERS=$(aws s3api list-object-versions --bucket "$BUCKET_NAME" --region "$REGION" \
      --query '{Objects: DeleteMarkers[].{Key:Key,VersionId:VersionId}}' --output json 2>/dev/null || echo '{"Objects":null}')
    if [ "$DELETE_MARKERS" != '{"Objects":null}' ] && [ "$DELETE_MARKERS" != '{"Objects": null}' ]; then
      echo "  → Deleting delete markers in s3://$BUCKET_NAME ..."
      aws s3api delete-objects --bucket "$BUCKET_NAME" --region "$REGION" --delete "$DELETE_MARKERS" 2>/dev/null || true
    fi
    echo "  ✓ $BUCKET_NAME emptied"
  else
    echo "  · $BUCKET_NAME does not exist (skipping)"
  fi
done

# ── Step 2: Delete SSM parameter that may conflict on redeploy ─────────
echo ""
echo "→ Cleaning up SSM parameters..."
aws ssm delete-parameter --name "/pcap-mcp/storage-bucket" --region "$REGION" 2>/dev/null && \
  echo "  ✓ Deleted /pcap-mcp/storage-bucket" || \
  echo "  · /pcap-mcp/storage-bucket does not exist (skipping)"

# ── Step 3: Destroy CDK stacks ────────────────────────────────────────
echo ""
MAX_RETRIES=5
RETRY=0

while [ $RETRY -lt $MAX_RETRIES ]; do
  RETRY=$((RETRY + 1))
  echo "→ Destroy attempt $RETRY of $MAX_RETRIES..."

  npx cdk destroy --all --force 2>&1
  EXIT_CODE=$?

  if [ $EXIT_CODE -eq 0 ]; then
    echo ""
    echo "✅ All stacks destroyed successfully."
    exit 0
  fi

  # Check if any stacks remain
  REMAINING=$(aws cloudformation list-stacks \
    --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE UPDATE_ROLLBACK_COMPLETE DELETE_FAILED \
    --region "$REGION" \
    --query "StackSummaries[?contains(StackName,'NetDevOps')].StackName" \
    --output text 2>/dev/null)

  if [ -z "$REMAINING" ]; then
    echo ""
    echo "✅ All stacks destroyed successfully."
    exit 0
  fi

  echo ""
  echo "⚠ Some stacks remain: $REMAINING"
  echo "  Retrying in 10 seconds..."
  sleep 10
done

echo ""
echo "✗ Failed to destroy all stacks after $MAX_RETRIES attempts."
echo "  Remaining stacks may need manual deletion from the CloudFormation console."
exit 1
