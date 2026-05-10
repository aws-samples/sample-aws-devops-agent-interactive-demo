#!/bin/bash
set -euo pipefail

REGION=${CDK_DEFAULT_REGION:-${AWS_DEFAULT_REGION:-us-east-1}}

# Helper: query a single CloudFormation output value
get() {
  aws cloudformation describe-stacks \
    --stack-name "$1" \
    --region "$REGION" \
    --query "Stacks[0].Outputs[?OutputKey==\`$2\`].OutputValue" \
    --output text 2>/dev/null || echo "(not available)"
}

# ── Fetch key outputs ─────────────────────────────────────────────────
DASH_URL=$(get NetDevOpsDashboardStack DashboardUrl)
AGENT_CONSOLE=$(get NetDevOpsAgentStack AgentSpaceConsoleUrl)
CREDS_ARN=$(get NetDevOpsAuthStack DashboardCredentialsSecretArn)

# ── Retrieve dashboard credentials from Secrets Manager ───────────────
DASH_USER="(not available)"
DASH_PASS="(not available)"
if [ "$CREDS_ARN" != "(not available)" ]; then
  CREDS_JSON=$(aws secretsmanager get-secret-value \
    --secret-id "$CREDS_ARN" \
    --region "$REGION" \
    --query SecretString \
    --output text 2>/dev/null || echo "{}")
  DASH_USER=$(echo "$CREDS_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin).get('username','(not available)'))" 2>/dev/null || echo "(not available)")
  DASH_PASS=$(echo "$CREDS_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin).get('password','(not available)'))" 2>/dev/null || echo "(not available)")
fi

echo ""
echo "============================================================"
echo "  AWS DevOps Agent Interactive Demo — Deployment Complete ✓"
echo "============================================================"
echo ""
echo "  ➜  Dashboard: ${DASH_URL}"
echo ""
echo "  ➜  Login:     ${DASH_USER} / ${DASH_PASS}"
echo ""
echo "  ➜  Agent Space Console: ${AGENT_CONSOLE}"
echo ""
echo "------------------------------------------------------------"
echo "  NEXT STEPS"
echo ""
echo "  1. Open the dashboard link above and sign in"
echo ""
echo "  2. Go to the 'Configuration' tab to find:"
echo "     • MCP server endpoint and OAuth credentials"
echo "     • S3 bucket ARNs for Agent Space"
echo "     • Webhook configuration"
echo ""
echo "  3. In the Agent Space console:"
echo "     • Register the MCP server (use values from dashboard)"
echo "     • Generate a webhook URL and HMAC secret"
echo "     • Paste them into the dashboard webhook config"
echo ""
echo "  4. Go to the 'Networking Scenarios' tab"
echo "     • Click 'Break' on any scenario to trigger an investigation"
echo ""
echo "============================================================"
echo ""
