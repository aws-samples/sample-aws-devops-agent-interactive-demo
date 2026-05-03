# AWS DevOps Agent Interactive Demo

An interactive demo showcasing [AWS DevOps Agent](https://docs.aws.amazon.com/devopsagent/latest/userguide/what-is.html) automated incident investigation and resolution across 6 network break/fix scenarios.

Deploy a fully functional environment with a single command. Break things on purpose, watch DevOps Agent investigate using CloudTrail, VPC Flow Logs, ELB Access Logs, and PCAP analysis, then fix them.

## Architecture

The demo deploys 9 CDK stacks into your AWS account:

| Stack | Purpose |
|-------|---------|
| **NetworkStack** | VPC, subnets, NAT Gateway, VPC endpoints (S3, Bedrock, Location Service, CloudWatch, SSM, STS), flow logs |
| **ComputeStack** | EC2 instance (health checks + nginx), ALB, RDS MySQL, ELB access logs |
| **TrafficGenStack** | Lambda + EventBridge schedule generating traffic to the ALB |
| **AlarmStack** | 6 CloudWatch alarms, SNS topic, webhook Lambda, Secrets Manager |
| **AuthStack** | Cognito User Pool, M2M app client, dashboard authentication |
| **PcapMcpStack** | PCAP storage S3 bucket, AgentCore execution IAM role |
| **ImageStack** | ECR repository, CodeBuild project (builds PCAP MCP Server container + creates AgentCore Runtime) |
| **DevOpsAgentStack** | Agent Space, IAM roles, account association |
| **DashboardStack** | S3 + CloudFront frontend, API Gateway, Lambda handlers, DynamoDB |

## Scenarios

| # | Scenario | Break Action | Primary Evidence |
|---|----------|-------------|-----------------|
| 1 | Security Group Rule | Revoke RDS inbound rule (port 3306) | CloudTrail + VPC Flow Logs |
| 2 | NAT Gateway Route | Delete default route (0.0.0.0/0) | CloudTrail + VPC Flow Logs |
| 3 | VPC Endpoint Policy | Deny S3 Gateway Endpoint policy | CloudTrail |
| 4 | Bedrock Endpoint Subnets | Remove Interface Endpoint subnets | CloudTrail |
| 5 | ALB Backend Failure | Stop backend application (502 Bad Gateway) | ELB Access Logs |
| 6 | TLS/SNI Mismatch + PCAP | DNS poisoning of Location Service endpoint | PCAP MCP Server |

Each scenario triggers a real infrastructure change, a CloudWatch alarm fires, a webhook notifies DevOps Agent, and an automated investigation begins.

## Prerequisites

- **AWS Account** with permissions to create VPCs, EC2, RDS, Lambda, CloudFormation, Cognito, Bedrock AgentCore, and related resources
- **Node.js 18+** and npm
- **AWS CLI v2** configured with credentials
- **Docker** (for building the PCAP MCP Server container image via CodeBuild)
- **AWS CDK** (`npm install -g aws-cdk` or use `npx`)

## Quick Start

### 1. Clone and install

```bash
git clone https://github.com/aws-samples/sample-aws-devops-agent-interactive-demo.git
cd sample-aws-devops-agent-interactive-demo/Networking/network-devops-agent-deploy
npm install
```

### 2. Deploy

```bash
bash scripts/deploy.sh
```

The deploy script will:
- Check prerequisites (Node.js 18+, npm, AWS CLI)
- Bootstrap CDK if needed
- Deploy all 9 stacks (~15-20 minutes)
- Refresh downstream stacks for MCP endpoint resolution
- Display the dashboard URL, login credentials, and next steps

### 3. Configure DevOps Agent

After deployment, the script displays:
- **Dashboard URL** (CloudFront)
- **Login credentials** (auto-generated, stored in Secrets Manager)
- **Agent Space console link**

Log into the dashboard and go to the **Configuration** tab:

1. **Register the MCP Server** in the Agent Space console using the endpoint URL and OAuth credentials shown on the dashboard
2. **Configure the Webhook** by generating a webhook URL and HMAC secret in the Agent Space console, then pasting them into the dashboard
3. **Note the S3 bucket ARNs** displayed on the dashboard. The Agent Space IAM role has been pre-configured with `s3:GetObject` and `s3:ListBucket` permissions on these buckets

### 4. Run scenarios

Go to the **Networking Scenarios** tab:

1. Click **Break** on any scenario to trigger a network failure
2. Watch the **Investigation event stream** as DevOps Agent investigates
3. Click the **DevOps Agent** link in the topology diagram to view the Operator Access dashboard
4. Click **Fix** to restore the infrastructure

Only one scenario can be active at a time (mutual exclusion).

## Dashboard Features

- **Network topology diagram** with animated traffic flows that turn red when a scenario breaks
- **Alarm pipeline visualization** showing CloudWatch Alarm to SNS to Lambda to DevOps Agent flow
- **Real-time event stream** showing break, alarm, webhook, investigation, and fix events
- **Responsive layout** that adapts from 4K displays to laptops with fluid font scaling
- **Light/dark mode** toggle
- **Webhook gate** prevents running scenarios until the webhook is configured

## PCAP MCP Server

Scenario 6 uses a custom MCP server running on [Amazon Bedrock AgentCore Runtime](https://docs.aws.amazon.com/devopsagent/latest/userguide/configuring-capabilities-for-aws-devops-agent.html) for packet capture analysis. It wraps the upstream [sample-pcap-analyzer-mcp](https://github.com/aws-samples/sample-pcap-analyzer-mcp) with three enhancements:

1. **Transport** - FastMCP with streamable-http (AgentCore compatible)
2. **S3 support** - Transparently downloads `s3://` URIs before analysis
3. **tshark fix** - Overrides buggy upstream `summary` mode with valid tshark commands

See [codebuild-scripts/README.md](codebuild-scripts/README.md) for details.

## Clean Up

```bash
bash scripts/destroy.sh
```

The destroy script retries up to 5 times to handle dependency ordering and eventual consistency.

## Project Structure

```
Networking/network-devops-agent-deploy/
├── bin/                    # CDK app entry point
├── lib/                    # 9 CDK stack definitions
├── lambda/                 # Lambda function handlers
│   ├── dashboard-break/    # POST /break - triggers scenario failures
│   ├── dashboard-fix/      # POST /fix - restores infrastructure
│   ├── dashboard-config/   # GET /config - returns MCP/OAuth/bucket config
│   ├── dashboard-health/   # GET /health - scenario status polling
│   ├── dashboard-events/   # GET /events - event stream polling
│   ├── dashboard-eventbridge/ # EventBridge rule handler
│   ├── dashboard-webhook-config/ # POST /webhook-config
│   ├── webhook/            # SNS to DevOps Agent webhook forwarder
│   ├── traffic-generator/  # ALB traffic generation
│   ├── build-trigger/      # CodeBuild trigger
│   └── build-waiter/       # CodeBuild completion waiter
├── frontend/               # Dashboard UI (HTML/CSS/JS)
│   ├── index.html          # Main dashboard with SVG topology
│   ├── styles.css          # Cloudscape-inspired design tokens
│   ├── app.js              # Dashboard logic and polling
│   └── icons/              # AWS service SVG icons
├── health-check-app/       # EC2 health check application (Node.js)
├── codebuild-scripts/      # PCAP MCP Server Docker build
├── scripts/                # Deploy, destroy, show-outputs scripts
└── test/                   # CDK stack tests
```

## Security

- All API Gateway endpoints are protected by Cognito authentication
- IAM policies are scoped to specific resources (no wildcards)
- Secrets are stored in AWS Secrets Manager
- IMDSv2 enforced on EC2 instances
- RDS and EBS encryption enabled
- CORS scoped to the CloudFront distribution domain
- Security review completed with 0 open findings

See [CONTRIBUTING](CONTRIBUTING.md) for more information.

## License

This library is licensed under the MIT-0 License. See the [LICENSE](LICENSE) file.
