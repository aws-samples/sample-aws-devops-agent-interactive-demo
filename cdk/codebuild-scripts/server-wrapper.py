"""
Wireshark MCP Server — AgentCore Runtime Wrapper.

Entry point for the packet-capture MCP server container running on
Amazon Bedrock AgentCore Runtime. It wraps the open-source
Wireshark MCP project (https://github.com/bx33661/Wireshark-MCP) with
the same three enhancements described in the blog post, without modifying
the upstream package:

1. TRANSPORT: Serves FastMCP over streamable-http on 0.0.0.0:8000
   (AgentCore Runtime compatible). Wireshark MCP supports this transport
   natively; we build its server and run it on the AgentCore port.

2. S3 SUPPORT: Every tool that accepts a pcap path transparently handles
   s3:// URIs (and bucket-relative references) by downloading the object
   locally before analysis. Injected at the WiresharkSuiteClient layer so
   it applies to ALL upstream tools uniformly. A list_s3_pcap_files tool is
   also added for discovering captures in a bucket/prefix.

3. TSHARK INTEGRATION: Packet dissection and protocol analysis via tshark
   (provided natively by Wireshark MCP).

See codebuild-scripts/README.md for the full technical deep-dive.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
from urllib.parse import urlparse

# --- Environment defaults -------------------------------------------------
# Where S3 objects are downloaded to and the only directory tshark is allowed
# to read from (defense in depth — the upstream client honors this sandbox).
PCAP_STORAGE_DIR = os.environ.setdefault("PCAP_STORAGE_DIR", "/tmp/pcap_storage")
os.environ.setdefault("WIRESHARK_MCP_ALLOWED_DIRS", PCAP_STORAGE_DIR)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("wireshark-mcp-agentcore")

import boto3  # noqa: E402
import wireshark_mcp.server as wsrv  # noqa: E402
from wireshark_mcp.tshark.client import WiresharkSuiteClient  # noqa: E402

os.makedirs(PCAP_STORAGE_DIR, exist_ok=True)
_s3 = boto3.client("s3")

# Capture bucket for resolving bare/local-looking pcap references the agent may
# pass (e.g. "/tmp/captures/incident-X.pcap" or "captures/incident-X.pcap").
# Falls back to the demo's conventional name pcap-analyzer-storage-<account>.
PCAP_BUCKET_ENV = os.environ.get("PCAP_BUCKET", "")
_PCAP_BUCKET = None  # type: str | None


def _account_pcap_bucket() -> str:
    global _PCAP_BUCKET
    if _PCAP_BUCKET is None:
        if PCAP_BUCKET_ENV:
            _PCAP_BUCKET = PCAP_BUCKET_ENV
        else:
            try:
                acct = boto3.client("sts").get_caller_identity()["Account"]
                _PCAP_BUCKET = f"pcap-analyzer-storage-{acct}"
            except Exception:
                _PCAP_BUCKET = ""
    return _PCAP_BUCKET


def _looks_like_s3(token: object) -> bool:
    return isinstance(token, str) and token.startswith("s3://")


def _download_s3(s3_uri: str) -> str:
    """Download an s3://bucket/key object into PCAP_STORAGE_DIR and return the
    local path. Cached on disk by a hash of the URI to avoid re-downloading."""
    parsed = urlparse(s3_uri)
    bucket, key = parsed.netloc, parsed.path.lstrip("/")
    if not bucket or not key:
        raise ValueError(f"Invalid S3 URI: {s3_uri}. Expected s3://bucket/key")

    filename = os.path.basename(key) or "object"
    path_hash = hashlib.sha256(s3_uri.encode("utf-8")).hexdigest()[:8]
    local_path = os.path.join(PCAP_STORAGE_DIR, f"{path_hash}_{filename}")

    if not os.path.exists(local_path):
        logger.info("Downloading %s -> %s", s3_uri, local_path)
        _s3.download_file(bucket, key, local_path)
        logger.info("Downloaded %d bytes", os.path.getsize(local_path))
    else:
        logger.info("Using cached download: %s", local_path)
    return local_path


class S3WiresharkSuiteClient(WiresharkSuiteClient):
    """Wireshark suite client that transparently localizes S3 references.

    All upstream tools route file access through `_validate_file` (path
    checks) and `_run_command` (actual tshark invocation). By overriding
    just these two seams, every tool becomes S3-aware without touching the
    upstream tool definitions.
    """

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._s3_cache: dict[str, str] = {}

    def _localize(self, token: str) -> str:
        """Resolve an s3:// token to a local path (cached). Pass-through for
        anything that is not an S3 URI."""
        if not _looks_like_s3(token):
            return token
        if token not in self._s3_cache:
            self._s3_cache[token] = _download_s3(token)
        return self._s3_cache[token]

    def _resolve_ref(self, ref: str) -> str:
        """Resolve any capture reference the agent might pass into a local path:
          - s3://bucket/key            -> download
          - an existing local file     -> use as-is
          - a local-looking guess      -> fetch the matching object from the
            capture bucket (e.g. "/tmp/captures/incident-X.pcap",
            "captures/incident-X.pcap", or just "incident-X.pcap")
        The upstream tools don't advertise s3:// support, so the agent tends to
        invent local paths; this maps those back to S3 so analysis just works.
        Anything unresolvable is returned unchanged for normal error handling."""
        if not isinstance(ref, str) or not ref:
            return ref
        if _looks_like_s3(ref):
            return self._localize(ref)
        if os.path.exists(ref):
            return ref
        bucket = _account_pcap_bucket()
        if not bucket:
            return ref
        base = os.path.basename(ref)
        candidates = []
        if "captures/" in ref:
            candidates.append(ref[ref.index("captures/"):])
        candidates.append(f"captures/{base}")
        candidates.append(base)
        seen = set()
        for key in candidates:
            if not key or key in seen:
                continue
            seen.add(key)
            try:
                return self._localize(f"s3://{bucket}/{key}")
            except Exception:
                continue
        return ref

    # 1) Validation: accept s3:// / bucket refs by validating the localized copy.
    def _validate_file(self, filepath: str):
        try:
            return super()._validate_file(self._resolve_ref(filepath))
        except Exception as e:  # download / parse failure -> structured error
            return {"success": False, "error": {"type": "S3Error", "message": str(e)}}

    # 2) Execution: resolve the input file (-r) and any remaining s3:// tokens.
    async def _run_command(self, cmd, *args, **kwargs):
        new_cmd: list[str] = list(cmd)

        # Resolve the tshark input file (-r <ref>) — handles s3://, local, or
        # bucket-relative references the agent may have invented.
        if "-r" in new_cmd:
            r_idx = new_cmd.index("-r")
            if r_idx + 1 < len(new_cmd):
                new_cmd[r_idx + 1] = self._resolve_ref(new_cmd[r_idx + 1])

        # Resolve any remaining s3:// tokens.
        for i, tok in enumerate(new_cmd):
            if _looks_like_s3(tok):
                new_cmd[i] = self._localize(tok)

        return await super()._run_command(new_cmd, *args, **kwargs)


# Inject the S3-aware client into the upstream server builder. _build_server
# references WiresharkSuiteClient as a module global, so patching the name is
# enough to make the whole tool surface S3-aware.
wsrv.WiresharkSuiteClient = S3WiresharkSuiteClient

# Build the full upstream server (all tools, resources, prompts) bound to the
# AgentCore host/port.
mcp = wsrv._build_server(host="0.0.0.0", port=8000, log_level="INFO")


# ---------------------------------------------------------------------------
# Additional S3 discovery tool (custom to this AgentCore wrapper)
# ---------------------------------------------------------------------------
@mcp.tool()
async def list_s3_pcap_files(s3_uri: str) -> str:
    """List PCAP/capture files in an S3 bucket or prefix.

    Pass s3://bucket or s3://bucket/prefix. Returns .pcap / .pcapng / .cap files.
    """
    try:
        parsed = urlparse(s3_uri)
        bucket, prefix = parsed.netloc, parsed.path.lstrip("/")
        paginator = _s3.get_paginator("list_objects_v2")
        files = []
        for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
            for obj in page.get("Contents", []):
                if obj["Key"].lower().endswith((".pcap", ".pcapng", ".cap")):
                    files.append({
                        "key": obj["Key"],
                        "s3_uri": f"s3://{bucket}/{obj['Key']}",
                        "size_bytes": obj["Size"],
                        "last_modified": obj["LastModified"].isoformat(),
                    })
        return json.dumps(
            {"bucket": bucket, "prefix": prefix, "capture_files": files, "total": len(files)},
            indent=2,
        )
    except Exception as e:
        return json.dumps({"success": False, "error": {"type": "S3Error", "message": str(e)}})


# ---------------------------------------------------------------------------
# Tool allowlist — prune the surface to the tools this DevOps Agent workflow
# actually uses. This (a) removes the vulnerable wireshark_export_objects tool
# (CVE-2026-43901) and other unused tools, (b) keeps the agent focused, and
# (c) reduces token usage. Adjust ALLOWED_TOOLS to expose more if needed.
# ---------------------------------------------------------------------------
ALLOWED_TOOLS = {
    # custom S3 discovery
    "list_s3_pcap_files",
    # entry / overview
    "wireshark_open_file",
    "wireshark_quick_analysis",
    "wireshark_get_file_info",
    # packet inspection / navigation
    "wireshark_get_packet_list",
    "wireshark_get_packet_details",
    "wireshark_get_packet_bytes",
    "wireshark_get_packet_context",
    "wireshark_follow_stream",
    "wireshark_search_packets",
    # extraction (incl. TLS/SNI + DNS for the SNI mismatch scenario)
    "wireshark_extract_fields",
    "wireshark_extract_tls_handshakes",
    "wireshark_extract_dns_queries",
    "wireshark_extract_http_requests",
    "wireshark_list_ips",
    # statistics
    "wireshark_stats_conversations",
    "wireshark_stats_endpoints",
    "wireshark_stats_protocol_hierarchy",
    "wireshark_stats_expert_info",
    # tcp health + decode
    "wireshark_analyze_tcp_health",
    "wireshark_decode_payload",
}


def _prune_tools(server) -> None:
    tm = getattr(server, "_tool_manager", None)
    if tm is None or not hasattr(tm, "_tools"):
        logger.warning("Could not access tool manager; tool allowlist not applied")
        return
    removed = []
    for name in list(tm._tools.keys()):
        if name not in ALLOWED_TOOLS:
            try:
                tm.remove_tool(name)
            except Exception:
                tm._tools.pop(name, None)
            removed.append(name)
    logger.info("Tool allowlist applied: kept %d, removed %d (incl. export_objects/CVE)",
                len(tm._tools), len(removed))


_prune_tools(mcp)


if __name__ == "__main__":
    logger.info("Starting Wireshark MCP Server (streamable-http) on 0.0.0.0:8000/mcp")
    mcp.run(transport="streamable-http")
