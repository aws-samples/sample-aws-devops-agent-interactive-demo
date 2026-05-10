# PCAP MCP Server — CodeBuild Scripts

## Overview

These scripts build and deploy the PCAP Analyzer MCP Server as an [AgentCore Runtime](https://docs.aws.amazon.com/devopsagent/latest/userguide/configuring-capabilities-for-aws-devops-agent.html) container. The server wraps the upstream [sample-pcap-analyzer-mcp](https://github.com/aws-samples/sample-pcap-analyzer-mcp) with fixes for AgentCore compatibility, S3 integration, and tshark bugs.

## Available Tools (29)

Once registered with DevOps Agent, the MCP server provides 29 tools across 6 categories:

### S3 Integration (custom)

| Tool | Description |
|:-----|:------------|
| `list_s3_pcap_files` | List PCAP files in an S3 bucket or prefix |

### General Analysis

| Tool | Description |
|:-----|:------------|
| `analyze_pcap_file` | Analyze a PCAP file with configurable analysis type (summary, protocols, conversations) |
| `list_captured_files` | List all PCAP files in the local storage directory |
| `list_network_interfaces` | List available network interfaces for packet capture |
| `extract_http_requests` | Extract HTTP requests from a PCAP file |
| `search_packet_content` | Search for specific patterns in packet content |

### TLS / Certificate Analysis

| Tool | Description |
|:-----|:------------|
| `analyze_tls_handshakes` | Analyze TLS handshakes including SNI and certificate details |
| `extract_certificate_details` | Extract SSL/TLS certificate details and validate against SNI |
| `analyze_sni_mismatches` | Detect SNI mismatches and correlate with connection resets |
| `analyze_tls_alerts` | Analyze TLS alert messages that indicate handshake failures |
| `extract_tls_cipher_analysis` | Analyze TLS cipher suite negotiations and compatibility issues |

### TCP Analysis

| Tool | Description |
|:-----|:------------|
| `analyze_connection_lifecycle` | Analyze complete connection lifecycle from SYN to FIN/RST |
| `analyze_tcp_retransmissions` | Analyze TCP retransmissions and packet loss patterns |
| `analyze_tcp_zero_window` | Analyze TCP zero window conditions and flow control issues |
| `analyze_tcp_window_scaling` | Analyze TCP window scaling and flow control mechanisms |

### Network Performance

| Tool | Description |
|:-----|:------------|
| `analyze_network_performance` | Analyze network performance metrics from a PCAP file |
| `analyze_network_latency` | Analyze network latency and response times |
| `analyze_packet_timing_issues` | Analyze packet timing issues and duplicate packets |
| `analyze_congestion_indicators` | Analyze network congestion indicators and quality metrics |
| `analyze_bandwidth_utilization` | Analyze bandwidth utilization and traffic patterns |
| `analyze_network_quality_metrics` | Analyze network quality metrics including jitter and packet loss |
| `analyze_application_response_times` | Analyze application layer response times and performance |
| `generate_traffic_timeline` | Generate traffic timeline with specified time intervals |
| `generate_throughput_io_graph` | Generate throughput I/O graph data with specified time intervals |

### Security and Diagnostics

| Tool | Description |
|:-----|:------------|
| `analyze_dns_resolution_issues` | Analyze DNS resolution issues and query patterns |
| `analyze_expert_information` | Analyze Wireshark expert information for network issues |
| `analyze_protocol_anomalies` | Analyze protocol anomalies and malformed packets |
| `analyze_network_topology` | Analyze network topology and routing information |
| `analyze_security_threats` | Analyze potential security threats and suspicious activities |

> All tools that accept a `pcap_file` parameter support both local paths and `s3://` URIs. S3 files are downloaded transparently before analysis.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│ CodeBuild (buildspec-pcap.yml)                          │
│                                                         │
│  1. Clone upstream sample-pcap-analyzer-mcp from GitHub │
│  2. Build Docker image with:                            │
│     - Upstream package installed as library             │
│     - Our server-wrapper.py as the entry point          │
│     - tshark + tcpdump for packet analysis              │
│     - FastMCP + boto3 for transport + S3 access         │
│  3. Push image to ECR                                   │
│  4. Create AgentCore Runtime via CLI                    │
│  5. Store runtime details in SSM Parameters             │
└─────────────────────────────────────────────────────────┘
```

## Files

| File | Purpose |
|------|---------|
| `buildspec-pcap.yml` | CodeBuild buildspec — Dockerfile, image build, runtime creation |
| `server-wrapper.py` | FastMCP wrapper — the actual entry point running in the container |
| `README.md` | This file |

## Why a Wrapper Instead of Patching?

The upstream `sample-pcap-analyzer-mcp` has several issues that prevent it from running directly on AgentCore Runtime:

### 1. MCP SDK Compatibility (Transport)

The upstream server uses the **low-level `mcp.server.Server` class** with decorator-based tool registration (`@self.server.list_tools()`, `@self.server.call_tool()`). This pattern was removed in newer MCP SDK versions (1.20+). The upstream `pyproject.toml` specifies `mcp>=1.17.0`, which resolves to the latest version where these decorators no longer exist.

AgentCore Runtime requires **streamable-http transport** on port 8000. The low-level `Server` class doesn't support `server.run(transport='streamable-http')` — that's a `FastMCP` feature.

**Our fix:** `server-wrapper.py` uses `FastMCP` which has clean streamable-http support. It imports `PCAPAnalyzerServer`, instantiates it (the old MCP SDK handles internal registration), and re-exposes all tools as FastMCP tools that delegate to the upstream implementation.

### 2. No S3 Support

The upstream server only works with **local files** — `_resolve_pcap_path()` checks the local `PCAP_STORAGE_DIR` directory. There's no boto3 or S3 download logic. In our architecture, PCAP files are captured on EC2 instances and uploaded to S3. The MCP server needs to download them from S3 before analysis.

**Our fix:** Every tool that takes a `pcap_file` parameter goes through `_resolve_s3_path()` which transparently handles `s3://` URIs — downloads the file to local temp storage, then passes the local path to the upstream tshark-based analysis. We also added a `list_s3_pcap_files` tool for discovering PCAPs in S3 buckets.

### 3. tshark `proto,colinfo` Bug

The upstream `_analyze_pcap_file()` method with `analysis_type="summary"` uses `-z proto,colinfo` which requires specific arguments (`-z proto,colinfo,<filter>,<field>`). The upstream passes it without the required filter and field, causing tshark to fail with `invalid "-z proto,colinfo,<filter>,<field>" argument`.

**Our fix:** `server-wrapper.py` overrides the `analyze_pcap_file` tool for `summary` and `protocols` analysis types:
- **summary**: Uses `-z conv,tcp` + `-z io,stat,10` (TCP conversations + I/O statistics)
- **protocols**: Uses `-z io,phs` (protocol hierarchy statistics)

All other analysis types delegate to the upstream implementation which works correctly.

## AgentCore Runtime Creation

The runtime is created via **AWS CLI** in CodeBuild, not via CloudFormation. This is critical because:

1. **Image must exist before runtime creation** — CloudFormation creates the runtime resource during stack deployment, which may happen before the image is pushed to ECR. The runtime caches the image at creation time and never re-pulls `:latest`.

2. **CloudFormation can't update the image** — Changing the `ContainerUri` from `:latest` to `:latest` is a no-op for CloudFormation (same string = no change). The runtime keeps using whatever image it pulled at creation time.

3. **CLI creation happens after image push** — CodeBuild pushes the image first, then creates the runtime. The runtime always gets the freshest image.

The buildspec handles conflicts by checking for existing runtimes with the same name and deleting them before creating a new one.

## Runtime Details in SSM

After creating the runtime, CodeBuild writes three SSM parameters:
- `/pcap-mcp/runtime-id` — Runtime ID
- `/pcap-mcp/runtime-arn` — Runtime ARN
- `/pcap-mcp/mcp-endpoint-url` — Full MCP endpoint URL (URL-encoded ARN)

Other CDK stacks (PcapMcpStack, DashboardStack) read these values to configure the dashboard and Agent Space.

## IAM Permissions

The AgentCore execution role (`PcapMcpRuntimeRole`) has:
- **ECR pull** — `AmazonEC2ContainerRegistryReadOnly` managed policy
- **S3 read/write** — PCAP storage bucket (read/write), VPC Flow Logs bucket (read), ELB Access Logs bucket (read)
- **CloudWatch Logs** — Write to `/aws/bedrock-agentcore/runtimes/*`
- **X-Ray** — Trace segments and telemetry
- **CloudWatch Metrics** — `bedrock-agentcore` namespace

## Cognito Authentication

The runtime uses JWT authorization via Cognito:
- **User Pool** — M2M only (client_credentials grant)
- **Resource Server** — Custom scopes for PCAP analysis
- **Discovery URL** — OIDC discovery endpoint for JWT validation
- **Allowed Clients** — The M2M app client ID

## Docker Image Contents

```
python:3.13-slim
├── tshark (packet analysis)
├── tcpdump (packet capture)
├── curl (health checks)
├── awslabs-pcap-analyzer-mcp-server (upstream package)
├── fastmcp (streamable-http transport)
├── boto3 (S3 access)
└── /app/server.py (our server-wrapper.py)
```

**ENTRYPOINT:** `python /app/server.py`
**Port:** 8000 (streamable-http on `/mcp`)
**Health check:** `curl -sf http://localhost:8000/mcp`
