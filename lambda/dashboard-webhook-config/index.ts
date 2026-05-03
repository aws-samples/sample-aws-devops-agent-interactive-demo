/**
 * Dashboard Webhook Config Lambda — POST /webhook-config
 *
 * Accepts POST body with webhookUrl and hmacSecret.
 * Stores them in Secrets Manager (not Lambda env vars).
 *
 * Requirements: 16.6
 */

import { SecretsManagerClient, PutSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const smClient = new SecretsManagerClient({});
const WEBHOOK_SECRET_ARN = process.env.WEBHOOK_SECRET_ARN!;

const corsHeaders = {
  'Access-Control-Allow-Origin': process.env.ALLOWED_ORIGIN!,
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
};

export const handler = async (event: any) => {
  try {
    const body = JSON.parse(event.body || '{}');

    if (!body.webhookUrl || !body.hmacSecret) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({ error: 'webhookUrl and hmacSecret are required' }),
      };
    }

    // Validate webhook URL to prevent SSRF
    try {
      const parsedUrl = new URL(body.webhookUrl);
      if (parsedUrl.protocol !== 'https:') {
        return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Webhook URL must use HTTPS' }) };
      }
      const allowedDomains = ['.amazonaws.com', '.aws.amazon.com', '.api.aws'];
      if (!allowedDomains.some(d => parsedUrl.hostname.endsWith(d))) {
        return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Webhook URL must be an AWS endpoint' }) };
      }
    } catch {
      return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Invalid webhook URL format' }) };
    }

    await smClient.send(new PutSecretValueCommand({
      SecretId: WEBHOOK_SECRET_ARN,
      SecretString: JSON.stringify({
        webhookUrl: body.webhookUrl,
        hmacSecret: body.hmacSecret,
      }),
    }));

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({ message: 'Webhook configured successfully' }),
    };
  } catch (err: any) {
    console.error('Failed to configure webhook:', err);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Internal server error' }),
    };
  }
};
