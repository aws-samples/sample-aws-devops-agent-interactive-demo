/**
 * Dashboard EventBridge Lambda
 *
 * Processes EventBridge events from aws.aidevops source.
 * Maps investigation lifecycle events to DynamoDB entries.
 *
 * Requirements: 17.2, 17.3, 17.4
 */

import { DynamoDBClient, PutItemCommand, GetItemCommand } from '@aws-sdk/client-dynamodb';

const ddb = new DynamoDBClient({});
const TABLE_NAME = process.env.EVENTS_TABLE_NAME!;

/** Look up the active dashboard session ID from the SYSTEM/ACTIVE_SCENARIO record */
async function getActiveSessionId(): Promise<string | null> {
  try {
    const result = await ddb.send(new GetItemCommand({
      TableName: TABLE_NAME,
      Key: { sessionId: { S: 'SYSTEM' }, timestamp: { S: 'ACTIVE_SCENARIO' } },
    }));
    return result.Item?.activeSessionId?.S || null;
  } catch (err) {
    console.warn('Failed to look up active session:', err);
    return null;
  }
}

interface EventBridgeEvent {
  'detail-type': string;
  source: string;
  detail: Record<string, any>;
  time: string;
  id: string;
}

async function writeEvent(
  sessionId: string,
  timestamp: string,
  eventType: string,
  data: Record<string, any>,
  ttl: number,
): Promise<void> {
  await ddb.send(new PutItemCommand({
    TableName: TABLE_NAME,
    Item: {
      sessionId: { S: sessionId },
      timestamp: { S: timestamp },
      eventType: { S: eventType },
      data: { S: JSON.stringify(data) },
      ttl: { N: String(ttl) },
    },
  }));
}

async function getInvestigationFindings(summaryRecordId: string): Promise<{ investigationSummaryMd: string }> {
  // The @aws-sdk/client-aidevops package may not be published yet.
  // Use a dynamic require wrapped in try/catch to handle gracefully at runtime.
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('@aws-sdk/client-aidevops') as any;
    const client = new mod.AIDevOpsClient({});
    const result = await client.send(new mod.GetInvestigationSummaryCommand({ summaryRecordId }));
    return { investigationSummaryMd: result.summary ?? 'No summary available' };
  } catch (importErr) {
    console.warn('AIDevOps SDK client not available, skipping findings retrieval:', importErr);
    return { investigationSummaryMd: 'Findings retrieval not available — SDK client not yet published.' };
  }
}

export const handler = async (event: EventBridgeEvent): Promise<void> => {
  const detailType = event['detail-type'];
  const detail = event.detail;
  const sessionId = await getActiveSessionId() || detail.investigationId || detail.incidentId || `event-${event.id}`;
  const timestamp = new Date().toISOString();
  const ttl = Math.floor(Date.now() / 1000) + 86400; // 24h TTL

  console.log(`Processing EventBridge event: ${detailType}`, JSON.stringify(detail));

  switch (detailType) {
    case 'Investigation Created':
      await writeEvent(sessionId, timestamp, 'investigation_created', {
        investigationId: detail.investigationId,
        message: 'DevOps Agent investigation started',
      }, ttl);
      break;

    case 'Investigation In Progress':
      await writeEvent(sessionId, timestamp, 'investigation_in_progress', {
        investigationId: detail.investigationId,
        progress: detail.progress,
        message: 'DevOps Agent investigation in progress',
      }, ttl);
      break;

    case 'Investigation Completed':
      await writeEvent(sessionId, timestamp, 'investigation_completed', {
        investigationId: detail.investigationId,
        message: 'DevOps Agent investigation completed',
      }, ttl);

      // Try to retrieve findings
      if (detail.summaryRecordId) {
        try {
          const findings = await getInvestigationFindings(detail.summaryRecordId);
          await writeEvent(sessionId, new Date().toISOString(), 'findings_retrieved', {
            investigationId: detail.investigationId,
            findings: findings.investigationSummaryMd,
          }, ttl);
        } catch (err) {
          console.error('Failed to retrieve investigation findings:', err);
        }
      }
      break;

    case 'Investigation Failed':
      await writeEvent(sessionId, timestamp, 'investigation_failed', {
        investigationId: detail.investigationId,
        error: detail.error || 'Unknown error',
        message: 'DevOps Agent investigation failed',
      }, ttl);
      break;

    default:
      // Only capture meaningful investigation events, skip noisy CloudTrail API calls
      const skipEvents = ['AWS API Call via CloudTrail', 'AWS Console Sign In via CloudTrail'];
      if (skipEvents.includes(detailType)) {
        console.log(`Skipping noisy event: ${detailType}`);
        return;
      }
      // Capture other DevOps Agent events (Investigation Linked, Mitigation, etc.)
      await writeEvent(sessionId, timestamp, `devops_agent_${detailType.toLowerCase().replace(/\s+/g, '_')}`, {
        message: detailType,
      }, ttl);
      break;
  }
};
