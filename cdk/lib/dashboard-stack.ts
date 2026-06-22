import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda-nodejs';
import * as lambdaRuntime from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import { NagSuppressions } from 'cdk-nag';
import * as path from 'path';
import { Construct } from 'constructs';

/**
 * Props aggregated from all upstream stacks into DashboardStack.
 */
export interface DashboardStackProps extends cdk.StackProps {
  // --- Network resources (from NetworkStack) ---
  /** VPC reference. */
  readonly vpc: ec2.IVpc;
  /** Private route table ID (Scenario 2 break/fix). */
  readonly privateRouteTableId: string;
  /** NAT Gateway ID (Scenario 2 fix). */
  readonly natGatewayId: string;
  /** S3 Gateway Endpoint ID (Scenario 3 break/fix). */
  readonly s3EndpointId: string;
  /** Bedrock Interface Endpoint ID (Scenario 4 break/fix). */
  readonly bedrockEndpointId: string;
  /** Bedrock endpoint subnet IDs (Scenario 4 break/fix). */
  readonly bedrockEndpointSubnetIds: string[];
  /** VPC Flow Log bucket ARN (for Agent Space IAM policy). */
  readonly vpcFlowLogBucketArn: string;

  // --- Compute resources (from ComputeStack) ---
  /** EC2 instance ID (Scenario 6 SSM commands). */
  readonly ec2InstanceId: string;
  /** ALB public URL. */
  readonly albUrl: string;
  /** ALB HTTPS listener ARN (Scenario 5 break/fix). */
  readonly albListenerArn: string;
  /** RDS endpoint address. */
  readonly rdsEndpoint: string;
  /** ELB Access Log bucket ARN (for Agent Space IAM policy). */
  readonly elbAccessLogBucketArn: string;
  /** EC2 security group ID (Scenario 1 break/fix source). */
  readonly ec2SecurityGroupId: string;
  /** RDS security group ID (Scenario 1 break/fix target). */
  readonly rdsSecurityGroupId: string;

  // --- Alarm resources (from AlarmStack) ---
  /** SNS topic ARN. */
  readonly snsTopicArn: string;
  /** Webhook Lambda ARN (for webhook-config updates). */
  readonly webhookLambdaArn: string;
  /** Secrets Manager secret ARN for webhook credentials. */
  readonly webhookSecretArn: string;

  // --- PCAP / MCP resources (from PcapMcpStack) ---
  /** PCAP Storage bucket ARN (for Agent Space IAM policy + Scenario 6). */
  readonly pcapStorageBucketArn: string;
  /** MCP Server endpoint URL. */
  readonly mcpEndpointUrl: string;
  /** M2M app client ID (from AuthStack). */
  readonly m2mClientId: string;
  /** OAuth token endpoint (from AuthStack). */
  readonly oauthTokenEndpoint: string;
  /** Cognito User Pool ID (from AuthStack) — for retrieving client secret. */
  readonly userPoolId: string;
  /** Cognito User Pool ARN (from AuthStack). */
  readonly userPoolArn: string;
  /** Dashboard app client ID (from AuthStack). */
  readonly dashboardClientId: string;
  /** Secrets Manager ARN for dashboard admin credentials (from AuthStack). */
  readonly dashboardCredentialsSecretArn: string;

  // --- DevOps Agent resources (from DevOpsAgentStack) ---
  /** Agent Space ID for console URL. */
  readonly agentSpaceId: string;
}

/**
 * DashboardStack — S3 + CloudFront frontend, API Gateway, Lambda handlers,
 * DynamoDB Events Table, EventBridge rule for aws.aidevops events.
 *
 * Requirements: 16.x, 17.x, 18.10
 */
export class DashboardStack extends cdk.Stack {
  /** DynamoDB Events Table name. */
  public readonly eventsTableName: string;
  /** DynamoDB Events Table ARN. */
  public readonly eventsTableArn: string;

  constructor(scope: Construct, id: string, props: DashboardStackProps) {
    super(scope, id, props);

    // ── Task 10.1: DynamoDB Events Table ──────────────────────────────
    const eventsTable = new dynamodb.Table(this, 'DashboardEventsTable', {
      tableName: `devops-dashboard-events-${cdk.Aws.STACK_NAME}`,
      partitionKey: { name: 'sessionId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'timestamp', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ── Task 10.1: EventBridge Lambda (writes events to DynamoDB) ─────
    const eventBridgeLambdaRole = this.createLambdaRole('EventBridgeLambdaRole', 'Dashboard EventBridge Lambda');
    eventBridgeLambdaRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['dynamodb:PutItem', 'dynamodb:GetItem'],
      resources: [eventsTable.tableArn],
    }));
    eventBridgeLambdaRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['aidevops:GetInvestigationSummary'],
      resources: ['*'],
    }));

    const eventBridgeLambda = new lambda.NodejsFunction(this, 'EventBridgeHandler', {
      runtime: lambdaRuntime.Runtime.NODEJS_20_X,
      handler: 'handler',
      entry: path.join(__dirname, '..', 'lambda', 'dashboard-eventbridge', 'index.ts'),
      timeout: cdk.Duration.seconds(60),
      memorySize: 256,
      role: eventBridgeLambdaRole,
      environment: {
        EVENTS_TABLE_NAME: eventsTable.tableName,
      },
      bundling: { minify: false, sourceMap: true },
    });

    // ── Task 10.1: EventBridge Rule matching aws.aidevops ─────────────
    const rule = new events.Rule(this, 'DevOpsAgentEventRule', {
      description: 'Capture DevOps Agent investigation lifecycle events',
      eventPattern: {
        source: ['aws.aidevops'],
      },
    });
    rule.addTarget(new targets.LambdaFunction(eventBridgeLambda));

    // ── Task 10.3: Health Lambda (GET /health) ────────────────────────
    const healthLambdaRole = this.createLambdaRole('HealthLambdaRole', 'Dashboard Health Lambda');
    healthLambdaRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:DeleteItem'],
      resources: [eventsTable.tableArn],
    }));
    // Read live CloudWatch alarm states (alarm-1..6) — DescribeAlarms has no
    // resource-level scoping, so it must be granted on '*'.
    healthLambdaRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['cloudwatch:DescribeAlarms'],
      resources: ['*'],
    }));

    const healthLambda = new lambda.NodejsFunction(this, 'HealthHandler', {
      runtime: lambdaRuntime.Runtime.NODEJS_20_X,
      handler: 'handler',
      entry: path.join(__dirname, '..', 'lambda', 'dashboard-health', 'index.ts'),
      timeout: cdk.Duration.seconds(30),
      memorySize: 128,
      role: healthLambdaRole,
      environment: {
        EVENTS_TABLE_NAME: eventsTable.tableName,
      },
      bundling: { minify: false, sourceMap: true },
    });

    // ── Network Operations Role (Option A — separate identity for break/fix) ──
    // This role is assumed by the break/fix Lambdas when making infrastructure
    // changes. CloudTrail shows "network-ops-role" as the caller instead of
    // the Lambda function name, making investigations more realistic.
    const networkOpsRole = new iam.Role(this, 'NetworkOpsRole', {
      roleName: 'devops-ops-role',
      assumedBy: new iam.CompositePrincipal(
        new iam.AccountPrincipal(this.account),
      ),
      description: 'Network operations role for infrastructure changes',
    });

    // EC2/VPC permissions (scenarios 1-4) — scoped to specific resources
    networkOpsRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ec2:RevokeSecurityGroupIngress', 'ec2:AuthorizeSecurityGroupIngress'],
      resources: [
        `arn:aws:ec2:${this.region}:${this.account}:security-group/${props.ec2SecurityGroupId}`,
        `arn:aws:ec2:${this.region}:${this.account}:security-group/${props.rdsSecurityGroupId}`,
      ],
    }));
    networkOpsRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ec2:DeleteRoute', 'ec2:CreateRoute'],
      resources: [
        `arn:aws:ec2:${this.region}:${this.account}:route-table/${props.privateRouteTableId}`,
      ],
    }));
    networkOpsRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ec2:ModifyVpcEndpoint'],
      resources: [
        `arn:aws:ec2:${this.region}:${this.account}:vpc-endpoint/${props.s3EndpointId}`,
        `arn:aws:ec2:${this.region}:${this.account}:vpc-endpoint/${props.bedrockEndpointId}`,
        ...props.bedrockEndpointSubnetIds.map(id => `arn:aws:ec2:${this.region}:${this.account}:subnet/${id}`),
      ],
    }));

    // SSM permissions (scenarios 5-6) — scoped to specific document
    networkOpsRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ssm:SendCommand', 'ssm:GetCommandInvocation'],
      resources: [
        `arn:aws:ec2:${this.region}:${this.account}:instance/${props.ec2InstanceId}`,
        `arn:aws:ssm:${this.region}:${this.account}:document/AWS-RunShellScript`,
        `arn:aws:ssm:${this.region}::document/AWS-RunShellScript`,
        `arn:aws:ssm:${this.region}:${this.account}:*`,
      ],
    }));

    // CloudWatch PutMetricData + SetAlarmState (scenario 5-6)
    networkOpsRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['cloudwatch:PutMetricData', 'cloudwatch:SetAlarmState'],
      resources: ['*'],
    }));

    // ── Task 10.3: Break Lambda (POST /break) ─────────────────────────
    const breakLambdaRole = this.createLambdaRole('BreakLambdaRole', 'Dashboard Break Lambda');
    breakLambdaRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['dynamodb:PutItem', 'dynamodb:GetItem'],
      resources: [eventsTable.tableArn],
    }));
    // AssumeRole on the network-ops-role (all infra changes go through this role)
    breakLambdaRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['sts:AssumeRole'],
      resources: [networkOpsRole.roleArn],
    }));
    // CloudWatch PutMetricData (for publishing alarm metrics directly from Lambda)
    breakLambdaRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['cloudwatch:PutMetricData'],
      resources: ['*'],
    }));

    const breakLambda = new lambda.NodejsFunction(this, 'BreakHandler', {
      runtime: lambdaRuntime.Runtime.NODEJS_20_X,
      handler: 'handler',
      entry: path.join(__dirname, '..', 'lambda', 'dashboard-break', 'index.ts'),
      timeout: cdk.Duration.seconds(120),
      memorySize: 256,
      role: breakLambdaRole,
      environment: {
        EVENTS_TABLE_NAME: eventsTable.tableName,
        NETWORK_OPS_ROLE_ARN: networkOpsRole.roleArn,
        EC2_INSTANCE_ID: props.ec2InstanceId,
        RDS_SECURITY_GROUP_ID: props.rdsSecurityGroupId,
        EC2_SECURITY_GROUP_ID: props.ec2SecurityGroupId,
        PRIVATE_ROUTE_TABLE_ID: props.privateRouteTableId,
        NAT_GATEWAY_ID: props.natGatewayId,
        S3_ENDPOINT_ID: props.s3EndpointId,
        BEDROCK_ENDPOINT_ID: props.bedrockEndpointId,
        BEDROCK_ENDPOINT_SUBNET_IDS: props.bedrockEndpointSubnetIds.join(','),
        ALB_LISTENER_ARN: props.albListenerArn,
        PCAP_STORAGE_BUCKET_ARN: props.pcapStorageBucketArn,
      },
      bundling: { minify: false, sourceMap: true },
    });

    // ── Task 10.3: Fix Lambda (POST /fix) ─────────────────────────────
    const fixLambdaRole = this.createLambdaRole('FixLambdaRole', 'Dashboard Fix Lambda');
    fixLambdaRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['dynamodb:PutItem', 'dynamodb:GetItem', 'dynamodb:DeleteItem'],
      resources: [eventsTable.tableArn],
    }));
    // AssumeRole on the network-ops-role
    fixLambdaRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['sts:AssumeRole'],
      resources: [networkOpsRole.roleArn],
    }));

    // Restrict NetworkOpsRole trust to only the break/fix Lambda roles
    const cfnNetworkOpsRole = networkOpsRole.node.defaultChild as cdk.CfnResource;
    cfnNetworkOpsRole.addPropertyOverride('AssumeRolePolicyDocument', {
      Version: '2012-10-17',
      Statement: [{
        Effect: 'Allow',
        Principal: {
          AWS: [breakLambdaRole.roleArn, fixLambdaRole.roleArn],
        },
        Action: 'sts:AssumeRole',
      }],
    });

    const fixLambda = new lambda.NodejsFunction(this, 'FixHandler', {
      runtime: lambdaRuntime.Runtime.NODEJS_20_X,
      handler: 'handler',
      entry: path.join(__dirname, '..', 'lambda', 'dashboard-fix', 'index.ts'),
      timeout: cdk.Duration.seconds(120),
      memorySize: 256,
      role: fixLambdaRole,
      environment: {
        EVENTS_TABLE_NAME: eventsTable.tableName,
        NETWORK_OPS_ROLE_ARN: networkOpsRole.roleArn,
        EC2_INSTANCE_ID: props.ec2InstanceId,
        RDS_SECURITY_GROUP_ID: props.rdsSecurityGroupId,
        EC2_SECURITY_GROUP_ID: props.ec2SecurityGroupId,
        PRIVATE_ROUTE_TABLE_ID: props.privateRouteTableId,
        NAT_GATEWAY_ID: props.natGatewayId,
        S3_ENDPOINT_ID: props.s3EndpointId,
        BEDROCK_ENDPOINT_ID: props.bedrockEndpointId,
        BEDROCK_ENDPOINT_SUBNET_IDS: props.bedrockEndpointSubnetIds.join(','),
        ALB_LISTENER_ARN: props.albListenerArn,
      },
      bundling: { minify: false, sourceMap: true },
    });

    // ── Task 10.3: Events Lambda (GET /events) ────────────────────────
    const eventsLambdaRole = this.createLambdaRole('EventsLambdaRole', 'Dashboard Events Lambda');
    eventsLambdaRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['dynamodb:Query'],
      resources: [eventsTable.tableArn],
    }));

    const eventsLambda = new lambda.NodejsFunction(this, 'EventsHandler', {
      runtime: lambdaRuntime.Runtime.NODEJS_20_X,
      handler: 'handler',
      entry: path.join(__dirname, '..', 'lambda', 'dashboard-events', 'index.ts'),
      timeout: cdk.Duration.seconds(30),
      memorySize: 128,
      role: eventsLambdaRole,
      environment: {
        EVENTS_TABLE_NAME: eventsTable.tableName,
      },
      bundling: { minify: false, sourceMap: true },
    });

    // ── Task 10.3: Config Lambda (GET /config) ────────────────────────
    const configLambdaRole = this.createLambdaRole('ConfigLambdaRole', 'Dashboard Config Lambda');
    configLambdaRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['secretsmanager:GetSecretValue'],
      resources: [props.webhookSecretArn],
    }));
    configLambdaRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['cognito-idp:DescribeUserPoolClient'],
      resources: [`arn:aws:cognito-idp:${this.region}:${this.account}:userpool/${props.userPoolId}`],
    }));
    configLambdaRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['secretsmanager:GetSecretValue'],
      resources: [props.dashboardCredentialsSecretArn],
    }));
    configLambdaRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ssm:GetParameter'],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/pcap-mcp/*`],
    }));

    const configLambda = new lambda.NodejsFunction(this, 'ConfigHandler', {
      runtime: lambdaRuntime.Runtime.NODEJS_20_X,
      handler: 'handler',
      entry: path.join(__dirname, '..', 'lambda', 'dashboard-config', 'index.ts'),
      timeout: cdk.Duration.seconds(30),
      memorySize: 128,
      role: configLambdaRole,
      environment: {
        MCP_ENDPOINT_URL: props.mcpEndpointUrl,
        COGNITO_CLIENT_ID: props.m2mClientId,
        COGNITO_USER_POOL_ID: props.userPoolId,
        COGNITO_TOKEN_ENDPOINT: props.oauthTokenEndpoint,
        VPC_FLOW_LOG_BUCKET_ARN: props.vpcFlowLogBucketArn,
        ELB_ACCESS_LOG_BUCKET_ARN: props.elbAccessLogBucketArn,
        PCAP_STORAGE_BUCKET_ARN: props.pcapStorageBucketArn,
        WEBHOOK_SECRET_ARN: props.webhookSecretArn,
        AGENT_SPACE_ID: props.agentSpaceId,
        DASHBOARD_CLIENT_ID: props.dashboardClientId,
        DASHBOARD_CREDENTIALS_SECRET_ARN: props.dashboardCredentialsSecretArn,
      },
      bundling: { minify: false, sourceMap: true },
    });

    // ── Task 10.3: Webhook Config Lambda (POST /webhook-config) ───────
    const webhookConfigRole = this.createLambdaRole('WebhookConfigLambdaRole', 'Dashboard Webhook Config Lambda');
    webhookConfigRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['secretsmanager:GetSecretValue', 'secretsmanager:PutSecretValue'],
      resources: [props.webhookSecretArn],
    }));

    const webhookConfigLambda = new lambda.NodejsFunction(this, 'WebhookConfigHandler', {
      runtime: lambdaRuntime.Runtime.NODEJS_20_X,
      handler: 'handler',
      entry: path.join(__dirname, '..', 'lambda', 'dashboard-webhook-config', 'index.ts'),
      timeout: cdk.Duration.seconds(30),
      memorySize: 128,
      role: webhookConfigRole,
      environment: {
        WEBHOOK_SECRET_ARN: props.webhookSecretArn,
        EVENTS_TABLE_NAME: eventsTable.tableName,
      },
      bundling: { minify: false, sourceMap: true },
    });

    // ── Task 10.3: API Gateway REST API ───────────────────────────────
    const api = new apigateway.RestApi(this, 'DashboardApi', {
      restApiName: 'devops-dashboard-api',
      description: 'API for DevOps Agent dashboard',
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: ['Content-Type', 'Authorization'],
      },
      deployOptions: {
        stageName: 'prod',
      },
    });

    // ── Cognito Authorizer for dashboard endpoints ──────────────────
    const userPool = cognito.UserPool.fromUserPoolId(this, 'ImportedUserPool', props.userPoolId);
    const authorizer = new apigateway.CognitoUserPoolsAuthorizer(this, 'DashboardAuthorizer', {
      cognitoUserPools: [userPool],
      authorizerName: 'dashboard-cognito-auth',
    });
    const authMethodOptions = {
      authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    };

    // GET /health
    const healthResource = api.root.addResource('health');
    healthResource.addMethod('GET', new apigateway.LambdaIntegration(healthLambda), authMethodOptions);

    // POST /t
    const breakResource = api.root.addResource('t');
    breakResource.addMethod('POST', new apigateway.LambdaIntegration(breakLambda), authMethodOptions);

    // POST /r
    const fixResource = api.root.addResource('r');
    fixResource.addMethod('POST', new apigateway.LambdaIntegration(fixLambda), authMethodOptions);

    // GET /events
    const eventsResource = api.root.addResource('events');
    eventsResource.addMethod('GET', new apigateway.LambdaIntegration(eventsLambda), authMethodOptions);

    // GET /config
    const configResource = api.root.addResource('config');
    configResource.addMethod('GET', new apigateway.LambdaIntegration(configLambda), authMethodOptions);

    // POST /webhook-config
    const webhookConfigResource = api.root.addResource('webhook-config');
    webhookConfigResource.addMethod('POST', new apigateway.LambdaIntegration(webhookConfigLambda), authMethodOptions);

    // ── Task 10.4: S3 + CloudFront Frontend Hosting ───────────────────
    const frontendBucket = new s3.Bucket(this, 'DashboardBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const distribution = new cloudfront.Distribution(this, 'DashboardDistribution', {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(frontendBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
      defaultRootObject: 'index.html',
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
    });

    // Deploy frontend files to S3 with CloudFront cache invalidation
    new s3deploy.BucketDeployment(this, 'DeployFrontend', {
      sources: [s3deploy.Source.asset(path.join(__dirname, '..', 'frontend'))],
      destinationBucket: frontendBucket,
      distribution,
      distributionPaths: ['/*'],
    });

    // ── Set CORS origin for all Lambda handlers ──────────────────────
    const allowedOrigin = `https://${distribution.distributionDomainName}`;
    [healthLambda, breakLambda, fixLambda, eventsLambda, configLambda, webhookConfigLambda].forEach(fn => {
      fn.addEnvironment('ALLOWED_ORIGIN', allowedOrigin);
    });

    // ── Export stack properties ─────────────────────────────────────────
    this.eventsTableName = eventsTable.tableName;
    this.eventsTableArn = eventsTable.tableArn;

    // ── CloudFormation Outputs ──────────────────────────────────────────
    new cdk.CfnOutput(this, 'DashboardUrl', {
      value: `https://${distribution.distributionDomainName}?api=${api.url}&region=${cdk.Aws.REGION}&userPoolId=${props.userPoolId}&clientId=${props.dashboardClientId}&credentialsArn=${props.dashboardCredentialsSecretArn}`,
      description: 'Dashboard URL (open this — login credentials in Secrets Manager: devops-dashboard-admin)',
    });

    new cdk.CfnOutput(this, 'DashboardApiUrl', {
      value: api.url,
      description: 'Dashboard API Gateway URL',
    });

    new cdk.CfnOutput(this, 'EventsTableName', {
      value: eventsTable.tableName,
      description: 'DynamoDB events table name',
    });

    new cdk.CfnOutput(this, 'EventsTableArn', {
      value: eventsTable.tableArn,
      description: 'DynamoDB events table ARN',
    });

    // ── Agent Space IAM Policy Statement (Task 14.2) ────────────────────
    // S3 read access scoped to AWSLogs prefix on VPC Flow Log and ELB
    // Access Log buckets, plus full read on PCAP bucket.
    const agentSpacePolicy = JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        {
          Sid: 'ReadVpcFlowLogs',
          Effect: 'Allow',
          Action: ['s3:GetObject', 's3:ListBucket'],
          Resource: [
            props.vpcFlowLogBucketArn,
            `${props.vpcFlowLogBucketArn}/AWSLogs/*`,
          ],
        },
        {
          Sid: 'ReadElbAccessLogs',
          Effect: 'Allow',
          Action: ['s3:GetObject', 's3:ListBucket'],
          Resource: [
            props.elbAccessLogBucketArn,
            `${props.elbAccessLogBucketArn}/AWSLogs/*`,
          ],
        },
        {
          Sid: 'ReadPcapStorage',
          Effect: 'Allow',
          Action: ['s3:GetObject', 's3:ListBucket'],
          Resource: [
            props.pcapStorageBucketArn,
            `${props.pcapStorageBucketArn}/*`,
          ],
        },
      ],
    });

    new cdk.CfnOutput(this, 'AgentSpaceIamPolicy', {
      value: agentSpacePolicy,
      description: 'IAM policy JSON for Agent Space S3 read access (VPC Flow Logs, ELB Access Logs, PCAP Storage)',
    });

    // ── cdk-nag suppressions ───────────────────────────────────────────
    NagSuppressions.addStackSuppressions(this, [
      { id: 'AwsSolutions-IAM5', reason: 'Wildcard resources required for EC2 break/fix operations (security groups, routes, VPC endpoints), SSM SendCommand, CloudWatch Logs write, cloudwatch:DescribeAlarms (no resource-level support), and aidevops:GetInvestigationSummary.' },
      { id: 'AwsSolutions-IAM4', reason: 'No AWS managed policies used in this stack.' },
      { id: 'AwsSolutions-L1', reason: 'Node.js 20.x is the latest LTS runtime supported by CDK NodejsFunction.' },
      { id: 'AwsSolutions-APIG2', reason: 'API Gateway request validation not required for demo dashboard.' },
      { id: 'AwsSolutions-APIG1', reason: 'API Gateway access logging not required for demo dashboard.' },
      { id: 'AwsSolutions-APIG3', reason: 'WAF not required for demo dashboard API.' },
      { id: 'AwsSolutions-APIG6', reason: 'API Gateway CloudWatch logging not required for demo dashboard.' },
      { id: 'AwsSolutions-APIG4', reason: 'Cognito authorizer is attached to all API Gateway methods.' },
      { id: 'AwsSolutions-COG4', reason: 'Cognito authorizer is attached to all API Gateway methods.' },
      { id: 'AwsSolutions-S1', reason: 'S3 access logging not required for demo dashboard bucket.' },
      { id: 'AwsSolutions-S10', reason: 'S3 SSL enforcement handled by CloudFront OAC.' },
      { id: 'AwsSolutions-CFR1', reason: 'CloudFront geo restriction not required for demo.' },
      { id: 'AwsSolutions-CFR2', reason: 'CloudFront WAF not required for demo.' },
      { id: 'AwsSolutions-CFR3', reason: 'CloudFront access logging not required for demo.' },
      { id: 'AwsSolutions-CFR4', reason: 'CloudFront custom SSL certificate not required for demo.' },
      { id: 'AwsSolutions-DDB3', reason: 'DynamoDB point-in-time recovery not required for ephemeral demo events (24h TTL).' },
      { id: 'AwsSolutions-SQS3', reason: 'Dead-letter queue not required for demo dashboard.' },
      { id: 'AwsSolutions-SQS4', reason: 'SQS SSL not applicable for demo dashboard.' },
    ]);
  }

  /** Create a Lambda execution role with CloudWatch Logs write permissions */
  private createLambdaRole(id: string, description: string): iam.Role {
    const role = new iam.Role(this, id, {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description,
    });
    role.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
      resources: ['*'],
    }));
    return role;
  }
}
