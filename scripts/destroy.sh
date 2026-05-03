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
    --region "${CDK_DEFAULT_REGION:-${AWS_DEFAULT_REGION:-us-east-1}}" \
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
