"""
CloudFormation CustomResource Lambda handler that triggers a CodeBuild build.

Used with CDK Provider framework — returns data dict, does NOT send
CloudFormation responses directly (the Provider framework handles that).

Requirements: 6.3
"""

import json
import logging
import boto3

logger = logging.getLogger()
logger.setLevel(logging.INFO)

codebuild = boto3.client("codebuild")


def handler(event, context):
    """CDK Provider onEvent handler for triggering CodeBuild builds.
    
    Returns a dict with PhysicalResourceId and Data.
    The Provider framework sends the CloudFormation response.
    """
    logger.info("Received event: %s", json.dumps(event))

    request_type = event.get("RequestType", "")
    properties = event.get("ResourceProperties", {})

    if request_type == "Delete":
        logger.info("Delete request — no-op")
        return {
            "PhysicalResourceId": event.get("PhysicalResourceId", "none"),
            "Data": {"BuildId": "NONE"},
        }

    # Create and Update both trigger a new build
    project_name = properties.get("ProjectName")
    if not project_name:
        raise ValueError("ProjectName is required in ResourceProperties")

    logger.info("Starting CodeBuild project: %s", project_name)
    response = codebuild.start_build(projectName=project_name)
    build_id = response["build"]["id"]
    logger.info("Build started: %s", build_id)

    return {
        "PhysicalResourceId": build_id,
        "Data": {"BuildId": build_id},
    }
