import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as lambdaFn from 'aws-cdk-lib/aws-lambda';
import * as cr from 'aws-cdk-lib/custom-resources';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';

/**
 * AuthStack — Cognito User Pool, Resource Server, M2M App Client,
 * Dashboard App Client with auto-provisioned admin user.
 *
 * Provides OAuth2 client_credentials authentication for the PCAP MCP
 * Server AgentCore Runtime, plus user authentication for the dashboard.
 *
 * Requirements: 6.2
 */
export class AuthStack extends cdk.Stack {
  /** Cognito User Pool ID. */
  public readonly userPoolId: string;
  /** Cognito User Pool ARN. */
  public readonly userPoolArn: string;
  /** OIDC discovery URL for JWT authorization. */
  public readonly oauthDiscoveryUrl: string;
  /** M2M app client ID. */
  public readonly m2mClientId: string;
  /** OAuth2 token endpoint URL. */
  public readonly oauthTokenEndpoint: string;
  /** Dashboard app client ID (user auth). */
  public readonly dashboardClientId: string;
  /** Secrets Manager ARN for dashboard admin credentials. */
  public readonly dashboardCredentialsSecretArn: string;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // -----------------------------------------------------------------------
    // Cognito User Pool — M2M + dashboard user auth
    // -----------------------------------------------------------------------
    const userPool = new cognito.UserPool(this, 'PcapMcpUserPool', {
      userPoolName: 'pcap-mcp-user-pool',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      mfa: cognito.Mfa.OFF,
      selfSignUpEnabled: false,
      signInAliases: { email: true },
    });

    // Prefix-based Cognito domain for token endpoint
    const domainPrefix = `pcap-mcp-${cdk.Aws.ACCOUNT_ID}`;
    userPool.addDomain('PcapMcpDomain', {
      cognitoDomain: {
        domainPrefix,
      },
    });

    // Resource server with custom scope for PCAP analysis
    const resourceServer = userPool.addResourceServer('PcapResourceServer', {
      identifier: 'pcap-analysis',
      userPoolResourceServerName: 'PCAP Analysis API',
      scopes: [
        new cognito.ResourceServerScope({
          scopeName: 'read',
          scopeDescription: 'Read access to PCAP analysis tools',
        }),
      ],
    });

    // M2M app client — client_credentials grant only
    const m2mClient = userPool.addClient('PcapMcpAppClient', {
      userPoolClientName: 'pcap-mcp-client',
      generateSecret: true,
      oAuth: {
        flows: {
          clientCredentials: true,
        },
        scopes: [
          cognito.OAuthScope.resourceServer(
            resourceServer,
            new cognito.ResourceServerScope({
              scopeName: 'read',
              scopeDescription: 'Read access to PCAP analysis tools',
            }),
          ),
        ],
      },
      authFlows: {
        userSrp: false,
        userPassword: false,
        adminUserPassword: false,
        custom: false,
      },
    });

    // -----------------------------------------------------------------------
    // Dashboard App Client — user authentication for the dashboard UI
    // -----------------------------------------------------------------------
    const dashboardClient = userPool.addClient('DashboardAppClient', {
      userPoolClientName: 'dashboard-client',
      generateSecret: false,
      authFlows: {
        userPassword: true,
        userSrp: true,
      },
      idTokenValidity: cdk.Duration.hours(12),
      accessTokenValidity: cdk.Duration.hours(12),
      refreshTokenValidity: cdk.Duration.days(7),
    });

    // -----------------------------------------------------------------------
    // Auto-provision dashboard admin user via Secrets Manager + Custom Resource
    // -----------------------------------------------------------------------
    const dashboardSecret = new secretsmanager.Secret(this, 'DashboardAdminCredentials', {
      secretName: 'devops-dashboard-admin',
      description: 'Dashboard admin credentials (auto-generated)',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: 'admin@devops.local' }),
        generateStringKey: 'password',
        passwordLength: 16,
        excludeCharacters: '/"\'\\@`~{}[]|:;<>,',
        includeSpace: false,
        requireEachIncludedType: true,
      },
    });

    // Custom resource Lambda — reads password from Secrets Manager at runtime
    // (never appears in CloudFormation template)
    const userProvisionerFn = new lambdaFn.Function(this, 'UserProvisionerFn', {
      runtime: lambdaFn.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      timeout: cdk.Duration.seconds(30),
      code: lambdaFn.Code.fromInline(`
const { CognitoIdentityProviderClient, AdminCreateUserCommand, AdminSetUserPasswordCommand, AdminDeleteUserCommand } = require('@aws-sdk/client-cognito-identity-provider');
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
const response = require('cfn-response');
exports.handler = async (event, context) => {
  const props = event.ResourceProperties;
  try {
    if (event.RequestType === 'Delete') {
      const cognito = new CognitoIdentityProviderClient({});
      try {
        await cognito.send(new AdminDeleteUserCommand({ UserPoolId: props.UserPoolId, Username: props.Username }));
      } catch (e) { if (e.name !== 'UserNotFoundException') throw e; }
      return response.send(event, context, response.SUCCESS, {});
    }
    const sm = new SecretsManagerClient({});
    const secret = await sm.send(new GetSecretValueCommand({ SecretId: props.SecretArn }));
    const password = JSON.parse(secret.SecretString).password;
    const cognito = new CognitoIdentityProviderClient({});
    if (event.RequestType === 'Create') {
      try {
        await cognito.send(new AdminCreateUserCommand({
          UserPoolId: props.UserPoolId, Username: props.Username,
          TemporaryPassword: password, MessageAction: 'SUPPRESS',
          UserAttributes: [{ Name: 'email', Value: props.Username }, { Name: 'email_verified', Value: 'true' }],
        }));
      } catch (e) { if (e.name !== 'UsernameExistsException') throw e; }
    }
    await cognito.send(new AdminSetUserPasswordCommand({
      UserPoolId: props.UserPoolId, Username: props.Username, Password: password, Permanent: true,
    }));
    return response.send(event, context, response.SUCCESS, {});
  } catch (e) {
    console.error(e);
    return response.send(event, context, response.FAILED, { Error: e.message });
  }
};
      `),
    });
    dashboardSecret.grantRead(userProvisionerFn);
    userProvisionerFn.addToRolePolicy(new cdk.aws_iam.PolicyStatement({
      actions: ['cognito-idp:AdminCreateUser', 'cognito-idp:AdminDeleteUser', 'cognito-idp:AdminSetUserPassword'],
      resources: [userPool.userPoolArn],
    }));

    const userProvisioner = new cdk.CustomResource(this, 'DashboardUserProvisioner', {
      serviceToken: userProvisionerFn.functionArn,
      properties: {
        UserPoolId: userPool.userPoolId,
        Username: 'admin@devops.local',
        SecretArn: dashboardSecret.secretArn,
      },
    });

    // -----------------------------------------------------------------------
    // Cross-stack exports
    // -----------------------------------------------------------------------
    this.userPoolId = userPool.userPoolId;
    this.userPoolArn = userPool.userPoolArn;
    this.oauthDiscoveryUrl = `https://cognito-idp.${cdk.Aws.REGION}.amazonaws.com/${userPool.userPoolId}/.well-known/openid-configuration`;
    this.m2mClientId = m2mClient.userPoolClientId;
    this.oauthTokenEndpoint = `https://${domainPrefix}.auth.${cdk.Aws.REGION}.amazoncognito.com/oauth2/token`;
    this.dashboardClientId = dashboardClient.userPoolClientId;
    this.dashboardCredentialsSecretArn = dashboardSecret.secretArn;

    // -----------------------------------------------------------------------
    // CfnOutputs
    // -----------------------------------------------------------------------
    new cdk.CfnOutput(this, 'UserPoolId', {
      value: userPool.userPoolId,
      description: 'Cognito User Pool ID',
    });

    new cdk.CfnOutput(this, 'OAuthDiscoveryUrl', {
      value: this.oauthDiscoveryUrl,
      description: 'OIDC discovery URL for JWT authorization',
    });

    new cdk.CfnOutput(this, 'M2MClientId', {
      value: m2mClient.userPoolClientId,
      description: 'M2M app client ID for OAuth2 client credentials flow',
    });

    new cdk.CfnOutput(this, 'OAuthTokenEndpoint', {
      value: this.oauthTokenEndpoint,
      description: 'OAuth 2.0 token endpoint for client_credentials grant',
    });

    new cdk.CfnOutput(this, 'DashboardClientId', {
      value: dashboardClient.userPoolClientId,
      description: 'Dashboard app client ID for user authentication',
    });

    new cdk.CfnOutput(this, 'DashboardCredentialsSecretArn', {
      value: dashboardSecret.secretArn,
      description: 'Secrets Manager ARN for dashboard admin credentials — retrieve with: aws secretsmanager get-secret-value --secret-id devops-dashboard-admin',
    });

    // -----------------------------------------------------------------------
    // cdk-nag suppressions
    // -----------------------------------------------------------------------
    NagSuppressions.addStackSuppressions(this, [
      {
        id: 'AwsSolutions-COG1',
        reason:
          'Cognito User Pool is used for M2M authentication and demo dashboard. Password policy defaults are acceptable for demo.',
      },
      {
        id: 'AwsSolutions-COG2',
        reason:
          'MFA is intentionally disabled. This is a demo project — M2M auth and single-user dashboard do not require MFA.',
      },
      {
        id: 'AwsSolutions-COG8',
        reason:
          'Cognito Plus tier (advanced security features) is not required for this demo project.',
      },
      {
        id: 'AwsSolutions-L1',
        reason:
          'Internal CDK CustomResource Lambda runtime version is managed by CDK.',
      },
      {
        id: 'AwsSolutions-IAM4',
        reason:
          'AWSLambdaBasicExecutionRole managed policy is used by internal CDK CustomResource Lambdas. This is AWS best practice.',
        appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'],
      },
      {
        id: 'AwsSolutions-IAM5',
        reason:
          'Wildcard permissions are used by internal CDK CustomResource Lambdas for Cognito operations.',
      },
      {
        id: 'AwsSolutions-SMG4',
        reason:
          'Dashboard admin credentials secret does not require automatic rotation for this demo project.',
      },
    ]);
  }
}
