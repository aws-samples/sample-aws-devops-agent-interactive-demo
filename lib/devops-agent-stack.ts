import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as devopsagent from 'aws-cdk-lib/aws-devopsagent';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';

export interface DevOpsAgentStackProps extends cdk.StackProps {
  /** MCP Server endpoint URL for Agent Space registration. */
  readonly mcpEndpointUrl: string;
  /** M2M app client ID (from AuthStack). */
  readonly m2mClientId: string;
  /** OAuth token endpoint (from AuthStack). */
  readonly oauthTokenEndpoint: string;
  /** VPC Flow Log bucket ARN for S3 read access. */
  readonly vpcFlowLogBucketArn: string;
  /** ELB Access Log bucket ARN for S3 read access. */
  readonly elbAccessLogBucketArn: string;
  /** PCAP Storage bucket ARN for S3 read access. */
  readonly pcapStorageBucketArn: string;
}

/**
 * DevOpsAgentStack — Agent Space, IAM roles, account association.
 *
 * Creates the DevOps Agent Agent Space with proper IAM roles and
 * outputs all configuration needed for MCP server registration and
 * webhook setup.
 */
export class DevOpsAgentStack extends cdk.Stack {
  /** Agent Space ID. */
  public readonly agentSpaceId: string;
  /** Agent Space ARN. */
  public readonly agentSpaceArn: string;

  constructor(scope: Construct, id: string, props: DevOpsAgentStackProps) {
    super(scope, id, props);

    // --- IAM Role for Agent Space ---
    const agentSpaceRole = new iam.Role(this, 'AgentSpaceRole', {
      assumedBy: new iam.ServicePrincipal('aidevops.amazonaws.com', {
        conditions: {
          StringEquals: {
            'aws:SourceAccount': this.account,
          },
          ArnLike: {
            'aws:SourceArn': `arn:aws:aidevops:${this.region}:${this.account}:agentspace/*`,
          },
        },
      }),
      description: 'IAM role for Network DevOps Agent Space',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AIDevOpsAgentAccessPolicy'),
      ],
      inlinePolicies: {
        AllowCreateServiceLinkedRoles: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              sid: 'AllowCreateServiceLinkedRoles',
              effect: iam.Effect.ALLOW,
              actions: ['iam:CreateServiceLinkedRole'],
              resources: [
                `arn:aws:iam::${this.account}:role/aws-service-role/resource-explorer-2.amazonaws.com/AWSServiceRoleForResourceExplorer`,
              ],
            }),
          ],
        }),
        S3ReadAccess: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              sid: 'ReadVpcFlowLogs',
              effect: iam.Effect.ALLOW,
              actions: ['s3:GetObject', 's3:ListBucket'],
              resources: [
                props.vpcFlowLogBucketArn,
                `${props.vpcFlowLogBucketArn}/AWSLogs/*`,
              ],
            }),
            new iam.PolicyStatement({
              sid: 'ReadElbAccessLogs',
              effect: iam.Effect.ALLOW,
              actions: ['s3:GetObject', 's3:ListBucket'],
              resources: [
                props.elbAccessLogBucketArn,
                `${props.elbAccessLogBucketArn}/AWSLogs/*`,
              ],
            }),
            new iam.PolicyStatement({
              sid: 'ReadPcapStorage',
              effect: iam.Effect.ALLOW,
              actions: ['s3:GetObject', 's3:ListBucket'],
              resources: [
                props.pcapStorageBucketArn,
                `${props.pcapStorageBucketArn}/*`,
              ],
            }),
          ],
        }),
      },
    });

    // --- IAM Role for Operator App ---
    const operatorAppRole = new iam.Role(this, 'OperatorAppRole', {
      assumedBy: new iam.ServicePrincipal('aidevops.amazonaws.com'),
      description: 'IAM role for Network DevOps Agent Operator App',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AIDevOpsOperatorAppAccessPolicy'),
      ],
    });

    // Override trust policy to include both sts:AssumeRole and sts:TagSession
    const trustPolicy = new iam.PolicyDocument({
      statements: [
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          principals: [new iam.ServicePrincipal('aidevops.amazonaws.com')],
          actions: ['sts:AssumeRole', 'sts:TagSession'],
          conditions: {
            StringEquals: {
              'aws:SourceAccount': this.account,
            },
            ArnLike: {
              'aws:SourceArn': `arn:aws:aidevops:${this.region}:${this.account}:agentspace/*`,
            },
          },
        }),
      ],
    });
    (operatorAppRole.node.defaultChild as iam.CfnRole).assumeRolePolicyDocument = trustPolicy;

    // --- Agent Space ---
    const agentSpace = new devopsagent.CfnAgentSpace(this, 'AgentSpace', {
      name: 'network-devops-agent-space',
      description: 'Agent Space for Network DevOps Agent — 6 break/fix scenarios with S3 log analysis and PCAP MCP tools',
      operatorApp: {
        iam: {
          operatorAppRoleArn: operatorAppRole.roleArn,
        },
      },
    });

    // --- Account Association (monitor) ---
    const accountAssociation = new devopsagent.CfnAssociation(this, 'AccountAssociation', {
      agentSpaceId: agentSpace.ref,
      serviceId: 'aws',
      configuration: {
        aws: {
          accountId: this.account,
          accountType: 'monitor',
          assumableRoleArn: agentSpaceRole.roleArn,
          resources: [],
        },
      },
    });
    accountAssociation.addDependency(agentSpace);

    // --- Exports ---
    this.agentSpaceId = agentSpace.ref;
    this.agentSpaceArn = agentSpace.attrArn;

    // --- CfnOutputs ---
    new cdk.CfnOutput(this, 'AgentSpaceId', {
      value: agentSpace.ref,
      description: 'DevOps Agent Agent Space ID',
    });

    new cdk.CfnOutput(this, 'AgentSpaceArn', {
      value: agentSpace.attrArn,
      description: 'DevOps Agent Agent Space ARN',
    });

    new cdk.CfnOutput(this, 'AgentSpaceConsoleUrl', {
      value: `https://${cdk.Aws.REGION}.console.aws.amazon.com/aidevops/home?region=${cdk.Aws.REGION}#/agent-spaces/${agentSpace.ref}`,
      description: 'Open this URL to configure the Agent Space in the AWS Console',
    });

    new cdk.CfnOutput(this, 'AgentSpaceRoleArn', {
      value: agentSpaceRole.roleArn,
      description: 'Agent Space IAM Role ARN (with S3 read access to all 3 buckets)',
    });

    new cdk.CfnOutput(this, 'McpEndpointUrl', {
      value: props.mcpEndpointUrl,
      description: 'MCP server endpoint URL — use when registering MCP server in Agent Space',
    });

    new cdk.CfnOutput(this, 'CognitoClientId', {
      value: props.m2mClientId,
      description: 'Cognito client ID — use as Client ID when registering MCP server with OAuth',
    });

    new cdk.CfnOutput(this, 'OAuthTokenEndpoint', {
      value: props.oauthTokenEndpoint,
      description: 'OAuth token endpoint — use as Token Endpoint when registering MCP server',
    });

    new cdk.CfnOutput(this, 'Step1RegisterMcpServer', {
      value: [
        'MANUAL STEP: Register MCP Server in Agent Space.',
        `1. Open Agent Space console: https://${cdk.Aws.REGION}.console.aws.amazon.com/aidevops/home?region=${cdk.Aws.REGION}#/agent-spaces/${agentSpace.ref}`,
        '2. Go to Capabilities tab → MCP Servers → Register MCP Server',
        '3. Name: network-pcap (keep short — name + tool name must be under 64 chars)',
        '4. Auth type: OAuth Client Credentials',
        '5. Use McpEndpointUrl, CognitoClientId, OAuthTokenEndpoint outputs above',
      ].join(' | '),
      description: 'STEP 1 — Register the MCP server endpoint in the DevOps Agent console',
    });

    new cdk.CfnOutput(this, 'Step2ConfigureWebhook', {
      value: [
        'MANUAL STEP: Configure Webhook in Agent Space.',
        `1. Open Agent Space console: https://${cdk.Aws.REGION}.console.aws.amazon.com/aidevops/home?region=${cdk.Aws.REGION}#/agent-spaces/${agentSpace.ref}`,
        '2. Go to Capabilities tab → Webhooks → Configure → Generate webhook',
        '3. Copy the Webhook URL and HMAC Secret',
        '4. Paste them into the dashboard webhook configuration section',
      ].join(' | '),
      description: 'STEP 2 — Generate webhook URL and HMAC secret in the Agent Space console',
    });

    // --- cdk-nag suppressions ---
    NagSuppressions.addStackSuppressions(this, [
      {
        id: 'AwsSolutions-IAM4',
        reason: 'AWS managed policies AIDevOpsAgentAccessPolicy and AIDevOpsOperatorAppAccessPolicy are required by DevOps Agent.',
      },
      {
        id: 'AwsSolutions-IAM5',
        reason: 'ArnLike condition on trust policy uses wildcard for agentspace/* which is required before the Agent Space is created. S3 read access uses AWSLogs/* prefix.',
      },
    ]);
  }
}
