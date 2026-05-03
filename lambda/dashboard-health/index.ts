/**
 * Dashboard Health Lambda — GET /health
 *
 * Reads ACTIVE_SCENARIO record from Events_Table (PK=SYSTEM, SK=ACTIVE_SCENARIO).
 * Returns status of all 6 scenarios based on active scenario state.
 *
 * Requirements: 16.1, 8.1
 */

import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';

const ddb = new DynamoDBClient({});
const TABLE_NAME = process.env.EVENTS_TABLE_NAME!;

const SCENARIOS = [
  { id: 1, name: 'Security Group Rule', description: 'RDS security group ingress rule (port 3306)' },
  { id: 2, name: 'NAT Gateway Route', description: 'Private subnet default route to NAT Gateway' },
  { id: 3, name: 'VPC Endpoint Policy', description: 'S3 Gateway Endpoint access policy' },
  { id: 4, name: 'Bedrock Endpoint Subnets', description: 'Bedrock Interface Endpoint subnet associations' },
  { id: 5, name: 'ALB TLS Policy', description: 'ALB HTTPS listener TLS security policy' },
  { id: 6, name: 'iptables + PCAP', description: 'Outbound HTTPS blocked via iptables with tcpdump capture' },
];

const corsHeaders = {
  'Access-Control-Allow-Origin': process.env.ALLOWED_ORIGIN!,
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
};

export const handler = async () => {
  try {
    // Read ACTIVE_SCENARIO record
    const result = await ddb.send(new GetItemCommand({
      TableName: TABLE_NAME,
      Key: {
        sessionId: { S: 'SYSTEM' },
        timestamp: { S: 'ACTIVE_SCENARIO' },
      },
    }));

    const activeItem = result.Item;
    const activeScenarioId = activeItem?.scenarioId?.N
      ? parseInt(activeItem.scenarioId.N, 10)
      : null;
    const activeSessionId = activeItem?.activeSessionId?.S || null;
    const startedAt = activeItem?.startedAt?.S || null;

    const scenarios = SCENARIOS.map((s) => {
      let status = 'healthy';
      if (activeScenarioId === s.id) {
        status = 'broken';
      }
      return {
        ...s,
        status,
      };
    });

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        scenarios,
        activeScenario: activeScenarioId
          ? {
              scenarioId: activeScenarioId,
              sessionId: activeSessionId,
              startedAt,
            }
          : null,
      }),
    };
  } catch (err) {
    console.error('Failed to check health:', err);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Failed to check scenario health' }),
    };
  }
};
