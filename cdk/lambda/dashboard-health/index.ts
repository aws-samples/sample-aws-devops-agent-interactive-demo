/**
 * Dashboard Health Lambda — GET /health
 *
 * Source of truth for scenario status is the REAL CloudWatch alarm state
 * (alarm-1 .. alarm-6, one per scenario). This Lambda also advances a small
 * transition state machine stored in the ACTIVE_SCENARIO record so the UI can
 * show "breaking"/"fixing" (grayed) until the alarm actually catches up — and
 * so a MANUAL fix (alarm clears without clicking Fix) is detected and the UI
 * returns to healthy on its own.
 *
 * Per-scenario status returned: healthy | breaking | broken | fixing
 *
 * Phase state machine (stored on SYSTEM/ACTIVE_SCENARIO):
 *   (break clicked)  -> breaking --(alarm=ALARM)--> broken
 *   (fix clicked)    -> fixing   --(alarm=OK)-----> [record deleted] healthy
 *   broken           --(alarm=OK, manual fix)-----> [record deleted] healthy
 * Timeouts prevent the UI from being stuck "grayed" if an alarm never moves.
 */

import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  DeleteItemCommand,
} from '@aws-sdk/client-dynamodb';
import { CloudWatchClient, DescribeAlarmsCommand } from '@aws-sdk/client-cloudwatch';

const ddb = new DynamoDBClient({});
const cw = new CloudWatchClient({});
const TABLE_NAME = process.env.EVENTS_TABLE_NAME!;
const ALARM_PREFIX = process.env.ALARM_PREFIX || 'alarm-';

// How long to wait for an alarm to catch up before giving up on a transition
// (alarm period is 60s / 1 eval period, so it normally moves within ~1-2 min).
const BREAKING_TIMEOUT_MS = 5 * 60 * 1000;
const FIXING_TIMEOUT_MS = 5 * 60 * 1000;

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

const ACTIVE_KEY = { sessionId: { S: 'SYSTEM' }, timestamp: { S: 'ACTIVE_SCENARIO' } };

/** Map alarm-<id> -> StateValue ('OK' | 'ALARM' | 'INSUFFICIENT_DATA'). */
async function getAlarmStates(): Promise<Record<number, string>> {
  const names = SCENARIOS.map((s) => `${ALARM_PREFIX}${s.id}`);
  const states: Record<number, string> = {};
  const resp = await cw.send(new DescribeAlarmsCommand({ AlarmNames: names }));
  for (const a of resp.MetricAlarms || []) {
    const m = (a.AlarmName || '').match(/(\d+)$/);
    if (m) states[parseInt(m[1], 10)] = a.StateValue || 'INSUFFICIENT_DATA';
  }
  return states;
}

async function clearActive(): Promise<void> {
  await ddb.send(new DeleteItemCommand({ TableName: TABLE_NAME, Key: ACTIVE_KEY }));
}

async function setPhase(item: Record<string, any>, phase: string): Promise<void> {
  await ddb.send(new PutItemCommand({
    TableName: TABLE_NAME,
    Item: { ...item, phase: { S: phase }, phaseStartedAt: { S: new Date().toISOString() } },
  }));
}

export const handler = async () => {
  try {
    const [alarmStates, activeResult] = await Promise.all([
      getAlarmStates().catch((e) => {
        console.error('DescribeAlarms failed:', e);
        return {} as Record<number, string>;
      }),
      ddb.send(new GetItemCommand({ TableName: TABLE_NAME, Key: ACTIVE_KEY })),
    ]);

    const active = activeResult.Item || null;
    const activeId = active?.scenarioId?.N ? parseInt(active.scenarioId.N, 10) : null;
    const activeSessionId = active?.activeSessionId?.S || null;
    let phase = active?.phase?.S || (activeId ? 'broken' : null);
    const phaseStartedAt = active?.phaseStartedAt?.S || active?.startedAt?.S || null;
    const phaseAgeMs = phaseStartedAt ? Date.now() - new Date(phaseStartedAt).getTime() : 0;

    const isAlarming = (id: number) => alarmStates[id] === 'ALARM';

    // Per-scenario base status purely from the live alarm state.
    const statusById: Record<number, string> = {};
    for (const s of SCENARIOS) statusById[s.id] = isAlarming(s.id) ? 'broken' : 'healthy';

    // Advance the transition state machine for the active scenario.
    let effectiveActiveId = activeId;
    let effectivePhase = phase;
    if (activeId) {
      const alarming = isAlarming(activeId);
      if (phase === 'breaking') {
        if (alarming) {
          await setPhase(active!, 'broken');
          statusById[activeId] = 'broken';
          effectivePhase = 'broken';
        } else if (phaseAgeMs > BREAKING_TIMEOUT_MS) {
          // Break never produced an alarm — release the lock, fall back to live state.
          await clearActive();
          effectiveActiveId = null;
          effectivePhase = null;
        } else {
          statusById[activeId] = 'breaking';
        }
      } else if (phase === 'fixing') {
        if (!alarming) {
          // Fix completed (alarm cleared) — release the lock.
          await clearActive();
          statusById[activeId] = 'healthy';
          effectiveActiveId = null;
          effectivePhase = null;
        } else if (phaseAgeMs > FIXING_TIMEOUT_MS) {
          // Fix didn't clear the alarm in time — revert to broken so the user can retry.
          await setPhase(active!, 'broken');
          statusById[activeId] = 'broken';
          effectivePhase = 'broken';
        } else {
          statusById[activeId] = 'fixing';
        }
      } else {
        // phase === 'broken'
        if (!alarming) {
          // Manual fix detected (alarm cleared without the Fix button) — release lock.
          await clearActive();
          statusById[activeId] = 'healthy';
          effectiveActiveId = null;
          effectivePhase = null;
        } else {
          statusById[activeId] = 'broken';
        }
      }
    }

    const scenarios = SCENARIOS.map((s) => ({ ...s, status: statusById[s.id] }));

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        scenarios,
        activeScenario: effectiveActiveId
          ? { scenarioId: effectiveActiveId, sessionId: activeSessionId, phase: effectivePhase }
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
