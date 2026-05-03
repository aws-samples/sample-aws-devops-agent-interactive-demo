#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { Aspects } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { NetworkStack } from '../lib/network-stack';
import { ComputeStack } from '../lib/compute-stack';
import { TrafficGenStack } from '../lib/traffic-gen-stack';
import { AlarmStack } from '../lib/alarm-stack';
import { ImageStack } from '../lib/image-stack';
import { AuthStack } from '../lib/auth-stack';
import { PcapMcpStack } from '../lib/pcap-mcp-stack';
import { DevOpsAgentStack } from '../lib/devops-agent-stack';
import { DashboardStack } from '../lib/dashboard-stack';

const app = new cdk.App();

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION || 'us-east-1',
};

// ---------------------------------------------------------------------------
// Stack 1: NetworkStack — VPC, subnets, NAT GW, endpoints, flow logs
// ---------------------------------------------------------------------------
const networkStack = new NetworkStack(app, 'NetDevOpsNetworkStack', { env });

// ---------------------------------------------------------------------------
// Stack 2: ComputeStack — EC2, ALB, RDS, S3 log buckets
// ---------------------------------------------------------------------------
const computeStack = new ComputeStack(app, 'NetDevOpsComputeStack', {
  env,
  vpc: networkStack.vpc,
  publicSubnets: networkStack.publicSubnets,
  privateSubnets: networkStack.privateSubnets,
  privateRouteTableId: networkStack.privateRouteTableId,
  natGatewayId: networkStack.natGatewayId,
  s3EndpointId: networkStack.s3EndpointId,
  bedrockEndpointId: networkStack.bedrockEndpointId,
  bedrockEndpointSubnetIds: networkStack.bedrockEndpointSubnetIds,
  vpcFlowLogBucket: networkStack.vpcFlowLogBucket,
});
computeStack.addDependency(networkStack);

// ---------------------------------------------------------------------------
// Stack 3: TrafficGenStack — Lambda + EventBridge schedule hitting ALB
// ---------------------------------------------------------------------------
const trafficGenStack = new TrafficGenStack(app, 'NetDevOpsTrafficGenStack', {
  env,
  albUrl: computeStack.albUrl,
});
trafficGenStack.addDependency(computeStack);

// ---------------------------------------------------------------------------
// Stack 4: AlarmStack — 6 CloudWatch alarms, SNS topic, webhook Lambda
// ---------------------------------------------------------------------------
const alarmStack = new AlarmStack(app, 'NetDevOpsAlarmStack', {
  env,
  albFullName: computeStack.albFullName,
  albTargetGroupFullName: computeStack.albTargetGroupFullName,
});
alarmStack.addDependency(computeStack);

// ---------------------------------------------------------------------------
// Stack 5: AuthStack — Cognito User Pool, Resource Server, M2M App Client
// ---------------------------------------------------------------------------
const authStack = new AuthStack(app, 'NetDevOpsAuthStack', { env });

// ---------------------------------------------------------------------------
// Stack 6: PcapMcpStack — PCAP S3 bucket, AgentCore execution role
// (Runtime created via CLI in ImageStack CodeBuild, not CloudFormation)
// ---------------------------------------------------------------------------
const pcapMcpStack = new PcapMcpStack(app, 'NetDevOpsPcapMcpStack', { env });

// ---------------------------------------------------------------------------
// Stack 7: ImageStack — ECR + CodeBuild builds image + creates AgentCore Runtime via CLI
// ---------------------------------------------------------------------------
const imageStack = new ImageStack(app, 'NetDevOpsImageStack', {
  env,
  agentCoreRoleArn: pcapMcpStack.agentCoreRoleArn,
  cognitoUserPoolId: authStack.userPoolId,
  cognitoClientId: authStack.m2mClientId,
});
imageStack.addDependency(pcapMcpStack);
imageStack.addDependency(authStack);

// ---------------------------------------------------------------------------
// Stack 8: DevOpsAgentStack — Agent Space, IAM roles, account association
// ---------------------------------------------------------------------------
const devOpsAgentStack = new DevOpsAgentStack(app, 'NetDevOpsAgentStack', {
  env,
  mcpEndpointUrl: pcapMcpStack.mcpEndpointUrl,
  m2mClientId: authStack.m2mClientId,
  oauthTokenEndpoint: authStack.oauthTokenEndpoint,
  vpcFlowLogBucketArn: networkStack.vpcFlowLogBucket.bucketArn,
  elbAccessLogBucketArn: computeStack.elbAccessLogBucket.bucketArn,
  pcapStorageBucketArn: pcapMcpStack.pcapStorageBucketArn,
});
devOpsAgentStack.addDependency(pcapMcpStack);
devOpsAgentStack.addDependency(imageStack);
devOpsAgentStack.addDependency(authStack);
devOpsAgentStack.addDependency(networkStack);
devOpsAgentStack.addDependency(computeStack);

// ---------------------------------------------------------------------------
// Stack 9: DashboardStack — Frontend, API GW, Lambdas, DynamoDB, EventBridge
// ---------------------------------------------------------------------------
const dashboardStack = new DashboardStack(app, 'NetDevOpsDashboardStack', {
  env,
  // Network resources (for break/fix Lambdas)
  vpc: networkStack.vpc,
  privateRouteTableId: networkStack.privateRouteTableId,
  natGatewayId: networkStack.natGatewayId,
  s3EndpointId: networkStack.s3EndpointId,
  bedrockEndpointId: networkStack.bedrockEndpointId,
  bedrockEndpointSubnetIds: networkStack.bedrockEndpointSubnetIds,
  vpcFlowLogBucketArn: networkStack.vpcFlowLogBucket.bucketArn,
  // Compute resources (for break/fix Lambdas)
  ec2InstanceId: computeStack.ec2InstanceId,
  albUrl: computeStack.albUrl,
  albListenerArn: computeStack.albListenerArn,
  rdsEndpoint: computeStack.rdsEndpoint,
  elbAccessLogBucketArn: computeStack.elbAccessLogBucket.bucketArn,
  ec2SecurityGroupId: computeStack.ec2SecurityGroupId,
  rdsSecurityGroupId: computeStack.rdsSecurityGroupId,
  // Alarm resources
  snsTopicArn: alarmStack.snsTopicArn,
  webhookLambdaArn: alarmStack.webhookLambdaArn,
  webhookSecretArn: alarmStack.webhookSecretArn,
  // PCAP / MCP resources
  pcapStorageBucketArn: pcapMcpStack.pcapStorageBucketArn,
  mcpEndpointUrl: pcapMcpStack.mcpEndpointUrl,
  // Auth resources (from AuthStack)
  m2mClientId: authStack.m2mClientId,
  oauthTokenEndpoint: authStack.oauthTokenEndpoint,
  userPoolId: authStack.userPoolId,
  userPoolArn: authStack.userPoolArn,
  dashboardClientId: authStack.dashboardClientId,
  dashboardCredentialsSecretArn: authStack.dashboardCredentialsSecretArn,
  // DevOps Agent resources
  agentSpaceId: devOpsAgentStack.agentSpaceId,
});
dashboardStack.addDependency(networkStack);
dashboardStack.addDependency(computeStack);
dashboardStack.addDependency(trafficGenStack);
dashboardStack.addDependency(alarmStack);
dashboardStack.addDependency(authStack);
dashboardStack.addDependency(pcapMcpStack);
dashboardStack.addDependency(imageStack);
dashboardStack.addDependency(devOpsAgentStack);

// cdk-nag
Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
