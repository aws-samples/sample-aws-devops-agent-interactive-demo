# Wireshark MCP Server — CodeBuild Scripts

## Overview

These scripts build and deploy the **Wireshark MCP Server** as an [AgentCore Runtime](https://docs.aws.amazon.com/devopsagent/latest/userguide/configuring-capabilities-for-aws-devops-agent.html) container. The server is the open-source [Wireshark MCP](https://github.com/bx33661/Wireshark-MCP) project, run behind a thin wrapper that adds AgentCore transport and S3 ingestion.

## The three enhancements

| Enhancement | Details |
|:------------|:--------|
| **Transport** | Serves FastMCP over `streamable-http` on `0.0.0.0:8000` (AgentCore Runtime compatible). Wireshark MCP supports this transport natively. |
| **S3 support** | Every tool that accepts a pcap path transparently downloads `s3://` URIs before analysis. Injected at the client layer so it applies to all tools. |
| **tshark integration** | Packet dissection and protocol analysis via `tshark` (native to Wireshark MCP). |

## Why a wrapper instead of running it directly?

Wireshark MCP is a clean, production-grade FastMCP server, but the demo needs two things it does not do out of the box:

### 1. AgentCore transport + port

AgentCore Runtime expects `streamable-http` on port `8000`. The upstream default is `stdio` (and `sse`/`streamable-http` default to `127.0.0.1:8080`). The wrapper calls the upstream `_build_server()` bound to `0.0.0.0:8000` and runs it with `transport="streamable-http"`. No upstream code is modified.

### 2. S3 ingestion

In this architecture, PCAPs are captured on EC2 and uploaded to S3; the runtime must pull them from S3 before analysis. The wrapper subclasses `WiresharkSuiteClient` and overrides exactly two seams that every tool routes through:

- `_validate_file()` — resolves a reference (an `s3://` URI, an existing local path, or a bucket-relative/local-looking guess) to a local copy under `/tmp/pcap_storage` and validates it.
- `_run_command()` — rewrites the tshark input file (`-r`) and any `s3://` tokens to their local paths.

Because all upstream tools call these two methods, the entire tool surface becomes S3-aware with no per-tool changes. The `_resolve_ref()` helper also maps local-looking paths the agent may invent (e.g. `/tmp/captures/incident-X.pcap`) back to the capture bucket, so analysis works regardless of how the agent references the file. A `list_s3_pcap_files` tool is added for discovery.

## Custom tools added by the wrapper

| Tool | Description |
|:-----|:------------|
| `list_s3_pcap_files` | List `.pcap`/`.pcapng`/`.cap` files in an S3 bucket or prefix |

All upstream Wireshark MCP tools (packet list/details, follow stream, extract fields, `wireshark_extract_tls_handshakes`, stats, security audit, etc.) remain available and are automatically S3-aware. See the upstream [tool reference](https://github.com/bx33661/Wireshark-MCP) for the full list.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│ CodeBuild (buildspec-pcap.yml)                          │
│                                                         │
│  1. Build Docker image with:                            │
│     - wireshark-mcp installed from PyPI (pinned)        │
│     - server.py (our S3 streamable-http wrapper)        │
│     - tshark + tcpdump for packet analysis              │
│     - boto3 for S3 access                               │
│  2. Push image to ECR                                   │
│  3. Create/update AgentCore Runtime via CLI             │
│  4. Store runtime details in SSM Parameters             │
└─────────────────────────────────────────────────────────┘
```

## Files

| File | Purpose |
|------|---------|
| `buildspec-pcap.yml` | CodeBuild buildspec — Dockerfile, image build, runtime creation/update |
| `server-wrapper.py` | The S3 streamable-http wrapper; container entry point (copied in as `server.py`) |
| `README.md` | This file |

## Pinning

The image installs Wireshark MCP from a **pinned PyPI release** via the `WIRESHARK_MCP_VERSION` Docker build arg (default `1.1.5`, set in `buildspec-pcap.yml`). PyPI wheels install without a source build, which avoids an upstream hatchling `force-include` duplicate-file error that occurs when building from a full git checkout. The wrapper relies on upstream internals (`_build_server`, `WiresharkSuiteClient._validate_file`, `._run_command`), so bump the version deliberately and re-test after upgrading.

## AgentCore Runtime creation

The runtime is created (or updated) via **AWS CLI** in CodeBuild, not CloudFormation, because:

1. **Image must exist before runtime creation** — the runtime caches the image at creation time and never re-pulls `:latest`.
2. **CloudFormation can't update the image** — `:latest` → `:latest` is a no-op, so the runtime keeps its original image.
3. **CLI creation happens after image push** — CodeBuild pushes first, then creates/updates the runtime, so it always gets the freshest image.

If a runtime already exists (recorded in SSM), the build **updates it in place** so the runtime ARN / MCP endpoint stays the same and no re-registration in Agent Space is needed.

## Runtime details in SSM

After creating the runtime, CodeBuild writes three SSM parameters consumed by other stacks (PcapMcpStack, DashboardStack):
- `/pcap-mcp/runtime-id`
- `/pcap-mcp/runtime-arn`
- `/pcap-mcp/mcp-endpoint-url`

## IAM permissions

The AgentCore execution role (`PcapMcpRuntimeRole`) has: ECR pull, S3 read/write on the capture bucket, S3 read on the VPC Flow Logs and ELB Access Logs buckets, CloudWatch Logs write, X-Ray, and CloudWatch metrics in the `bedrock-agentcore` namespace.

## Cognito authentication

The runtime uses JWT authorization via Cognito (M2M `client_credentials`), validated against the OIDC discovery URL with the M2M app client allow-listed.

## Docker image contents

```
python:3.13-slim
├── tshark (packet analysis)
├── tcpdump (packet capture)
├── curl (health checks)
├── wireshark-mcp (open-source server, pinned)
├── boto3 (S3 access)
└── /app/server.py (S3 streamable-http wrapper)
```

**ENTRYPOINT:** `python /app/server.py`
**Port:** 8000 (streamable-http on `/mcp`)
**Health check:** `curl -sf http://localhost:8000/mcp`
