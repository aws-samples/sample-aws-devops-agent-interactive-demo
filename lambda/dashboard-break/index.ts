/**
 * Dashboard Break Lambda — POST /break
 *
 * Triggers a break for the specified scenarioId (1-6).
 * All infrastructure changes are made via a separate "network-ops-role"
 * so CloudTrail shows a realistic operator identity, not the Lambda function.
 */

import { DynamoDBClient, PutItemCommand, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';
import {
  EC2Client,
  RevokeSecurityGroupIngressCommand,
  DeleteRouteCommand,
  ModifyVpcEndpointCommand,
} from '@aws-sdk/client-ec2';
import { SSMClient, SendCommandCommand } from '@aws-sdk/client-ssm';
import { randomUUID } from 'crypto';

const ddb = new DynamoDBClient({});
const sts = new STSClient({});
const TABLE_NAME = process.env.EVENTS_TABLE_NAME!;
const NETWORK_OPS_ROLE_ARN = process.env.NETWORK_OPS_ROLE_ARN!;

const corsHeaders = {
  'Access-Control-Allow-Origin': process.env.ALLOWED_ORIGIN!,
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
};

/** Assume the network-ops-role and return configured clients */
async function getOpsClients() {
  const creds = await sts.send(new AssumeRoleCommand({
    RoleArn: NETWORK_OPS_ROLE_ARN,
    RoleSessionName: 'ops-session',
    DurationSeconds: 900,
  }));
  const credentials = {
    accessKeyId: creds.Credentials!.AccessKeyId!,
    secretAccessKey: creds.Credentials!.SecretAccessKey!,
    sessionToken: creds.Credentials!.SessionToken!,
  };
  return {
    ec2: new EC2Client({ credentials }),
    ssm: new SSMClient({ credentials }),
  };
}

async function breakScenario1(ec2: EC2Client): Promise<string> {
  await ec2.send(new RevokeSecurityGroupIngressCommand({
    GroupId: process.env.RDS_SECURITY_GROUP_ID!,
    IpPermissions: [{ IpProtocol: 'tcp', FromPort: 3306, ToPort: 3306, UserIdGroupPairs: [{ GroupId: process.env.EC2_SECURITY_GROUP_ID! }] }],
  }));
  return 'Security group inbound rule removed';
}

async function breakScenario2(ec2: EC2Client): Promise<string> {
  await ec2.send(new DeleteRouteCommand({
    RouteTableId: process.env.PRIVATE_ROUTE_TABLE_ID!,
    DestinationCidrBlock: '0.0.0.0/0',
  }));
  return 'Default route removed from private route table';
}

async function breakScenario3(ec2: EC2Client): Promise<string> {
  await ec2.send(new ModifyVpcEndpointCommand({
    VpcEndpointId: process.env.S3_ENDPOINT_ID!,
    PolicyDocument: JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Deny', Principal: '*', Action: 's3:*', Resource: '*' }] }),
  }));
  return 'S3 VPC endpoint policy changed to deny';
}

async function breakScenario4(ec2: EC2Client): Promise<string> {
  const subnetIds = process.env.BEDROCK_ENDPOINT_SUBNET_IDS!.split(',');
  await ec2.send(new ModifyVpcEndpointCommand({
    VpcEndpointId: process.env.BEDROCK_ENDPOINT_ID!,
    RemoveSubnetIds: subnetIds,
  }));
  return 'Bedrock endpoint subnet associations removed';
}

/**
 * Scenario 5: Stop the backend application on EC2 via SSM.
 * ALB returns 502 Bad Gateway. ELB Access Logs show the errors.
 */
async function breakScenario5(ssm: SSMClient): Promise<string> {
  await ssm.send(new SendCommandCommand({
    InstanceIds: [process.env.EC2_INSTANCE_ID!],
    DocumentName: 'AWS-RunShellScript',
    Parameters: { commands: [
      'sudo systemctl mask health-check-app',
      'sudo systemctl stop health-check-app',
      'sudo systemctl mask nginx',
      'sudo systemctl stop nginx',
    ] },
    Comment: 'Service maintenance',
  }));
  return 'Backend application stopped';
}

/**
 * Scenario 6: TLS Certificate/SNI Mismatch + PCAP Capture.
 * Poisons /etc/hosts to redirect the CloudWatch monitoring endpoint to the local
 * nginx (which has a cert for server.internal.lab). The health-check-app's TLS
 * verification check detects the cert mismatch and publishes the metric naturally.
 * PCAP captures the TLS handshake failures for MCP analysis.
 */
async function breakScenario6(ssm: SSMClient, sessionId: string): Promise<string> {
  const pcapBucketArn = process.env.PCAP_STORAGE_BUCKET_ARN!;
  const pcapBucket = pcapBucketArn.split(':::')[1];
  const region = process.env.AWS_REGION || 'us-east-1';
  const poisonDomain = `maps.geo.${region}.amazonaws.com`;

  const script = [
    '#!/bin/bash',
    '',
    'MY_IP=$(hostname -I | awk \'{print $1}\')',
    '',
    '# Start packet capture',
    `sudo timeout 45 tcpdump -i any port 443 -w /tmp/capture-${sessionId}.pcap &`,
    'TCPDUMP_PID=$!',
    'sleep 2',
    '',
    '# Redirect Location Service endpoint to local server via hosts file (DNS poisoning)',
    'sudo cp /etc/hosts /etc/hosts.bak',
    `echo "$MY_IP ${poisonDomain}" | sudo tee -a /etc/hosts > /dev/null`,
    '',
    '# Generate HTTPS traffic to the poisoned domain — TLS will fail due to cert mismatch',
    `curl -s --max-time 5 https://${poisonDomain}:443/ 2>&1 || true`,
    `curl -s --max-time 5 https://${poisonDomain}:443/ 2>&1 || true`,
    `curl -s --max-time 5 https://${poisonDomain}:443/ 2>&1 || true`,
    'sleep 10',
    '',
    '# Stop capture and upload',
    'sudo kill $TCPDUMP_PID 2>/dev/null || true',
    'wait $TCPDUMP_PID 2>/dev/null || true',
    'sleep 1',
    `aws s3 cp /tmp/capture-${sessionId}.pcap s3://${pcapBucket}/captures/${sessionId}.pcap`,
    `rm -f /tmp/capture-${sessionId}.pcap`,
  ].join('\n');

  await ssm.send(new SendCommandCommand({
    InstanceIds: [process.env.EC2_INSTANCE_ID!],
    DocumentName: 'AWS-RunShellScript',
    Parameters: { commands: [script] },
    TimeoutSeconds: 120,
    Comment: `Diagnostics (${sessionId})`,
  }));

  // No PutMetricData injection — the health-check-app's checkCloudWatchTls
  // will detect the TLS cert mismatch and publish the metric naturally

  return `PCAP capture initiated. PCAP → s3://${pcapBucket}/captures/${sessionId}.pcap`;
}

export const handler = async (event: any) => {
  try {
    const body = JSON.parse(event.body || '{}');
    const scenarioId = body.scenarioId;

    if (!scenarioId || scenarioId < 1 || scenarioId > 6) {
      return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'scenarioId (1-6) is required' }) };
    }

    const existing = await ddb.send(new GetItemCommand({
      TableName: TABLE_NAME,
      Key: { sessionId: { S: 'SYSTEM' }, timestamp: { S: 'ACTIVE_SCENARIO' } },
    }));

    if (existing.Item) {
      return { statusCode: 409, headers: corsHeaders, body: JSON.stringify({ error: 'Another scenario is already active', activeScenarioId: existing.Item.scenarioId?.N }) };
    }

    const sessionId = randomUUID();
    const now = new Date().toISOString();
    const ttl = Math.floor(Date.now() / 1000) + 86400;

    await ddb.send(new PutItemCommand({
      TableName: TABLE_NAME,
      Item: { sessionId: { S: 'SYSTEM' }, timestamp: { S: 'ACTIVE_SCENARIO' }, scenarioId: { N: String(scenarioId) }, activeSessionId: { S: sessionId }, startedAt: { S: now }, ttl: { N: String(ttl) } },
      ConditionExpression: 'attribute_not_exists(sessionId)',
    }));

    // Assume the network-ops-role for all infrastructure changes
    const ops = await getOpsClients();

    // Write break_triggered event first so the event stream shows the full sequence
    await ddb.send(new PutItemCommand({
      TableName: TABLE_NAME,
      Item: { sessionId: { S: sessionId }, timestamp: { S: now }, eventType: { S: 'scenario_break_triggered' }, data: { S: JSON.stringify({ scenarioId }) }, ttl: { N: String(ttl) } },
    }));

    let breakMessage: string;
    switch (scenarioId) {
      case 1: breakMessage = await breakScenario1(ops.ec2); break;
      case 2: breakMessage = await breakScenario2(ops.ec2); break;
      case 3: breakMessage = await breakScenario3(ops.ec2); break;
      case 4: breakMessage = await breakScenario4(ops.ec2); break;
      case 5: breakMessage = await breakScenario5(ops.ssm); break;
      case 6: breakMessage = await breakScenario6(ops.ssm, sessionId); break;
      default: breakMessage = `Unknown scenario ${scenarioId}`;
    }

    await ddb.send(new PutItemCommand({
      TableName: TABLE_NAME,
      Item: { sessionId: { S: sessionId }, timestamp: { S: new Date().toISOString() }, eventType: { S: 'scenario_broken' }, data: { S: JSON.stringify({ scenarioId, message: breakMessage }) }, ttl: { N: String(ttl) } },
    }));

    return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ sessionId, scenarioId, message: `Scenario ${scenarioId} break initiated`, details: breakMessage }) };
  } catch (err: any) {
    if (err.name === 'ConditionalCheckFailedException') {
      return { statusCode: 409, headers: corsHeaders, body: JSON.stringify({ error: 'Another scenario was activated concurrently' }) };
    }
    console.error('Break failed:', err);
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: 'Internal server error' }) };
  }
};
