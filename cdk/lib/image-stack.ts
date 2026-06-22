import * as cdk from 'aws-cdk-lib';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';
import * as path from 'path';

export interface ImageStackProps extends cdk.StackProps {
  /** AgentCore execution role ARN (from PcapMcpStack). */
  readonly agentCoreRoleArn: string;
  /** Cognito User Pool ID (from AuthStack). */
  readonly cognitoUserPoolId: string;
  /** Cognito M2M Client ID (from AuthStack). */
  readonly cognitoClientId: string;
}

/**
 * ImageStack — ECR + CodeBuild for Wireshark MCP Docker image + AgentCore Runtime.
 *
 * Builds the Docker image, pushes to ECR, then creates the AgentCore Runtime
 * via CLI (not CloudFormation) — matching the proven working pattern.
 * Runtime details are stored in SSM Parameters for other stacks to read.
 *
 * Requirements: 6.3
 */
export class ImageStack extends cdk.Stack {
  public readonly ecrRepository: ecr.Repository;

  constructor(scope: Construct, id: string, props: ImageStackProps) {
    super(scope, id, props);

    // --- ECR Repository ---
    this.ecrRepository = new ecr.Repository(this, 'PcapMcpServerRepo', {
      repositoryName: 'pcap-mcp-server-runtime',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      emptyOnDelete: true,
      imageScanOnPush: true,
      lifecycleRules: [{ maxImageCount: 10, description: 'Keep last 10 images' }],
    });

    // --- S3 Bucket for CodeBuild source ---
    const sourceBucket = new s3.Bucket(this, 'CodeBuildSourceBucket', {
      versioned: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // Upload codebuild-scripts/ to S3
    const scriptsDeployment = new s3deploy.BucketDeployment(this, 'DeployCodeBuildScripts', {
      sources: [s3deploy.Source.asset(path.join(__dirname, '../codebuild-scripts'))],
      destinationBucket: sourceBucket,
      destinationKeyPrefix: 'codebuild-scripts',
    });

    // --- CodeBuild Role (matching working CFN pattern) ---
    const codeBuildRole = new iam.Role(this, 'CodeBuildRole', {
      assumedBy: new iam.ServicePrincipal('codebuild.amazonaws.com'),
    });

    // ECR push
    codeBuildRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'ecr:BatchCheckLayerAvailability', 'ecr:GetDownloadUrlForLayer',
        'ecr:BatchGetImage', 'ecr:PutImage',
        'ecr:InitiateLayerUpload', 'ecr:UploadLayerPart', 'ecr:CompleteLayerUpload',
      ],
      resources: [this.ecrRepository.repositoryArn],
    }));

    // ECR auth token
    codeBuildRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ecr:GetAuthorizationToken'],
      resources: ['*'],
    }));

    // S3 read on source bucket
    codeBuildRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['s3:GetObject', 's3:GetObjectVersion'],
      resources: [sourceBucket.arnForObjects('*')],
    }));

    // CloudWatch Logs
    codeBuildRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
      resources: ['*'],
    }));

    // AgentCore — create/manage runtime (matching working CFN)
    codeBuildRole.addToPolicy(new iam.PolicyStatement({
      sid: 'AgentCoreRuntime',
      effect: iam.Effect.ALLOW,
      actions: ['bedrock-agentcore:*'],
      resources: [
        `arn:aws:bedrock-agentcore:${this.region}:${this.account}:runtime/*`,
        `arn:aws:bedrock-agentcore:${this.region}:${this.account}:*`,
      ],
    }));

    // PassRole — allow CodeBuild to pass the AgentCore execution role
    codeBuildRole.addToPolicy(new iam.PolicyStatement({
      sid: 'PassRole',
      effect: iam.Effect.ALLOW,
      actions: ['iam:PassRole'],
      resources: [props.agentCoreRoleArn],
    }));

    // Service-Linked Role creation (AgentCore creates SLRs automatically)
    codeBuildRole.addToPolicy(new iam.PolicyStatement({
      sid: 'CreateServiceLinkedRoles',
      effect: iam.Effect.ALLOW,
      actions: ['iam:CreateServiceLinkedRole'],
      resources: [
        'arn:aws:iam::*:role/aws-service-role/runtime-identity.bedrock-agentcore.amazonaws.com/*',
        'arn:aws:iam::*:role/aws-service-role/network.bedrock-agentcore.amazonaws.com/*',
        'arn:aws:iam::*:role/aws-service-role/bedrock-agentcore.amazonaws.com/*',
      ],
    }));

    // SSM — write runtime details for other stacks to read
    codeBuildRole.addToPolicy(new iam.PolicyStatement({
      sid: 'SSMWriteParams',
      effect: iam.Effect.ALLOW,
      actions: ['ssm:PutParameter', 'ssm:GetParameter'],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/pcap-mcp/*`],
    }));

    // --- CodeBuild Project ---
    const buildProject = new codebuild.Project(this, 'PcapMcpBuildProject', {
      projectName: 'pcap-mcp-build',
      role: codeBuildRole,
      environment: {
        buildImage: codebuild.LinuxArmBuildImage.AMAZON_LINUX_2_STANDARD_3_0,
        computeType: codebuild.ComputeType.MEDIUM,
        privileged: true,
      },
      source: codebuild.Source.s3({
        bucket: sourceBucket,
        path: 'codebuild-scripts/',
      }),
      buildSpec: codebuild.BuildSpec.fromSourceFilename('buildspec-pcap.yml'),
      timeout: cdk.Duration.minutes(30),
      environmentVariables: {
        AWS_DEFAULT_REGION: { value: cdk.Aws.REGION },
        AWS_ACCOUNT_ID: { value: cdk.Aws.ACCOUNT_ID },
        ECR_REPO_URI: { value: this.ecrRepository.repositoryUri },
        SOURCE_BUCKET: { value: sourceBucket.bucketName },
        ROLE_ARN: { value: props.agentCoreRoleArn },
        COGNITO_USER_POOL_ID: { value: props.cognitoUserPoolId },
        COGNITO_CLIENT_ID: { value: props.cognitoClientId },
      },
    });

    // --- Build Trigger Lambda ---
    const buildTriggerLogGroup = new logs.LogGroup(this, 'BuildTriggerLogGroup', {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const buildTriggerFn = new lambda.Function(this, 'BuildTriggerFunction', {
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/build-trigger')),
      timeout: cdk.Duration.minutes(1),
      logGroup: buildTriggerLogGroup,
    });
    buildTriggerFn.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['codebuild:StartBuild'],
      resources: [buildProject.projectArn],
    }));

    // --- Build Waiter Lambda ---
    const buildWaiterLogGroup = new logs.LogGroup(this, 'BuildWaiterLogGroup', {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const buildWaiterFn = new lambda.Function(this, 'BuildWaiterFunction', {
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/build-waiter')),
      timeout: cdk.Duration.minutes(15),
      logGroup: buildWaiterLogGroup,
    });
    buildWaiterFn.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['codebuild:BatchGetBuilds'],
      resources: [buildProject.projectArn],
    }));

    // --- CustomResource: Build Trigger ---
    const triggerProvider = new cdk.custom_resources.Provider(this, 'BuildTriggerProvider', {
      onEventHandler: buildTriggerFn,
    });
    const buildTrigger = new cdk.CustomResource(this, 'BuildTriggerResource', {
      serviceToken: triggerProvider.serviceToken,
      properties: {
        ProjectName: buildProject.projectName,
        Timestamp: 'cli-runtime-v18-tool-allowlist',
      },
    });
    buildTrigger.node.addDependency(scriptsDeployment);

    // --- CustomResource: Build Waiter ---
    const waiterProvider = new cdk.custom_resources.Provider(this, 'BuildWaiterProvider', {
      onEventHandler: buildWaiterFn,
    });
    const buildWaiter = new cdk.CustomResource(this, 'BuildWaiterResource', {
      serviceToken: waiterProvider.serviceToken,
      properties: {
        BuildId: buildTrigger.getAttString('BuildId'),
      },
    });
    buildWaiter.node.addDependency(buildTrigger);

    // cdk-nag suppressions
    NagSuppressions.addStackSuppressions(this, [
      { id: 'AwsSolutions-IAM4', reason: 'AWSLambdaBasicExecutionRole managed policy is AWS best practice for Lambda logging.' },
      { id: 'AwsSolutions-IAM5', reason: 'Wildcard resources required for ecr:GetAuthorizationToken, CloudWatch Logs, AgentCore runtime management, and IAM SLR creation.' },
      { id: 'AwsSolutions-CB4', reason: 'KMS encryption for CodeBuild not required for demo.' },
      { id: 'AwsSolutions-S1', reason: 'S3 access logging not required for demo.' },
      { id: 'AwsSolutions-L1', reason: 'Lambda runtime version managed by CDK.' },
    ]);
  }
}
