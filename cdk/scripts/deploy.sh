#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$PROJECT_DIR"

echo ""
echo "============================================================"
echo "  AWS DevOps Agent Interactive Demo — Deploying all stacks"
echo "============================================================"
echo ""

# ── Step 0: Check prerequisites ───────────────────────────────────────
echo "→ Checking prerequisites..."

if ! command -v node &>/dev/null; then
  echo "✗ Node.js is not installed. Install Node.js 18+ from https://nodejs.org"
  exit 1
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
  echo "✗ Node.js $NODE_VERSION found, but 18+ is required. Update from https://nodejs.org"
  exit 1
fi

if ! command -v npm &>/dev/null; then
  echo "✗ npm is not installed. It should come with Node.js."
  exit 1
fi

if ! command -v aws &>/dev/null; then
  echo "✗ AWS CLI is not installed. Install from https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html"
  exit 1
fi

echo "  ✓ Node.js $(node -v) | npm $(npm -v) | AWS CLI $(aws --version 2>&1 | cut -d' ' -f1)"

# ── Step 1: Install dependencies ──────────────────────────────────────
echo "→ Installing npm dependencies..."
npm install --silent

# ── Step 2: Build TypeScript ──────────────────────────────────────────
echo "→ Compiling TypeScript..."
npx tsc --noEmit

# ── Step 3: Bootstrap CDK (if needed) ─────────────────────────────────
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text 2>/dev/null || echo "")
REGION=${CDK_DEFAULT_REGION:-${AWS_DEFAULT_REGION:-us-east-1}}

if [ -z "$ACCOUNT_ID" ]; then
  echo "✗ Could not determine AWS account ID. Configure AWS credentials first."
  exit 1
fi

echo "→ Account: $ACCOUNT_ID | Region: $REGION"

BOOTSTRAP_STACK=$(aws cloudformation describe-stacks \
  --stack-name CDKToolkit \
  --region "$REGION" \
  --query "Stacks[0].StackStatus" \
  --output text 2>/dev/null || echo "NONE")

if [ "$BOOTSTRAP_STACK" = "NONE" ]; then
  echo "→ Bootstrapping CDK..."
  npx cdk bootstrap "aws://$ACCOUNT_ID/$REGION"
else
  echo "→ CDK already bootstrapped"
fi

# ── Step 4: Deploy all stacks ─────────────────────────────────────────
echo ""
echo "→ Deploying all 9 CDK stacks (this takes ~15-20 minutes)..."
npx cdk deploy --all --require-approval never

# ── Step 5: Refresh downstream stacks ─────────────────────────────────
# On first deploy, the MCP endpoint URL is written to SSM by CodeBuild
# during ImageStack deployment. PcapMcpStack/DashboardStack need a
# re-synth to pick up the real value (instead of PENDING_CODEBUILD).
echo ""
echo "→ Refreshing configuration stacks..."
npx cdk deploy NetDevOpsPcapMcpStack NetDevOpsAgentStack NetDevOpsDashboardStack --require-approval never 2>/dev/null || true

# ── Step 6: Show outputs ──────────────────────────────────────────────
echo ""
bash "$SCRIPT_DIR/show-outputs.sh"
