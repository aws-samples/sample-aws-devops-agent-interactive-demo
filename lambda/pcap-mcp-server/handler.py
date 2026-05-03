"""
PCAP MCP Server — Placeholder handler.

This Lambda is deployed behind AgentCore Gateway and provides PCAP analysis
capabilities using tshark. The actual MCP server implementation comes from
the sample-pcap-analyzer-mcp repository:
  https://github.com/aws-samples/sample-pcap-analyzer-mcp

Replace this placeholder with the real implementation after deployment.
"""

import json
import os


def handler(event, context):
    """Placeholder handler for the PCAP MCP Server Lambda."""
    return {
        "statusCode": 200,
        "body": json.dumps(
            {
                "message": "PCAP MCP Server placeholder. Deploy the real implementation from sample-pcap-analyzer-mcp.",
                "pcap_bucket": os.environ.get("PCAP_BUCKET_NAME", ""),
            }
        ),
    }
