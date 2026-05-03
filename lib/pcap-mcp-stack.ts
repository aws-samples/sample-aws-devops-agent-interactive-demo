import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';

/**
 * PcapMcpStack — PCAP storage bucket + AgentCore execution role + SSM lookups.
 *
 * The AgentCore Runtime is created via CLI in CodeBuild (ImageStack),
 * NOT via CloudFormation. This stack provides:
 * 1. PCAP Storage S3 bucket
 * 2. IAM execution role for AgentCore Runtime
 * 3. SSM parameter lookups for the runtime endpoint URL
 *
 * Requirements: 6.1, 6.3, 6.4, 6.5, 6.6
 */
export class PcapMcpStack extends cdk.Stack {
  /** PCAP Storage S3 bucket ARN. */
  public readonly pcapStorageBucketArn: string;
  /** AgentCore execution role ARN (passed to ImageStack for CodeBuild). */
  public readonly agentCoreRoleArn: string;
  /** MCP Server endpoint URL (read from SSM, written by CodeBuild). */
  public readonly mcpEndpointUrl: string;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // -----------------------------------------------------------------------
    // PCAP Storage Bucket
    // -----------------------------------------------------------------------
    const pcapBucket = new s3.Bucket(this, 'PcapStorageBucket', {
      bucketName: `pcap-analyzer-storage-${cdk.Aws.ACCOUNT_ID}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [{ expiration: cdk.Duration.days(7) }],
    });

    this.pcapStorageBucketArn = pcapBucket.bucketArn;

    NagSuppressions.addResourceSuppressions(pcapBucket, [
      { id: 'AwsSolutions-S1', reason: 'PCAP storage bucket does not need access logging for this demo.' },
    ]);

    // -----------------------------------------------------------------------
    // IAM Execution Role for AgentCore Runtime
    // (matching working CFN pattern with proper trust policy)
    // -----------------------------------------------------------------------
    const runtimeRole = new iam.Role(this, 'PcapMcpRuntimeRole', {
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com', {
        conditions: {
          StringEquals: { 'aws:SourceAccount': this.account },
          ArnLike: { 'aws:SourceArn': `arn:aws:bedrock-agentcore:${this.region}:${this.account}:*` },
        },
      }),
      description: 'Execution role for PCAP MCP Server AgentCore Runtime',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEC2ContainerRegistryReadOnly'),
      ],
    });

    // ECR auth token
    runtimeRole.addToPolicy(new iam.PolicyStatement({
      sid: 'ECRTokenAccess',
      effect: iam.Effect.ALLOW,
      actions: ['ecr:GetAuthorizationToken'],
      resources: ['*'],
    }));

    // S3 PCAP access
    runtimeRole.addToPolicy(new iam.PolicyStatement({
      sid: 'S3PcapAccess',
      effect: iam.Effect.ALLOW,
      actions: ['s3:GetObject', 's3:PutObject', 's3:ListBucket', 's3:DeleteObject'],
      resources: [pcapBucket.bucketArn, `${pcapBucket.bucketArn}/*`],
    }));

    // S3 read access to VPC Flow Logs and ELB Access Logs buckets
    // (so the MCP server can analyze network logs alongside PCAPs)
    const vpcFlowLogBucketArn = `arn:aws:s3:::vpc-flow-logs-${cdk.Aws.ACCOUNT_ID}-${cdk.Aws.REGION}`;
    const elbAccessLogBucketArn = `arn:aws:s3:::elb-access-logs-${cdk.Aws.ACCOUNT_ID}-${cdk.Aws.REGION}`;
    runtimeRole.addToPolicy(new iam.PolicyStatement({
      sid: 'S3ReadNetworkLogs',
      effect: iam.Effect.ALLOW,
      actions: ['s3:GetObject', 's3:ListBucket'],
      resources: [
        vpcFlowLogBucketArn, `${vpcFlowLogBucketArn}/*`,
        elbAccessLogBucketArn, `${elbAccessLogBucketArn}/*`,
      ],
    }));

    // CloudWatch Logs
    runtimeRole.addToPolicy(new iam.PolicyStatement({
      sid: 'AgentCoreLogging',
      effect: iam.Effect.ALLOW,
      actions: ['logs:DescribeLogStreams', 'logs:CreateLogGroup'],
      resources: [`arn:aws:logs:${this.region}:${this.account}:log-group:/aws/bedrock-agentcore/runtimes/*`],
    }));
    runtimeRole.addToPolicy(new iam.PolicyStatement({
      sid: 'AgentCoreLogGroups',
      effect: iam.Effect.ALLOW,
      actions: ['logs:DescribeLogGroups'],
      resources: [`arn:aws:logs:${this.region}:${this.account}:log-group:*`],
    }));
    runtimeRole.addToPolicy(new iam.PolicyStatement({
      sid: 'AgentCoreLogStreams',
      effect: iam.Effect.ALLOW,
      actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
      resources: [`arn:aws:logs:${this.region}:${this.account}:log-group:/aws/bedrock-agentcore/runtimes/*:log-stream:*`],
    }));

    // X-Ray tracing (matching working CFN)
    runtimeRole.addToPolicy(new iam.PolicyStatement({
      sid: 'XRay',
      effect: iam.Effect.ALLOW,
      actions: ['xray:PutTraceSegments', 'xray:PutTelemetryRecords', 'xray:GetSamplingRules', 'xray:GetSamplingTargets'],
      resources: ['*'],
    }));

    // CloudWatch Metrics (matching working CFN)
    runtimeRole.addToPolicy(new iam.PolicyStatement({
      sid: 'CloudWatchMetrics',
      effect: iam.Effect.ALLOW,
      actions: ['cloudwatch:PutMetricData'],
      resources: ['*'],
      conditions: { StringEquals: { 'cloudwatch:namespace': 'bedrock-agentcore' } },
    }));

    this.agentCoreRoleArn = runtimeRole.roleArn;

    // -----------------------------------------------------------------------
    // Read MCP endpoint URL from SSM (written by CodeBuild in ImageStack)
    // Use valueForStringParameter which resolves at deploy time (not synth time)
    // and won't fail if the parameter doesn't exist yet.
    // The config Lambda also reads from SSM at runtime as a fallback.
    // -----------------------------------------------------------------------
    this.mcpEndpointUrl = 'PENDING_CODEBUILD';

    // -----------------------------------------------------------------------
    // CfnOutputs
    // -----------------------------------------------------------------------
    new cdk.CfnOutput(this, 'PcapStorageBucketArn', {
      value: pcapBucket.bucketArn,
      description: 'PCAP Storage S3 bucket ARN',
    });

    new cdk.CfnOutput(this, 'PcapStorageBucketName', {
      value: pcapBucket.bucketName,
      description: 'PCAP Storage S3 bucket name',
    });

    new cdk.CfnOutput(this, 'AgentCoreRoleArn', {
      value: runtimeRole.roleArn,
      description: 'AgentCore execution role ARN',
    });

    new cdk.CfnOutput(this, 'McpEndpointUrl', {
      value: this.mcpEndpointUrl,
      description: 'MCP Server endpoint URL (from SSM, written by CodeBuild)',
    });

    // -----------------------------------------------------------------------
    // cdk-nag suppressions
    // -----------------------------------------------------------------------
    NagSuppressions.addStackSuppressions(this, [
      { id: 'AwsSolutions-IAM5', reason: 'Wildcards scoped to PCAP bucket, AgentCore log groups, X-Ray, and CloudWatch metrics namespace.' },
      { id: 'AwsSolutions-IAM4', reason: 'AmazonEC2ContainerRegistryReadOnly managed policy required for AgentCore Runtime ECR pull.', appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly'] },
    ]);
  }
}
