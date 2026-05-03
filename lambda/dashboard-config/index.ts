/**
 * Dashboard Config Lambda — GET /config
 *
 * Returns PCAP MCP Server endpoint, OAuth credentials (including client secret),
 * S3 bucket ARNs, Agent Space console link, webhook configuration status, and IAM policy.
 *
 * Requirements: 16.5, 7.1, 7.2, 7.3, 7.4
 */

import { CognitoIdentityProviderClient, DescribeUserPoolClientCommand } from '@aws-sdk/client-cognito-identity-provider';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const cognitoClient = new CognitoIdentityProviderClient({});
const ssmClient = new SSMClient({});
const smClient = new SecretsManagerClient({});

const corsHeaders = {
  'Access-Control-Allow-Origin': process.env.ALLOWED_ORIGIN!,
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
};

// All values passed as environment variables from CDK
const MCP_ENDPOINT_URL = process.env.MCP_ENDPOINT_URL || '';
const COGNITO_CLIENT_ID = process.env.COGNITO_CLIENT_ID || '';
const COGNITO_USER_POOL_ID = process.env.COGNITO_USER_POOL_ID || '';
const COGNITO_TOKEN_ENDPOINT = process.env.COGNITO_TOKEN_ENDPOINT || '';
const VPC_FLOW_LOG_BUCKET_ARN = process.env.VPC_FLOW_LOG_BUCKET_ARN || '';
const ELB_ACCESS_LOG_BUCKET_ARN = process.env.ELB_ACCESS_LOG_BUCKET_ARN || '';
const PCAP_STORAGE_BUCKET_ARN = process.env.PCAP_STORAGE_BUCKET_ARN || '';
const WEBHOOK_SECRET_ARN = process.env.WEBHOOK_SECRET_ARN || '';
const AGENT_SPACE_ID = process.env.AGENT_SPACE_ID || '';
const DASHBOARD_CLIENT_ID = process.env.DASHBOARD_CLIENT_ID || '';
const DASHBOARD_CREDENTIALS_SECRET_ARN = process.env.DASHBOARD_CREDENTIALS_SECRET_ARN || '';

export const handler = async () => {
  const region = process.env.AWS_REGION || 'us-east-1';

  // Read MCP endpoint URL from SSM at runtime (written by CodeBuild)
  // This avoids the PENDING_CODEBUILD issue from CDK synth-time resolution
  let mcpEndpointUrl = process.env.MCP_ENDPOINT_URL || '';
  if (!mcpEndpointUrl || mcpEndpointUrl === 'PENDING_CODEBUILD') {
    try {
      const ssmRes = await ssmClient.send(new GetParameterCommand({ Name: '/pcap-mcp/mcp-endpoint-url' }));
      mcpEndpointUrl = ssmRes.Parameter?.Value || '';
    } catch (err) {
      console.warn('Failed to read MCP endpoint from SSM:', err);
    }
  }

  // Retrieve Cognito client secret at runtime (like ECS demo)
  let clientSecret: string | null = null;
  if (COGNITO_USER_POOL_ID && COGNITO_CLIENT_ID) {
    try {
      const res = await cognitoClient.send(new DescribeUserPoolClientCommand({
        UserPoolId: COGNITO_USER_POOL_ID,
        ClientId: COGNITO_CLIENT_ID,
      }));
      clientSecret = res.UserPoolClient?.ClientSecret || null;
    } catch (err) {
      console.warn('Failed to retrieve Cognito client secret:', err);
    }
  }

  // Retrieve dashboard admin credentials from Secrets Manager
  let dashboardCredentials: { username: string; password: string } | null = null;
  if (DASHBOARD_CREDENTIALS_SECRET_ARN) {
    try {
      const result = await smClient.send(new GetSecretValueCommand({ SecretId: DASHBOARD_CREDENTIALS_SECRET_ARN }));
      const parsed = JSON.parse(result.SecretString || '{}');
      dashboardCredentials = { username: parsed.username, password: parsed.password };
    } catch (err) {
      console.warn('Failed to retrieve dashboard credentials:', err);
    }
  }

  // Check webhook configuration status from Secrets Manager
  let webhookStatus = { configured: false, webhookUrl: null as string | null };
  if (WEBHOOK_SECRET_ARN) {
    try {
      const result = await smClient.send(new GetSecretValueCommand({ SecretId: WEBHOOK_SECRET_ARN }));
      const parsed = JSON.parse(result.SecretString || '{}');
      const webhookUrl = parsed.webhookUrl || '';
      webhookStatus = {
        configured: webhookUrl.length > 0 && !webhookUrl.startsWith('http://example'),
        webhookUrl: webhookUrl || null,
      };
    } catch (err) {
      console.warn('Failed to check webhook secret:', err);
    }
  }

  // Agent Space console link
  const agentSpaceId = AGENT_SPACE_ID;
  const consoleUrl = agentSpaceId
    ? `https://${region}.console.aws.amazon.com/aidevops/home?region=${region}#/agent-spaces/${agentSpaceId}`
    : `https://${region}.console.aws.amazon.com/aidevops/home?region=${region}`;

  // IAM policy statement for Agent Space S3 read access
  const iamPolicyStatement = {
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Action: ['s3:GetObject', 's3:ListBucket'],
        Resource: [
          VPC_FLOW_LOG_BUCKET_ARN,
          `${VPC_FLOW_LOG_BUCKET_ARN}/AWSLogs/*`,
          ELB_ACCESS_LOG_BUCKET_ARN,
          `${ELB_ACCESS_LOG_BUCKET_ARN}/AWSLogs/*`,
          PCAP_STORAGE_BUCKET_ARN,
          `${PCAP_STORAGE_BUCKET_ARN}/*`,
        ],
      },
    ],
  };

  return {
    statusCode: 200,
    headers: corsHeaders,
    body: JSON.stringify({
      mcpEndpointUrl: mcpEndpointUrl,
      cognitoClientId: COGNITO_CLIENT_ID,
      clientSecret: clientSecret,
      cognitoTokenEndpoint: COGNITO_TOKEN_ENDPOINT,
      auth: {
        userPoolId: COGNITO_USER_POOL_ID,
        dashboardClientId: DASHBOARD_CLIENT_ID,
        region,
        credentials: dashboardCredentials,
      },
      buckets: {
        vpcFlowLogs: VPC_FLOW_LOG_BUCKET_ARN,
        elbAccessLogs: ELB_ACCESS_LOG_BUCKET_ARN,
        pcapStorage: PCAP_STORAGE_BUCKET_ARN,
      },
      consoleUrl,
      agentSpaceId: agentSpaceId || '',
      webhook: webhookStatus,
      iamPolicyStatement,
    }),
  };
};
