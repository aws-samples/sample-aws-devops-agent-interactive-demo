/**
 * Dashboard Fix Lambda — POST /fix
 *
 * Reverts the break for the specified scenarioId (1-6).
 * All infrastructure changes are made via the "network-ops-role".
 */

import { DynamoDBClient, PutItemCommand, GetItemCommand, DeleteItemCommand } from '@aws-sdk/client-dynamodb';
import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';
import {
  EC2Client,
  AuthorizeSecurityGroupIngressCommand,
  CreateRouteCommand,
  ModifyVpcEndpointCommand,
} from '@aws-sdk/client-ec2';
import { SSMClient, SendCommandCommand } from '@aws-sdk/client-ssm';

const ddb = new DynamoDBClient({});
const sts = new STSClient({});
const TABLE_NAME = process.env.EVENTS_TABLE_NAME!;
const NETWORK_OPS_ROLE_ARN = process.env.NETWORK_OPS_ROLE_ARN!;

const corsHeaders = {
  'Access-Control-Allow-Origin': process.env.ALLOWED_ORIGIN!,
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
};

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

async function fixScenario1(ec2: EC2Client): Promise<string> {
  await ec2.send(new AuthorizeSecurityGroupIngressCommand({
    GroupId: process.env.RDS_SECURITY_GROUP_ID!,
    IpPermissions: [{ IpProtocol: 'tcp', FromPort: 3306, ToPort: 3306, UserIdGroupPairs: [{ GroupId: process.env.EC2_SECURITY_GROUP_ID! }] }],
  }));
  return 'Security group inbound rule restored';
}

async function fixScenario2(ec2: EC2Client): Promise<string> {
  await ec2.send(new CreateRouteCommand({
    RouteTableId: process.env.PRIVATE_ROUTE_TABLE_ID!,
    DestinationCidrBlock: '0.0.0.0/0',
    NatGatewayId: process.env.NAT_GATEWAY_ID!,
  }));
  return 'Default route restored via NAT Gateway';
}

async function fixScenario3(ec2: EC2Client): Promise<string> {
  await ec2.send(new ModifyVpcEndpointCommand({
    VpcEndpointId: process.env.S3_ENDPOINT_ID!,
    PolicyDocument: JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: '*', Action: '*', Resource: '*' }] }),
  }));
  return 'S3 VPC endpoint policy restored to allow all';
}

async function fixScenario4(ec2: EC2Client): Promise<string> {
  const subnetIds = process.env.BEDROCK_ENDPOINT_SUBNET_IDS!.split(',');
  await ec2.send(new ModifyVpcEndpointCommand({
    VpcEndpointId: process.env.BEDROCK_ENDPOINT_ID!,
    AddSubnetIds: subnetIds,
  }));
  return 'Bedrock endpoint subnet associations restored';
}

async function fixScenario5(ssm: SSMClient): Promise<string> {
  await ssm.send(new SendCommandCommand({
    InstanceIds: [process.env.EC2_INSTANCE_ID!],
    DocumentName: 'AWS-RunShellScript',
    Parameters: { commands: [
      'sudo systemctl unmask nginx',
      'sudo systemctl start nginx',
      'sudo systemctl unmask health-check-app',
      'sudo systemctl start health-check-app',
    ] },
    Comment: 'Service recovery',
  }));
  return 'Backend application restarted';
}

async function fixScenario6(ssm: SSMClient): Promise<string> {
  await ssm.send(new SendCommandCommand({
    InstanceIds: [process.env.EC2_INSTANCE_ID!],
    DocumentName: 'AWS-RunShellScript',
    Parameters: { commands: [
      'sudo cp /etc/hosts.bak /etc/hosts 2>/dev/null || sudo sed -i "/maps.geo.*amazonaws.com/d; /geo.*amazonaws.com/d; /ssm.*amazonaws.com/d; /monitoring.*amazonaws.com/d; /api.production.com/d; /app.example.com/d" /etc/hosts',
    ] },
    Comment: 'Cleanup',
  }));
  return 'Host configuration restored';
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

    if (!existing.Item) {
      return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'No active scenario to fix' }) };
    }

    const activeScenarioId = parseInt(existing.Item.scenarioId?.N || '0', 10);
    const activeSessionId = existing.Item.activeSessionId?.S || '';

    if (activeScenarioId !== scenarioId) {
      return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: `Active scenario is ${activeScenarioId}, not ${scenarioId}` }) };
    }

    const ops = await getOpsClients();

    let fixMessage: string;
    switch (scenarioId) {
      case 1: fixMessage = await fixScenario1(ops.ec2); break;
      case 2: fixMessage = await fixScenario2(ops.ec2); break;
      case 3: fixMessage = await fixScenario3(ops.ec2); break;
      case 4: fixMessage = await fixScenario4(ops.ec2); break;
      case 5: fixMessage = await fixScenario5(ops.ssm); break;
      case 6: fixMessage = await fixScenario6(ops.ssm); break;
      default: fixMessage = `Unknown scenario ${scenarioId}`;
    }

    await ddb.send(new DeleteItemCommand({
      TableName: TABLE_NAME,
      Key: { sessionId: { S: 'SYSTEM' }, timestamp: { S: 'ACTIVE_SCENARIO' } },
    }));

    const now = new Date().toISOString();
    const ttl = Math.floor(Date.now() / 1000) + 86400;

    await ddb.send(new PutItemCommand({
      TableName: TABLE_NAME,
      Item: { sessionId: { S: activeSessionId }, timestamp: { S: now }, eventType: { S: 'scenario_fixed' }, data: { S: JSON.stringify({ scenarioId, message: fixMessage }) }, ttl: { N: String(ttl) } },
    }));

    return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ sessionId: activeSessionId, scenarioId, message: `Scenario ${scenarioId} fix completed`, details: fixMessage }) };
  } catch (err: any) {
    console.error('Fix failed:', err);
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: 'Internal server error' }) };
  }
};
