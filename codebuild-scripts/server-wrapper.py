"""
PCAP Analyzer MCP Server — AgentCore Runtime Wrapper.

This is the entry point for the PCAP MCP Server container running on
Amazon Bedrock AgentCore Runtime. It wraps the upstream
sample-pcap-analyzer-mcp (https://github.com/aws-samples/sample-pcap-analyzer-mcp)
with three key fixes:

1. TRANSPORT: Uses FastMCP with streamable-http transport (the upstream uses
   the low-level mcp.server.Server with stdio transport and decorator-based
   registration which is incompatible with newer MCP SDK versions).

2. S3 SUPPORT: All tools that accept pcap_file transparently handle s3:// URIs
   by downloading the file locally before analysis. The upstream only supports
   local file paths.

3. TSHARK FIX: The upstream analyze_pcap_file 'summary' mode uses an invalid
   tshark argument (-z proto,colinfo without required filter/field params).
   We override it with valid tshark commands (-z conv,tcp + -z io,stat,10).

See codebuild-scripts/README.md for full documentation.
"""
import os
import logging
import hashlib
import json

os.environ["PCAP_STORAGE_DIR"] = os.environ.get("PCAP_STORAGE_DIR", "/tmp/pcap_storage")
os.environ["WIRESHARK_PATH"] = os.environ.get("WIRESHARK_PATH", "/usr/bin/tshark")

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

import boto3
from mcp.server.fastmcp import FastMCP
from awslabs.pcap_analyzer_mcp_server.server import PCAPAnalyzerServer

# Create FastMCP app (AgentCore compatible)
mcp = FastMCP("pcap-analyzer", host="0.0.0.0", port=8000, stateless_http=True)

# Create the upstream server to reuse its tool implementations
_pcap = PCAPAnalyzerServer()

# S3 client for downloading PCAP files
_s3 = boto3.client("s3")

PCAP_STORAGE_DIR = os.environ["PCAP_STORAGE_DIR"]


def _resolve_s3_path(pcap_file: str) -> str:
    """If pcap_file is an S3 URI (s3://bucket/key), download it locally and return the local path.
    If it's already a local path, return as-is."""
    if not pcap_file.startswith("s3://"):
        return pcap_file

    # Parse s3://bucket/key
    path = pcap_file[5:]  # strip "s3://"
    bucket, _, key = path.partition("/")
    if not bucket or not key:
        raise ValueError(f"Invalid S3 URI: {pcap_file}. Expected s3://bucket/key")

    # Create a deterministic local filename based on the S3 path
    filename = os.path.basename(key)
    if not filename.endswith(".pcap"):
        filename += ".pcap"
    # Add hash prefix to avoid collisions
    path_hash = hashlib.md5(pcap_file.encode()).hexdigest()[:8]
    local_path = os.path.join(PCAP_STORAGE_DIR, f"{path_hash}_{filename}")

    # Download if not already cached
    if not os.path.exists(local_path):
        logger.info(f"Downloading {pcap_file} to {local_path}")
        _s3.download_file(bucket, key, local_path)
        logger.info(f"Downloaded {os.path.getsize(local_path)} bytes")
    else:
        logger.info(f"Using cached file: {local_path}")

    return local_path


# ---------------------------------------------------------------------------
# S3-aware tool: list PCAP files in an S3 bucket prefix
# ---------------------------------------------------------------------------
@mcp.tool()
async def list_s3_pcap_files(s3_uri: str) -> str:
    """List PCAP files in an S3 bucket/prefix. Pass s3://bucket or s3://bucket/prefix."""
    try:
        path = s3_uri.replace("s3://", "")
        bucket, _, prefix = path.partition("/")
        resp = _s3.list_objects_v2(Bucket=bucket, Prefix=prefix)
        files = []
        for obj in resp.get("Contents", []):
            if obj["Key"].endswith(".pcap"):
                files.append({
                    "key": obj["Key"],
                    "s3_uri": f"s3://{bucket}/{obj['Key']}",
                    "size_bytes": obj["Size"],
                    "last_modified": obj["LastModified"].isoformat(),
                })
        return json.dumps({"bucket": bucket, "prefix": prefix, "pcap_files": files, "total": len(files)}, indent=2)
    except Exception as e:
        return json.dumps({"error": str(e)})


# ---------------------------------------------------------------------------
# All analysis tools — S3-aware via _resolve_s3_path
# ---------------------------------------------------------------------------
@mcp.tool()
async def analyze_pcap_file(pcap_file: str, analysis_type: str = "summary", display_filter: str = "") -> str:
    """Analyze a pcap file and generate insights. Supports s3:// URIs."""
    import asyncio
    local = _resolve_s3_path(pcap_file)
    
    # Override the buggy upstream 'summary' and 'protocols' analysis types
    # which use invalid tshark '-z proto,colinfo' arguments
    if analysis_type in ("summary", "protocols"):
        tshark = os.environ.get("WIRESHARK_PATH", "tshark")
        if analysis_type == "summary":
            args = [tshark, "-r", local, "-q", "-z", "conv,tcp", "-z", "io,stat,10"]
        else:
            args = [tshark, "-r", local, "-q", "-z", "io,phs"]
        if display_filter:
            args.extend(["-Y", display_filter])
        proc = await asyncio.create_subprocess_exec(
            *args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
        )
        stdout, stderr = await proc.communicate()
        output = stdout.decode() if proc.returncode == 0 else f"Error: {stderr.decode()}"
        return json.dumps({"pcap_file": pcap_file, "analysis_type": analysis_type, "filter": display_filter, "analysis_output": output}, indent=2)
    
    # For other analysis types, delegate to upstream
    r = await _pcap._analyze_pcap_file(local, analysis_type, display_filter or None)
    return r[0].text


@mcp.tool()
async def analyze_tls_handshakes(pcap_file: str) -> str:
    """Analyze TLS handshakes including SNI, certificate details. Supports s3:// URIs."""
    local = _resolve_s3_path(pcap_file)
    r = await _pcap._analyze_tls_handshakes(local)
    return r[0].text


@mcp.tool()
async def extract_certificate_details(pcap_file: str) -> str:
    """Extract SSL certificate details and validate against SNI. Supports s3:// URIs."""
    local = _resolve_s3_path(pcap_file)
    r = await _pcap._extract_certificate_details(local)
    return r[0].text


@mcp.tool()
async def analyze_sni_mismatches(pcap_file: str) -> str:
    """Analyze SNI mismatches and correlate with connection resets. Supports s3:// URIs."""
    local = _resolve_s3_path(pcap_file)
    r = await _pcap._analyze_sni_mismatches(local)
    return r[0].text


@mcp.tool()
async def analyze_tls_alerts(pcap_file: str) -> str:
    """Analyze TLS alert messages that indicate handshake failures. Supports s3:// URIs."""
    local = _resolve_s3_path(pcap_file)
    r = await _pcap._analyze_tls_alerts(local)
    return r[0].text


@mcp.tool()
async def analyze_connection_lifecycle(pcap_file: str) -> str:
    """Analyze complete connection lifecycle from SYN to FIN/RST. Supports s3:// URIs."""
    local = _resolve_s3_path(pcap_file)
    r = await _pcap._analyze_connection_lifecycle(local)
    return r[0].text


@mcp.tool()
async def extract_tls_cipher_analysis(pcap_file: str) -> str:
    """Analyze TLS cipher suite negotiations and compatibility issues. Supports s3:// URIs."""
    local = _resolve_s3_path(pcap_file)
    r = await _pcap._extract_tls_cipher_analysis(local)
    return r[0].text


@mcp.tool()
async def analyze_tcp_retransmissions(pcap_file: str) -> str:
    """Analyze TCP retransmissions and packet loss patterns. Supports s3:// URIs."""
    local = _resolve_s3_path(pcap_file)
    r = await _pcap._analyze_tcp_retransmissions(local)
    return r[0].text


@mcp.tool()
async def analyze_tcp_zero_window(pcap_file: str) -> str:
    """Analyze TCP zero window conditions and flow control issues. Supports s3:// URIs."""
    local = _resolve_s3_path(pcap_file)
    r = await _pcap._analyze_tcp_zero_window(local)
    return r[0].text


@mcp.tool()
async def analyze_tcp_window_scaling(pcap_file: str) -> str:
    """Analyze TCP window scaling and flow control mechanisms. Supports s3:// URIs."""
    local = _resolve_s3_path(pcap_file)
    r = await _pcap._analyze_tcp_window_scaling(local)
    return r[0].text


@mcp.tool()
async def analyze_packet_timing_issues(pcap_file: str) -> str:
    """Analyze packet timing issues and duplicate packets. Supports s3:// URIs."""
    local = _resolve_s3_path(pcap_file)
    r = await _pcap._analyze_packet_timing_issues(local)
    return r[0].text


@mcp.tool()
async def analyze_congestion_indicators(pcap_file: str) -> str:
    """Analyze network congestion indicators and quality metrics. Supports s3:// URIs."""
    local = _resolve_s3_path(pcap_file)
    r = await _pcap._analyze_congestion_indicators(local)
    return r[0].text


@mcp.tool()
async def analyze_dns_resolution_issues(pcap_file: str) -> str:
    """Analyze DNS resolution issues and query patterns. Supports s3:// URIs."""
    local = _resolve_s3_path(pcap_file)
    r = await _pcap._analyze_dns_resolution_issues(local)
    return r[0].text


@mcp.tool()
async def analyze_network_performance(pcap_file: str) -> str:
    """Analyze network performance metrics from pcap file. Supports s3:// URIs."""
    local = _resolve_s3_path(pcap_file)
    r = await _pcap._analyze_network_performance(local)
    return r[0].text


@mcp.tool()
async def analyze_network_latency(pcap_file: str) -> str:
    """Analyze network latency and response times. Supports s3:// URIs."""
    local = _resolve_s3_path(pcap_file)
    r = await _pcap._analyze_network_latency(local)
    return r[0].text


@mcp.tool()
async def analyze_expert_information(pcap_file: str, severity_filter: str = "") -> str:
    """Analyze Wireshark expert information for network issues. Supports s3:// URIs."""
    local = _resolve_s3_path(pcap_file)
    r = await _pcap._analyze_expert_information(local, severity_filter or None)
    return r[0].text


@mcp.tool()
async def analyze_protocol_anomalies(pcap_file: str) -> str:
    """Analyze protocol anomalies and malformed packets. Supports s3:// URIs."""
    local = _resolve_s3_path(pcap_file)
    r = await _pcap._analyze_protocol_anomalies(local)
    return r[0].text


@mcp.tool()
async def analyze_network_topology(pcap_file: str) -> str:
    """Analyze network topology and routing information. Supports s3:// URIs."""
    local = _resolve_s3_path(pcap_file)
    r = await _pcap._analyze_network_topology(local)
    return r[0].text


@mcp.tool()
async def analyze_security_threats(pcap_file: str) -> str:
    """Analyze potential security threats and suspicious activities. Supports s3:// URIs."""
    local = _resolve_s3_path(pcap_file)
    r = await _pcap._analyze_security_threats(local)
    return r[0].text


@mcp.tool()
async def list_captured_files() -> str:
    """List all captured pcap files in the local storage directory."""
    r = await _pcap._list_captured_files()
    return r[0].text


@mcp.tool()
async def list_network_interfaces() -> str:
    """List available network interfaces for packet capture."""
    r = await _pcap._list_network_interfaces()
    return r[0].text


@mcp.tool()
async def extract_http_requests(pcap_file: str, limit: int = 100) -> str:
    """Extract HTTP requests from pcap file. Supports s3:// URIs."""
    local = _resolve_s3_path(pcap_file)
    r = await _pcap._extract_http_requests(local, limit)
    return r[0].text


@mcp.tool()
async def generate_traffic_timeline(pcap_file: str, time_interval: int = 60) -> str:
    """Generate traffic timeline with specified time intervals. Supports s3:// URIs."""
    local = _resolve_s3_path(pcap_file)
    r = await _pcap._generate_traffic_timeline(local, time_interval)
    return r[0].text


@mcp.tool()
async def search_packet_content(pcap_file: str, search_pattern: str, case_sensitive: bool = False, limit: int = 50) -> str:
    """Search for specific patterns in packet content. Supports s3:// URIs."""
    local = _resolve_s3_path(pcap_file)
    r = await _pcap._search_packet_content(local, search_pattern, case_sensitive, limit)
    return r[0].text


@mcp.tool()
async def generate_throughput_io_graph(pcap_file: str, time_interval: int = 1) -> str:
    """Generate throughput I/O graph data with specified time intervals. Supports s3:// URIs."""
    local = _resolve_s3_path(pcap_file)
    r = await _pcap._generate_throughput_io_graph(local, time_interval)
    return r[0].text


@mcp.tool()
async def analyze_bandwidth_utilization(pcap_file: str, time_window: int = 10) -> str:
    """Analyze bandwidth utilization and traffic patterns. Supports s3:// URIs."""
    local = _resolve_s3_path(pcap_file)
    r = await _pcap._analyze_bandwidth_utilization(local, time_window)
    return r[0].text


@mcp.tool()
async def analyze_application_response_times(pcap_file: str, protocol: str = "http") -> str:
    """Analyze application layer response times and performance. Supports s3:// URIs."""
    local = _resolve_s3_path(pcap_file)
    r = await _pcap._analyze_application_response_times(local, protocol)
    return r[0].text


@mcp.tool()
async def analyze_network_quality_metrics(pcap_file: str) -> str:
    """Analyze network quality metrics including jitter and packet loss. Supports s3:// URIs."""
    local = _resolve_s3_path(pcap_file)
    r = await _pcap._analyze_network_quality_metrics(local)
    return r[0].text


if __name__ == "__main__":
    logger.info("Starting PCAP Analyzer MCP Server on 0.0.0.0:8000/mcp")
    mcp.run(transport="streamable-http")
