"""
CloudFormation CustomResource Lambda handler that waits for a CodeBuild build
to complete.

Used with CDK Provider framework — returns data dict, does NOT send
CloudFormation responses directly (the Provider framework handles that).

Requirements: 6.3
"""

import json
import logging
import time
import boto3

logger = logging.getLogger()
logger.setLevel(logging.INFO)

codebuild = boto3.client("codebuild")

SUCCEEDED = "SUCCEEDED"
FAILED = "FAILED"
FAULT = "FAULT"
STOPPED = "STOPPED"
TIMED_OUT = "TIMED_OUT"

TERMINAL_STATUSES = {SUCCEEDED, FAILED, FAULT, STOPPED, TIMED_OUT}
POLL_INTERVAL_SECONDS = 30


def handler(event, context):
    """CDK Provider onEvent handler for waiting on CodeBuild builds.
    
    Returns a dict with PhysicalResourceId and Data.
    Raises an exception on build failure (Provider framework signals FAILED).
    """
    logger.info("Received event: %s", json.dumps(event))

    request_type = event.get("RequestType", "")
    properties = event.get("ResourceProperties", {})

    if request_type == "Delete":
        logger.info("Delete request — no-op")
        return {
            "PhysicalResourceId": event.get("PhysicalResourceId", "none"),
            "Data": {"BuildStatus": "SKIPPED"},
        }

    build_id = properties.get("BuildId")
    if not build_id:
        raise ValueError("BuildId is required in ResourceProperties")

    logger.info("Waiting for build: %s", build_id)
    build_status, status_reason = poll_build(build_id, context)

    if build_status == SUCCEEDED:
        logger.info("Build succeeded: %s", build_id)
        return {
            "PhysicalResourceId": build_id,
            "Data": {"BuildStatus": SUCCEEDED},
        }
    else:
        reason = f"Build {build_id} ended with status {build_status}"
        if status_reason:
            reason += f": {status_reason}"
        logger.error(reason)
        raise RuntimeError(reason)


def poll_build(build_id, context):
    """Poll CodeBuild until the build reaches a terminal status."""
    while True:
        remaining_ms = context.get_remaining_time_in_millis()
        if remaining_ms < 60_000:
            logger.warning("Less than 60s remaining (%dms) — stopping poll", remaining_ms)
            return TIMED_OUT, "Lambda execution time limit approaching"

        response = codebuild.batch_get_builds(ids=[build_id])
        builds = response.get("builds", [])

        if not builds:
            return FAILED, f"Build {build_id} not found"

        build = builds[0]
        build_status = build.get("buildStatus", "UNKNOWN")
        logger.info("Build %s status: %s", build_id, build_status)

        if build_status in TERMINAL_STATUSES:
            reason = ""
            if build_status != SUCCEEDED:
                reason = extract_failure_reason(build)
            return build_status, reason

        logger.info("Build in progress — waiting %ds", POLL_INTERVAL_SECONDS)
        time.sleep(POLL_INTERVAL_SECONDS)


def extract_failure_reason(build):
    """Extract a human-readable failure reason from the build phases."""
    phases = build.get("phases", [])
    for phase in reversed(phases):
        phase_status = phase.get("phaseStatus", "")
        if phase_status in (FAILED, FAULT, TIMED_OUT, STOPPED):
            contexts = phase.get("contexts", [])
            if contexts:
                messages = [ctx.get("message", "") for ctx in contexts if ctx.get("message")]
                if messages:
                    return f"Phase {phase.get('phaseType', 'UNKNOWN')} failed: {'; '.join(messages)}"
            return f"Phase {phase.get('phaseType', 'UNKNOWN')} ended with status {phase_status}"
    return build.get("buildStatus", "UNKNOWN")
