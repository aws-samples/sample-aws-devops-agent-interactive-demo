/**
 * Dashboard Events Lambda — GET /events
 *
 * Queries DynamoDB Events_Table by sessionId, returns events in chronological order.
 *
 * Requirements: 16.4
 */

import { DynamoDBClient, QueryCommand } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';

const ddb = new DynamoDBClient({});
const TABLE_NAME = process.env.EVENTS_TABLE_NAME!;

interface APIGatewayEvent {
  queryStringParameters?: Record<string, string> | null;
  headers?: Record<string, string>;
}

const corsHeaders = {
  'Access-Control-Allow-Origin': process.env.ALLOWED_ORIGIN!,
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
};

export const handler = async (event: APIGatewayEvent) => {
  const sessionId = event.queryStringParameters?.sessionId;

  if (!sessionId) {
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({ events: [], message: 'Provide ?sessionId= to query events' }),
    };
  }

  try {
    const result = await ddb.send(new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'sessionId = :sid',
      ExpressionAttributeValues: {
        ':sid': { S: sessionId },
      },
      ScanIndexForward: true, // ascending by timestamp (chronological)
    }));

    const events = (result.Items || []).map((item) => unmarshall(item));

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({ events }),
    };
  } catch (err) {
    console.error('Failed to query events:', err);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Failed to query events' }),
    };
  }
};
