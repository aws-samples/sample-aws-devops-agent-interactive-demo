<p align="center">
  <img src="frontend/DevOpsAgent.svg" alt="AWS DevOps Agent" width="80">
</p>

<h1 align="center">AWS DevOps Agent Interactive Demo</h1>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT--0-yellow.svg" alt="License: MIT-0"></a>
  <a href="https://aws.amazon.com/cdk/"><img src="https://img.shields.io/badge/AWS_CDK-TypeScript-blue.svg" alt="AWS CDK"></a>
  <a href="https://docs.aws.amazon.com/devopsagent/latest/userguide/what-is.html"><img src="https://img.shields.io/badge/AWS-DevOps_Agent-orange.svg" alt="AWS DevOps Agent"></a>
  <a href="#"><img src="https://img.shields.io/badge/Status-Demo-teal.svg" alt="Status: Demo"></a>
  <a href="#"><img src="https://img.shields.io/badge/Node.js-18%2B-green.svg" alt="Node.js 18+"></a>
</p>

<p align="center">
  <strong>Break things on purpose. Watch AI investigate. Fix them in one click.</strong>
</p>

> **Note:** This is a demo application provided for learning and demonstration purposes only. It is not intended for production use.

<p align="center">
  <img src="docs/demo-preview.gif" alt="AWS DevOps Agent Interactive Demo" width="800">
</p>

---

## Table of Contents

- [Overview](#overview)
- [Demo Video](#demo-video)
- [Architecture](#architecture)
- [Scenarios](#scenarios)
- [Prerequisites](#prerequisites)
- [Quick Start](#quick-start)
- [Dashboard Features](#dashboard-features)
- [PCAP MCP Server](#pcap-mcp-server)
- [Project Structure](#project-structure)
- [Cost Estimate](#cost-estimate)
- [Clean Up](#clean-up)
- [Security](#security)
- [Documentation](#documentation)
- [Contributing](#contributing)
- [License](#license)

---

## Overview

An interactive demo showcasing [AWS DevOps Agent](https://docs.aws.amazon.com/devopsagent/latest/userguide/what-is.html) automated incident investigation and resolution across 6 network break/fix scenarios.

Deploy a fully functional environment with a single command. Break things on purpose, watch DevOps Agent investigate using CloudTrail, VPC Flow Logs, ELB Access Logs, and PCAP analysis, then fix them.

### How it works

| Step | What happens |
|:----:|:-------------|
| **1** | You click **Break** on the dashboard, triggering a real infrastructure change |
| **2** | A [CloudWatch Alarm](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/AlarmThatSendsEmail.html) detects the failure and publishes to an [SNS topic](https://docs.aws.amazon.com/sns/latest/dg/welcome.html) |
| **3** | The SNS topic invokes a [Lambda function](https://docs.aws.amazon.com/lambda/latest/dg/welcome.html) that sends an HMAC-signed webhook to DevOps Agent |
| **4** | DevOps Agent automatically starts an investigation, analyzing [CloudTrail](https://docs.aws.amazon.com/awscloudtrail/latest/userguide/cloudtrail-user-guide.html), [VPC Flow Logs](https://docs.aws.amazon.com/vpc/latest/userguide/flow-logs.html), [ELB Access Logs](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/load-balancer-access-logs.html), or PCAP data |
| **5** | Investigation status updates stream to the dashboard event log. Full findings are published in the DevOps Agent Operator Access dashboard |
| **6** | You click **Fix** to restore the infrastructure to its original state |

---

## Demo Video

https://github.com/user-attachments/assets/0f265e68-2cb7-4053-9308-86da53bd89f4

---

## Architecture

The demo deploys **9 CDK stacks** into your AWS account:

| Stack | Purpose |
|:------|:--------|
| 🌐 **NetworkStack** | [VPC](https://docs.aws.amazon.com/vpc/latest/userguide/what-is-amazon-vpc.html), subnets, [NAT Gateway](https://docs.aws.amazon.com/vpc/latest/userguide/vpc-nat-gateway.html), 8 [VPC endpoints](https://docs.aws.amazon.com/vpc/latest/privatelink/vpc-endpoints.html), flow logs |
| 💻 **ComputeStack** | [EC2](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/concepts.html) (health checks + nginx), [ALB](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/introduction.html), [RDS MySQL](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Welcome.html), ELB access logs |
| 🔄 **TrafficGenStack** | [Lambda](https://docs.aws.amazon.com/lambda/latest/dg/welcome.html) + [EventBridge](https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-what-is.html) schedule for ALB traffic generation |
| 🚨 **AlarmStack** | 6 [CloudWatch alarms](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/AlarmThatSendsEmail.html), [SNS topic](https://docs.aws.amazon.com/sns/latest/dg/welcome.html), webhook Lambda, [Secrets Manager](https://docs.aws.amazon.com/secretsmanager/latest/userguide/intro.html) |
| 🔐 **AuthStack** | [Cognito User Pool](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-identity-pools.html), M2M client, dashboard authentication |
| 📦 **PcapMcpStack** | PCAP storage [S3 bucket](https://docs.aws.amazon.com/AmazonS3/latest/userguide/Welcome.html), [AgentCore](https://docs.aws.amazon.com/devopsagent/latest/userguide/configuring-capabilities-for-aws-devops-agent.html) execution IAM role |
| 🐳 **ImageStack** | [ECR](https://docs.aws.amazon.com/AmazonECR/latest/userguide/what-is-ecr.html) repo, [CodeBuild](https://docs.aws.amazon.com/codebuild/latest/userguide/welcome.html) (PCAP MCP Server container + AgentCore Runtime) |
| 🤖 **DevOpsAgentStack** | [Agent Space](https://docs.aws.amazon.com/devopsagent/latest/userguide/about-aws-devops-agent.html), IAM roles, account association |
| 📊 **DashboardStack** | S3 + [CloudFront](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/Introduction.html) frontend, [API Gateway](https://docs.aws.amazon.com/apigateway/latest/developerguide/welcome.html), Lambda handlers, [DynamoDB](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Introduction.html) |

---

## Scenarios

| # | Scenario | Break Action | Primary Evidence |
|:-:|:---------|:-------------|:-----------------|
| 1 | **Security Group Rule** | Revoke RDS inbound rule (port 3306) | [CloudTrail](https://docs.aws.amazon.com/awscloudtrail/latest/userguide/cloudtrail-user-guide.html) + [VPC Flow Logs](https://docs.aws.amazon.com/vpc/latest/userguide/flow-logs.html) |
| 2 | **NAT Gateway Route** | Delete default route (0.0.0.0/0) | [CloudTrail](https://docs.aws.amazon.com/awscloudtrail/latest/userguide/cloudtrail-user-guide.html) + [VPC Flow Logs](https://docs.aws.amazon.com/vpc/latest/userguide/flow-logs.html) |
| 3 | **VPC Endpoint Policy** | Deny S3 Gateway Endpoint policy | [CloudTrail](https://docs.aws.amazon.com/awscloudtrail/latest/userguide/cloudtrail-user-guide.html) |
| 4 | **Bedrock Endpoint Subnets** | Remove Interface Endpoint subnets | [CloudTrail](https://docs.aws.amazon.com/awscloudtrail/latest/userguide/cloudtrail-user-guide.html) |
| 5 | **ALB Backend Failure** | Stop backend application (502 Bad Gateway) | [ELB Access Logs](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/load-balancer-access-logs.html) |
| 6 | **TLS/SNI Mismatch + PCAP** | DNS poisoning of Location Service endpoint | [PCAP MCP Server](codebuild-scripts/README.md) |

Each scenario triggers a real infrastructure change, a CloudWatch alarm fires, a webhook notifies DevOps Agent, and an automated investigation begins.

---

## Prerequisites

| Requirement | Version | Purpose |
|:------------|:--------|:--------|
| **[Node.js](https://nodejs.org/)** | 18+ | CDK and Lambda bundling |
| **npm** | — | Package management |
| **[AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html)** | v2 | AWS credential management |
| **[AWS CDK](https://docs.aws.amazon.com/cdk/v2/guide/getting_started.html)** | — | `npm install -g aws-cdk` or use `npx` |
| **AWS Account** | — | Permissions for VPC, EC2, RDS, Lambda, Cognito, [Bedrock AgentCore](https://docs.aws.amazon.com/devopsagent/latest/userguide/getting-started-with-aws-devops-agent.html) |

---

## Quick Start

### 1. Clone and install

```bash
git clone https://github.com/aws-samples/sample-aws-devops-agent-interactive-demo.git
cd sample-aws-devops-agent-interactive-demo
npm install
```

### 2. Deploy

```bash
bash scripts/deploy.sh
```

The deploy script will:
- ✅ Check prerequisites (Node.js 18+, npm, AWS CLI)
- ✅ Bootstrap CDK if needed
- ✅ Deploy all 9 stacks (~15-20 minutes)
- ✅ Refresh downstream stacks for MCP endpoint resolution
- ✅ Display the dashboard URL, login credentials, and next steps

After deployment completes, you'll see output like this:

```
============================================================
  AWS DevOps Agent Interactive Demo — Deployment Complete ✓
============================================================

  ➜  Dashboard: https://xxxxxxxxxx.cloudfront.net?api=...
  ➜  Login:     admin@demo.local / <auto-generated-password>
  ➜  Agent Space Console: https://us-east-1.console.aws.amazon.com/aidevops/...
```

### 3. Log in to the dashboard

Open the **Dashboard URL** from the deployment output and sign in with the **Login** credentials shown. The credentials are auto-generated and stored in [AWS Secrets Manager](https://docs.aws.amazon.com/secretsmanager/latest/userguide/intro.html).

### 4. Configure DevOps Agent

Go to the **Configuration** tab on the dashboard. You'll see three sections:

**MCP Server Configuration**
1. Open the **Agent Space console** link shown on the dashboard
2. Navigate to **Capabilities → MCP Servers → Register**
3. Copy the endpoint URL, OAuth Client ID, Client Secret, and Exchange URL from the dashboard into the registration form

**Webhook Configuration**
1. In the Agent Space console, navigate to **Capabilities → Webhooks → Add webhook**
2. Follow the instructions to generate a webhook URL and HMAC secret
3. Paste both values into the webhook form on the dashboard and click **Save webhook**

**S3 Bucket ARNs**

DevOps Agent does not have S3 access by default. To investigate scenarios that rely on VPC Flow Logs (scenarios 1, 2), ELB Access Logs (scenario 5), and PCAP captures (scenario 6), the Agent Space IAM role needs explicit read permissions on the log buckets.

Two specific S3 permissions are required:

| Permission | What it does |
|:-----------|:-------------|
| `s3:ListBucket` | Allows DevOps Agent to list objects in a bucket, so it can discover which log files exist for a given time range |
| `s3:GetObject` | Allows DevOps Agent to download and read individual log files for analysis |

These are read-only permissions scoped to the three specific buckets created by this demo. DevOps Agent cannot write, delete, or modify any objects.

This demo pre-configures the following inline policy on the Agent Space role:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:ListBucket"],
      "Resource": [
        "arn:aws:s3:::vpc-flow-logs-<ACCOUNT_ID>-<REGION>",
        "arn:aws:s3:::vpc-flow-logs-<ACCOUNT_ID>-<REGION>/AWSLogs/*",
        "arn:aws:s3:::elb-access-logs-<ACCOUNT_ID>-<REGION>",
        "arn:aws:s3:::elb-access-logs-<ACCOUNT_ID>-<REGION>/AWSLogs/*",
        "arn:aws:s3:::pcap-analyzer-storage-<ACCOUNT_ID>",
        "arn:aws:s3:::pcap-analyzer-storage-<ACCOUNT_ID>/*"
      ]
    }
  ]
}
```

The actual bucket ARNs for your deployment are displayed on the dashboard's **Configuration** tab. The deploy script also outputs the full IAM policy statement you can copy directly into the Agent Space console if needed.

### 5. Run scenarios

Go to the **Networking Scenarios** tab:

1. Click **Break** on any scenario to trigger a network failure
2. Watch the **Investigation event stream** as DevOps Agent investigates
3. Click the **DevOps Agent** link in the topology diagram to open the Operator Access dashboard and view full investigation findings
4. Click **Fix** to restore the infrastructure

> **Tip:** Only one scenario can be active at a time. Wait for the investigation to complete before clicking Fix.

---

## Dashboard Features

| Feature | Description |
|:--------|:------------|
| 🗺️ **Network Topology** | Animated SVG diagram with traffic flows that turn red when a scenario breaks |
| 🚨 **Alarm Pipeline** | Visual flow from CloudWatch Alarm → SNS → Lambda → DevOps Agent |
| 📡 **Event Stream** | Real-time terminal showing break, alarm, webhook, investigation, and fix events |
| 📱 **Responsive Layout** | Adapts from 4K displays to laptops with fluid font scaling |
| 🌙 **Light/Dark Mode** | Toggle between themes |
| 🔒 **Webhook Gate** | Prevents running scenarios until the webhook is configured |
| 🔗 **Operator Dashboard** | Click the DevOps Agent icon to open the investigation dashboard |

---

## PCAP MCP Server

Scenario 6 uses a custom MCP server running on [Amazon Bedrock AgentCore Runtime](https://docs.aws.amazon.com/devopsagent/latest/userguide/configuring-capabilities-for-aws-devops-agent.html) for packet capture analysis. It wraps the upstream [sample-pcap-analyzer-mcp](https://github.com/aws-samples/sample-pcap-analyzer-mcp) with three enhancements:

| Enhancement | Details |
|:------------|:--------|
| **Transport** | FastMCP with streamable-http (AgentCore compatible) |
| **S3 Support** | Transparently downloads `s3://` URIs before analysis |
| **tshark Fix** | Overrides buggy upstream `summary` mode with valid tshark commands |

See [codebuild-scripts/README.md](codebuild-scripts/README.md) for the full technical deep-dive.

---

## Project Structure

```
.
├── 📁 bin/                    CDK app entry point
├── 📁 lib/                    9 CDK stack definitions
├── 📁 lambda/                 Lambda function handlers
│   ├── dashboard-break/       POST /break — triggers scenario failures
│   ├── dashboard-fix/         POST /fix — restores infrastructure
│   ├── dashboard-config/      GET /config — MCP/OAuth/bucket config
│   ├── dashboard-health/      GET /health — scenario status polling
│   ├── dashboard-events/      GET /events — event stream polling
│   ├── dashboard-eventbridge/  EventBridge rule handler
│   ├── dashboard-webhook-config/ POST /webhook-config
│   ├── webhook/               SNS → DevOps Agent webhook forwarder
│   ├── traffic-generator/     ALB traffic generation
│   ├── build-trigger/         CodeBuild trigger
│   └── build-waiter/          CodeBuild completion waiter
├── 📁 frontend/               Dashboard UI (HTML/CSS/JS)
│   ├── index.html             Main dashboard with SVG topology
│   ├── styles.css             Cloudscape-inspired design tokens
│   ├── app.js                 Dashboard logic and polling
│   └── icons/                 AWS service SVG icons
├── 📁 health-check-app/       EC2 health check application (Node.js)
├── 📁 codebuild-scripts/      PCAP MCP Server Docker build
├── 📁 scripts/                Deploy, destroy, show-outputs scripts
├── 📁 test/                   CDK stack tests
└── 📁 docs/                   Demo assets (GIF, images)
```

---

## Cost Estimate

This demo deploys real AWS resources that incur charges. Estimated costs for **us-east-1**:

| Resource | Spec | Cost/hour |
|:---------|:-----|----------:|
| NAT Gateway | 1x | $0.045 |
| VPC Interface Endpoints | 8x (2 ENIs each) | $0.160 |
| EC2 Instance | t3.medium | $0.042 |
| RDS MySQL | db.t3.micro, 20 GB | $0.017 |
| ALB | 1x | $0.023 |
| CloudFront, Lambda, DynamoDB, S3, Secrets Manager | — | ~$0.00 |
| **Total** | | **~$0.29/hr (~$6.90/day)** |

> 💡 **Quick demo (1-2 hours):** under $1 — **Overnight:** ~$7
>
> ⚠️ **Run `bash scripts/destroy.sh` when done to avoid ongoing charges.**

---

## Clean Up

```bash
bash scripts/destroy.sh
```

The destroy script retries up to 5 times to handle dependency ordering and eventual consistency.

---

## Security

- 🔐 All API Gateway endpoints protected by Cognito authentication
- 🎯 IAM policies scoped to specific resources
- 🔑 Secrets stored in AWS Secrets Manager
- 🛡️ [IMDSv2](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/configuring-instance-metadata-service.html) enforced on EC2 instances
- 🔒 RDS and EBS encryption enabled
- 🌐 CORS scoped to CloudFront distribution domain
- ✅ Security review completed with 0 open findings

---

## Documentation

- [What is AWS DevOps Agent](https://docs.aws.amazon.com/devopsagent/latest/userguide/what-is.html)
- [Getting Started Guide](https://docs.aws.amazon.com/devopsagent/latest/userguide/getting-started-with-aws-devops-agent.html)
- [Working with DevOps Agent](https://docs.aws.amazon.com/devopsagent/latest/userguide/working-with-devops-agent.html)
- [Configuring Capabilities](https://docs.aws.amazon.com/devopsagent/latest/userguide/configuring-capabilities-for-aws-devops-agent.html)
- [API Reference](https://docs.aws.amazon.com/devopsagent/latest/APIReference/Welcome.html)

---

## Contributing

We welcome contributions! See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

---

## License

This library is licensed under the MIT-0 License. See the [LICENSE](LICENSE) file.

---

<p align="center">
  Built with ❤️ using <a href="https://aws.amazon.com/cdk/">AWS CDK</a> and <a href="https://docs.aws.amazon.com/devopsagent/latest/userguide/what-is.html">AWS DevOps Agent</a>
</p>
