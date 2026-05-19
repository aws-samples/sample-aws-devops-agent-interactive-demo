#!/bin/bash
set -euo pipefail

STACK_OPERATION=$1
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CDK_DIR="$SCRIPT_DIR/cdk"
REGION="${AWS_DEFAULT_REGION:-us-east-1}"

echo "============================================================"
echo "  AWS DevOps Agent Interactive Demo — Workshop Bootstrap"
echo "  Operation: $STACK_OPERATION"
echo "  Region: $REGION"
echo "============================================================"

if [[ "$STACK_OPERATION" == "create" || "$STACK_OPERATION" == "update" ]]; then

    echo ""
    echo "→ Installing Node.js dependencies..."
    cd "$CDK_DIR"
    npm install --silent

    echo "→ Bootstrapping CDK..."
    ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
    npx cdk bootstrap "aws://$ACCOUNT_ID/$REGION" 2>/dev/null || true

    echo "→ Deploying all CDK stacks (~15-20 minutes)..."
    npx cdk deploy --all --require-approval never

    echo "→ Refreshing downstream stacks..."
    npx cdk deploy NetDevOpsPcapMcpStack NetDevOpsAgentStack NetDevOpsDashboardStack --require-approval never 2>/dev/null || true

    echo ""
    echo "→ Capturing outputs for Workshop Studio..."

    # Get Dashboard URL from CDK output
    DASHBOARD_URL=$(aws cloudformation describe-stacks \
        --stack-name NetDevOpsDashboardStack \
        --region "$REGION" \
        --query "Stacks[0].Outputs[?OutputKey=='DashboardUrl'].OutputValue" \
        --output text 2>/dev/null || echo "Not available")

    # Get Agent Space console URL
    AGENT_SPACE_CONSOLE=$(aws cloudformation describe-stacks \
        --stack-name NetDevOpsAgentStack \
        --region "$REGION" \
        --query "Stacks[0].Outputs[?OutputKey=='AgentSpaceConsoleUrl'].OutputValue" \
        --output text 2>/dev/null || echo "Not available")

    # Get credentials from Secrets Manager
    CREDS_ARN=$(aws cloudformation describe-stacks \
        --stack-name NetDevOpsAuthStack \
        --region "$REGION" \
        --query "Stacks[0].Outputs[?OutputKey=='DashboardCredentialsSecretArn'].OutputValue" \
        --output text 2>/dev/null || echo "")

    DASH_USER="admin@devops.local"
    DASH_PASS="Not available"
    if [ -n "$CREDS_ARN" ] && [ "$CREDS_ARN" != "Not available" ]; then
        CREDS_JSON=$(aws secretsmanager get-secret-value \
            --secret-id "$CREDS_ARN" \
            --region "$REGION" \
            --query SecretString \
            --output text 2>/dev/null || echo "{}")
        DASH_PASS=$(echo "$CREDS_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin).get('password','Not available'))" 2>/dev/null || echo "Not available")
    fi

    # Write outputs to SSM for CloudFormation to read
    aws ssm put-parameter --name "/workshop/dashboard-url" --value "$DASHBOARD_URL" --type String --overwrite --region "$REGION"
    aws ssm put-parameter --name "/workshop/dashboard-username" --value "$DASH_USER" --type String --overwrite --region "$REGION"
    aws ssm put-parameter --name "/workshop/dashboard-password" --value "$DASH_PASS" --type String --overwrite --region "$REGION"
    aws ssm put-parameter --name "/workshop/agent-space-console" --value "$AGENT_SPACE_CONSOLE" --type String --overwrite --region "$REGION"

    echo ""
    echo "✅ Workshop deployment complete!"
    echo "  Dashboard: $DASHBOARD_URL"
    echo "  Login: $DASH_USER / $DASH_PASS"
    echo "  Agent Space: $AGENT_SPACE_CONSOLE"

elif [ "$STACK_OPERATION" == "delete" ]; then

    echo ""
    echo "→ Destroying CDK stacks..."
    cd "$CDK_DIR"

    # Install dependencies if needed
    if [ ! -d "node_modules" ]; then
        npm install --silent
    fi

    # Empty S3 buckets that block deletion
    ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
    echo "→ Emptying S3 buckets..."
    for BUCKET_NAME in "elb-access-logs-${ACCOUNT_ID}-${REGION}" "vpc-flow-logs-${ACCOUNT_ID}-${REGION}" "pcap-analyzer-storage-${ACCOUNT_ID}"; do
        if aws s3api head-bucket --bucket "$BUCKET_NAME" 2>/dev/null; then
            aws s3 rm "s3://$BUCKET_NAME" --recursive --region "$REGION" 2>/dev/null || true
        fi
    done

    # Delete SSM parameter that conflicts on redeploy
    aws ssm delete-parameter --name "/pcap-mcp/storage-bucket" --region "$REGION" 2>/dev/null || true

    # Retry destroy up to 5 times
    MAX_RETRIES=5
    RETRY=0
    while [ $RETRY -lt $MAX_RETRIES ]; do
        RETRY=$((RETRY + 1))
        echo "→ Destroy attempt $RETRY of $MAX_RETRIES..."
        npx cdk destroy --all --force 2>&1 && break

        REMAINING=$(aws cloudformation list-stacks \
            --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE UPDATE_ROLLBACK_COMPLETE DELETE_FAILED \
            --region "$REGION" \
            --query "StackSummaries[?contains(StackName,'NetDevOps')].StackName" \
            --output text 2>/dev/null)

        if [ -z "$REMAINING" ]; then
            break
        fi

        echo "  ⚠ Remaining: $REMAINING — retrying in 10s..."
        sleep 10
    done

    # Clean up SSM parameters
    echo "→ Cleaning up SSM parameters..."
    aws ssm delete-parameter --name "/workshop/dashboard-url" --region "$REGION" 2>/dev/null || true
    aws ssm delete-parameter --name "/workshop/dashboard-username" --region "$REGION" 2>/dev/null || true
    aws ssm delete-parameter --name "/workshop/dashboard-password" --region "$REGION" 2>/dev/null || true
    aws ssm delete-parameter --name "/workshop/agent-space-console" --region "$REGION" 2>/dev/null || true

    echo ""
    echo "✅ Workshop cleanup complete!"

else
    echo "Invalid stack operation: $STACK_OPERATION"
    echo "Usage: $0 {create|update|delete}"
    exit 1
fi
