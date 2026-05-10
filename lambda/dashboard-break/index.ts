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
    RoleSessionName: 'maint-session',
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
 * Scenario 5: Backend failure via pre-installed script.
 * ALB returns 502 Bad Gateway. DevOps Agent must rely on ELB Access Logs in S3.
 */
async function breakScenario5(ssm: SSMClient): Promise<string> {
  await ssm.send(new SendCommandCommand({
    InstanceIds: [process.env.EC2_INSTANCE_ID!],
    DocumentName: 'AWS-RunShellScript',
    Parameters: { commands: ['sudo /opt/scripts/s5b.sh'] },
    TimeoutSeconds: 30,
  }));
  return 'Maintenance task executed';
}

/**
 * Scenario 6: TLS Certificate/SNI Mismatch + PCAP Capture.
 * Executes a pre-installed script on EC2 that captures baseline and incident
 * traffic. The script content is not visible in CloudTrail — DevOps Agent
 * must rely on PCAP analysis to identify the root cause.
 */
async function breakScenario6(ssm: SSMClient, sessionId: string): Promise<string> {
  await ssm.send(new SendCommandCommand({
    InstanceIds: [process.env.EC2_INSTANCE_ID!],
    DocumentName: 'AWS-RunShellScript',
    Parameters: { commands: [`sudo /opt/scripts/s6b.sh ${sessionId}`] },
    TimeoutSeconds: 300,
  }));

  return 'Network diagnostics initiated';
}

export const handler = async (event: any) => {
  try {
    const body = JSON.parse(event.body || '{}');
    const scenarioId = body.id;

    if (!scenarioId || scenarioId < 1 || scenarioId > 6) {
      return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'id (1-6) is required' }) };
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
      Item: { sessionId: { S: sessionId }, timestamp: { S: new Date().toISOString() }, eventType: { S: 'scenario_active' }, data: { S: JSON.stringify({ scenarioId, message: breakMessage }) }, ttl: { N: String(ttl) } },
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
