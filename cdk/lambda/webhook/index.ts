/**
 * Webhook Lambda Handler
 *
 * Receives CloudWatch alarm notifications via SNS and relays them
 * to the DevOps Agent webhook endpoint with HMAC-SHA256 authentication.
 *
 * Requirements: 5.3, 5.4, 5.5, 5.6
 */

import * as crypto from 'crypto';
import { DynamoDBClient, PutItemCommand, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const ddbLookup = new DynamoDBClient({});
const smClient = new SecretsManagerClient({});

// Cache webhook credentials to avoid fetching on every invocation
let cachedWebhookUrl: string | null = null;
let cachedHmacSecret: string | null = null;
let cacheExpiry = 0;

async function getWebhookCredentials(): Promise<{ webhookUrl: string; hmacSecret: string } | null> {
  if (cachedWebhookUrl && cachedHmacSecret && Date.now() < cacheExpiry) {
    return { webhookUrl: cachedWebhookUrl, hmacSecret: cachedHmacSecret };
  }
  const secretArn = process.env.WEBHOOK_SECRET_ARN;
  if (!secretArn) return null;
  try {
    const result = await smClient.send(new GetSecretValueCommand({ SecretId: secretArn }));
    const parsed = JSON.parse(result.SecretString || '{}');
    if (!parsed.webhookUrl || !parsed.hmacSecret) return null;
    cachedWebhookUrl = parsed.webhookUrl;
    cachedHmacSecret = parsed.hmacSecret;
    cacheExpiry = Date.now() + 5 * 60 * 1000; // cache for 5 minutes
    return { webhookUrl: cachedWebhookUrl!, hmacSecret: cachedHmacSecret! };
  } catch (err) {
    console.error('Failed to fetch webhook credentials from Secrets Manager:', err);
    return null;
  }
}

/** Look up the active dashboard session ID from the SYSTEM/ACTIVE_SCENARIO record */
async function getActiveSessionId(): Promise<string | null> {
  const tableName = process.env.EVENTS_TABLE_NAME;
  if (!tableName) return null;
  try {
    const result = await ddbLookup.send(new GetItemCommand({
      TableName: tableName,
      Key: { sessionId: { S: 'SYSTEM' }, timestamp: { S: 'ACTIVE_SCENARIO' } },
    }));
    return result.Item?.activeSessionId?.S || null;
  } catch (err) {
    console.warn('Failed to look up active session:', err);
    return null;
  }
}

// ── SNS Event types (inline to avoid external dependency) ──────────────

interface SNSMessageAttribute {
  Type: string;
  Value: string;
}

interface SNSMessage {
  SignatureVersion: string;
  Timestamp: string;
  Signature: string;
  SigningCertUrl: string;
  MessageId: string;
  Message: string;
  MessageAttributes: Record<string, SNSMessageAttribute>;
  Type: string;
  UnsubscribeUrl: string;
  TopicArn: string;
  Subject?: string;
}

interface SNSEventRecord {
  EventVersion: string;
  EventSubscriptionArn: string;
  EventSource: string;
  Sns: SNSMessage;
}

interface SNSEvent {
  Records: SNSEventRecord[];
}

// ── CloudWatch Alarm message interface ─────────────────────────────────

export interface CloudWatchAlarmMessage {
  AlarmName: string;
  AlarmDescription: string;
  AWSAccountId?: string;
  NewStateValue: string;
  NewStateReason: string;
  StateChangeTime: string;
  Region?: string;
  AlarmArn?: string;
  OldStateValue?: string;
  Trigger: {
    MetricName: string;
    Namespace: string;
    StatisticType?: string;
    Dimensions: Array<{ name: string; value: string }>;
    Period?: number;
    EvaluationPeriods?: number;
    ComparisonOperator?: string;
    Threshold?: number;
  };
}

// ── Webhook alarm details (internal) ───────────────────────────────────

export interface WebhookAlarmDetails {
  alarmName: string;
  alarmDescription: string;
  newStateValue: string;
  newStateReason: string;
  stateChangeTime: string;
  checkType: string;
}

// ── DevOps Agent payload interface ─────────────────────────────────────

export interface DevOpsAgentPayload {
  eventType: string;
  incidentId: string;
  action: string;
  priority: string;
  title: string;
  description: string;
  timestamp: string;
  service: string;
  data: {
    metadata: {
      alarmName: string;
      newStateValue: string;
      newStateReason: string;
      checkType: string;
    };
  };
}

// ── DynamoDB client (lazy init) ────────────────────────────────────────

const ddbClient = new DynamoDBClient({});

// ── Dashboard event helper ─────────────────────────────────────────────

/**
 * Writes an event to the Dashboard DynamoDB events table.
 * Silently fails if EVENTS_TABLE_NAME is not set (dashboard not deployed).
 */
async function writeDashboardEvent(
  sessionId: string,
  eventType: string,
  data: Record<string, unknown>,
): Promise<void> {
  const tableName = process.env.EVENTS_TABLE_NAME;
  if (!tableName) return; // Dashboard not deployed, skip

  const timestamp = new Date().toISOString();
  const ttl = Math.floor(Date.now() / 1000) + 86400; // 24h

  try {
    await ddbClient.send(
      new PutItemCommand({
        TableName: tableName,
        Item: {
          sessionId: { S: sessionId },
          timestamp: { S: timestamp },
          eventType: { S: eventType },
          data: { S: JSON.stringify(data) },
          ttl: { N: String(ttl) },
        },
      }),
    );
  } catch (err) {
    console.warn('Failed to write dashboard event (non-fatal):', err);
  }
}

// ── Pure functions (exported for testing) ──────────────────────────────

/**
 * Validates that a parsed message has the required fields for webhook relay.
 */
export function validateAlarmMessage(
  message: unknown,
): message is CloudWatchAlarmMessage {
  return (
    typeof message === 'object' &&
    message !== null &&
    typeof (message as CloudWatchAlarmMessage).AlarmName === 'string' &&
    (message as CloudWatchAlarmMessage).AlarmName.length > 0
  );
}

/**
 * Extracts CheckType dimension from alarm dimensions.
 */
function extractCheckType(message: CloudWatchAlarmMessage): string {
  const dimensions = message.Trigger?.Dimensions ?? [];
  const checkTypeDim = dimensions.find((d) => d.name === 'CheckType');
  return checkTypeDim?.value ?? '';
}

/**
 * Extracts alarm details from a validated CloudWatch alarm message.
 */
export function extractAlarmDetails(
  message: CloudWatchAlarmMessage,
): WebhookAlarmDetails {
  return {
    alarmName: message.AlarmName,
    alarmDescription: message.AlarmDescription ?? '',
    newStateValue: message.NewStateValue ?? '',
    newStateReason: message.NewStateReason ?? '',
    stateChangeTime: message.StateChangeTime ?? '',
    checkType: extractCheckType(message),
  };
}

/**
 * Formats alarm details as a DevOps Agent webhook payload.
 */
export function formatWebhookPayload(
  alarm: WebhookAlarmDetails,
): DevOpsAgentPayload {
  return {
    eventType: 'incident',
    incidentId: `alarm-${alarm.alarmName}-${Date.now()}`,
    action: 'created',
    priority: 'HIGH',
    title: alarm.alarmName,
    description: alarm.alarmDescription,
    timestamp: alarm.stateChangeTime || new Date().toISOString(),
    service: 'Amazon VPC Networking',
    data: {
      metadata: {
        alarmName: alarm.alarmName,
        newStateValue: alarm.newStateValue,
        newStateReason: alarm.newStateReason,
        checkType: alarm.checkType,
      },
    },
  };
}

/**
 * Computes HMAC-SHA256 signature over `{timestamp}:{payloadJson}`.
 * Returns base64-encoded signature (matching DevOps Agent expected format).
 */
export function computeHmacSignature(
  secret: string,
  timestamp: string,
  payloadJson: string,
): string {
  const signatureString = `${timestamp}:${payloadJson}`;
  return crypto
    .createHmac('sha256', secret)
    .update(signatureString)
    .digest('base64');
}

// ── Lambda handler ─────────────────────────────────────────────────────

/**
 * Lambda entry point. Orchestrates parsing, validation, extraction,
 * HMAC signing, and HTTP POST for each SNS record.
 */
export const handler = async (event: SNSEvent): Promise<void> => {
  const creds = await getWebhookCredentials();

  if (!creds) {
    console.warn('Webhook credentials not configured in Secrets Manager — skipping webhook delivery');
    return;
  }

  const { webhookUrl, hmacSecret } = creds;

  for (const record of event.Records) {
    // Parse the SNS message as a CloudWatch alarm payload
    let message: unknown;
    try {
      message = JSON.parse(record.Sns.Message);
    } catch (err) {
      console.error('Failed to parse SNS message as JSON:', err);
      continue; // skip malformed record
    }

    // Validate required fields
    if (!validateAlarmMessage(message)) {
      console.error(
        'Missing required fields in alarm notification:',
        JSON.stringify(message),
      );
      continue; // skip invalid record
    }

    // Extract alarm details and format as DevOps Agent payload
    const alarmDetails = extractAlarmDetails(message);
    const payload = formatWebhookPayload(alarmDetails);
    const payloadJson = JSON.stringify(payload);

    // Compute HMAC-SHA256 signature
    const timestamp = new Date().toISOString();
    const signature = computeHmacSignature(hmacSecret, timestamp, payloadJson);

    console.log('Sending webhook payload for alarm:', payload.title);

    // POST to DevOps Agent webhook with HMAC auth headers
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-amzn-event-timestamp': timestamp,
        'x-amzn-event-signature': signature,
      },
      body: payloadJson,
    });

    const responseBody = await response
      .text()
      .catch(() => '(unable to read body)');
    console.log(
      `Webhook response: ${response.status} ${response.statusText}`,
      { responseBody },
    );

    if (!response.ok) {
      console.error(
        `Webhook POST failed: ${response.status} ${response.statusText}`,
      );
      throw new Error(`Webhook POST failed with status ${response.status}`);
    }

    // Write webhook_sent event to Dashboard (Requirement 5.6)
    await writeDashboardEvent(await getActiveSessionId() || payload.incidentId, 'webhook_sent', {
      incidentId: payload.incidentId,
      title: payload.title,
      description: payload.description,
      webhookUrl,
      checkType: alarmDetails.checkType,
    });

    console.log(
      `Successfully relayed alarm "${payload.title}" to webhook with HMAC auth`,
    );
  }
};
