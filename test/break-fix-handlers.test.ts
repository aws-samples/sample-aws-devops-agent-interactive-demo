/**
 * Unit tests for Break/Fix Lambda handlers
 *
 * Validates: Requirements 8.1, 8.2, 8.3, 8.4, 9.1, 10.1, 11.1, 12.1, 13.1, 14.1
 *
 * Strategy: Mock all AWS SDK v3 clients (DynamoDB, EC2, ELBv2, SSM) at the
 * module level so the handlers never make real AWS calls. Then invoke the
 * exported handler functions with simulated API Gateway events.
 */

// ---------------------------------------------------------------------------
// Mock setup — must be before any imports that use the SDK
// ---------------------------------------------------------------------------

const mockDdbSend = jest.fn();
jest.mock('@aws-sdk/client-dynamodb', () => {
  return {
    DynamoDBClient: jest.fn().mockImplementation(() => ({ send: mockDdbSend })),
    PutItemCommand: jest.fn().mockImplementation((input: any) => ({ _type: 'PutItem', input })),
    GetItemCommand: jest.fn().mockImplementation((input: any) => ({ _type: 'GetItem', input })),
    DeleteItemCommand: jest.fn().mockImplementation((input: any) => ({ _type: 'DeleteItem', input })),
  };
});

const mockEc2Send = jest.fn();
jest.mock('@aws-sdk/client-ec2', () => {
  return {
    EC2Client: jest.fn().mockImplementation(() => ({ send: mockEc2Send })),
    RevokeSecurityGroupIngressCommand: jest.fn().mockImplementation((input: any) => ({ _type: 'RevokeSecurityGroupIngress', input })),
    DeleteRouteCommand: jest.fn().mockImplementation((input: any) => ({ _type: 'DeleteRoute', input })),
    ModifyVpcEndpointCommand: jest.fn().mockImplementation((input: any) => ({ _type: 'ModifyVpcEndpoint', input })),
    AuthorizeSecurityGroupIngressCommand: jest.fn().mockImplementation((input: any) => ({ _type: 'AuthorizeSecurityGroupIngress', input })),
    CreateRouteCommand: jest.fn().mockImplementation((input: any) => ({ _type: 'CreateRoute', input })),
  };
});

const mockElbv2Send = jest.fn();
jest.mock('@aws-sdk/client-elastic-load-balancing-v2', () => {
  return {
    ElasticLoadBalancingV2Client: jest.fn().mockImplementation(() => ({ send: mockElbv2Send })),
    ModifyListenerCommand: jest.fn().mockImplementation((input: any) => ({ _type: 'ModifyListener', input })),
  };
});

const mockSsmSend = jest.fn();
jest.mock('@aws-sdk/client-ssm', () => {
  return {
    SSMClient: jest.fn().mockImplementation(() => ({ send: mockSsmSend })),
    SendCommandCommand: jest.fn().mockImplementation((input: any) => ({ _type: 'SendCommand', input })),
  };
});

// Mock crypto.randomUUID for deterministic session IDs in break handler
jest.mock('crypto', () => ({
  ...jest.requireActual('crypto'),
  randomUUID: jest.fn(() => 'test-session-uuid'),
}));

// ---------------------------------------------------------------------------
// Set environment variables before importing handlers
// ---------------------------------------------------------------------------
process.env.EVENTS_TABLE_NAME = 'TestEventsTable';
process.env.RDS_SECURITY_GROUP_ID = 'sg-rds-test';
process.env.EC2_SECURITY_GROUP_ID = 'sg-ec2-test';
process.env.PRIVATE_ROUTE_TABLE_ID = 'rtb-private-test';
process.env.NAT_GATEWAY_ID = 'nat-gw-test';
process.env.S3_ENDPOINT_ID = 'vpce-s3-test';
process.env.BEDROCK_ENDPOINT_ID = 'vpce-bedrock-test';
process.env.BEDROCK_ENDPOINT_SUBNET_IDS = 'subnet-a,subnet-b';
process.env.ALB_LISTENER_ARN = 'arn:aws:elasticloadbalancing:us-east-1:123456789012:listener/app/test/1234';
process.env.EC2_INSTANCE_ID = 'i-test-instance';
process.env.PCAP_STORAGE_BUCKET_ARN = 'arn:aws:s3:::pcap-test-bucket';

// ---------------------------------------------------------------------------
// Import handlers after mocks are in place
// ---------------------------------------------------------------------------
import { handler as breakHandler } from '../lambda/dashboard-break/index';
import { handler as fixHandler } from '../lambda/dashboard-fix/index';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function apiEvent(body: Record<string, any>) {
  return { body: JSON.stringify(body) };
}

function parseBody(result: any): any {
  return JSON.parse(result.body);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Break Lambda Handler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default: DynamoDB GetItem returns no item (no active scenario)
    mockDdbSend.mockResolvedValue({});
    // Default: all AWS SDK calls succeed
    mockEc2Send.mockResolvedValue({});
    mockElbv2Send.mockResolvedValue({});
    mockSsmSend.mockResolvedValue({});
  });

  // =========================================================================
  // Requirement 8.1: Mutual exclusion — 409 when active scenario exists
  // =========================================================================
  test('returns 409 when an active scenario already exists', async () => {
    mockDdbSend.mockImplementation((cmd: any) => {
      if (cmd._type === 'GetItem') {
        return Promise.resolve({
          Item: {
            sessionId: { S: 'SYSTEM' },
            timestamp: { S: 'ACTIVE_SCENARIO' },
            scenarioId: { N: '2' },
            activeSessionId: { S: 'existing-session-id' },
          },
        });
      }
      return Promise.resolve({});
    });

    const result = await breakHandler(apiEvent({ scenarioId: 1 }));

    expect(result.statusCode).toBe(409);
    const body = parseBody(result);
    expect(body.error).toMatch(/already active/i);
    expect(body.activeScenarioId).toBe('2');
  });

  // =========================================================================
  // Requirement 8.2: Invalid scenarioId returns 400
  // =========================================================================
  test('returns 400 for missing scenarioId', async () => {
    const result = await breakHandler(apiEvent({}));
    expect(result.statusCode).toBe(400);
    expect(parseBody(result).error).toMatch(/scenarioId/);
  });

  test('returns 400 for scenarioId out of range (0)', async () => {
    const result = await breakHandler(apiEvent({ scenarioId: 0 }));
    expect(result.statusCode).toBe(400);
  });

  test('returns 400 for scenarioId out of range (7)', async () => {
    const result = await breakHandler(apiEvent({ scenarioId: 7 }));
    expect(result.statusCode).toBe(400);
  });

  // =========================================================================
  // Requirement 8.1: Creates ACTIVE_SCENARIO record
  // =========================================================================
  test('creates ACTIVE_SCENARIO record and returns sessionId on success', async () => {
    const result = await breakHandler(apiEvent({ scenarioId: 1 }));

    expect(result.statusCode).toBe(200);
    const body = parseBody(result);
    expect(body.sessionId).toBe('test-session-uuid');
    expect(body.scenarioId).toBe(1);

    // Verify DynamoDB PutItem was called with ACTIVE_SCENARIO record
    const putCalls = mockDdbSend.mock.calls.filter(
      (call: any[]) => call[0]._type === 'PutItem',
    );
    expect(putCalls.length).toBeGreaterThanOrEqual(1);

    const activeScenarioPut = putCalls.find(
      (call: any[]) => call[0].input?.Item?.timestamp?.S === 'ACTIVE_SCENARIO',
    );
    expect(activeScenarioPut).toBeDefined();
    expect(activeScenarioPut![0].input.Item.scenarioId.N).toBe('1');
    expect(activeScenarioPut![0].input.Item.activeSessionId.S).toBe('test-session-uuid');
    expect(activeScenarioPut![0].input.ConditionExpression).toBe('attribute_not_exists(sessionId)');
  });

  // =========================================================================
  // Requirement 8.1: ConditionalCheckFailedException returns 409
  // =========================================================================
  test('returns 409 on ConditionalCheckFailedException (concurrent break)', async () => {
    mockDdbSend.mockImplementation((cmd: any) => {
      if (cmd._type === 'GetItem') {
        return Promise.resolve({}); // No active scenario initially
      }
      if (cmd._type === 'PutItem' && cmd.input?.Item?.timestamp?.S === 'ACTIVE_SCENARIO') {
        const err = new Error('Conditional check failed');
        err.name = 'ConditionalCheckFailedException';
        return Promise.reject(err);
      }
      return Promise.resolve({});
    });

    const result = await breakHandler(apiEvent({ scenarioId: 1 }));
    expect(result.statusCode).toBe(409);
    expect(parseBody(result).error).toMatch(/concurrently/i);
  });

  // =========================================================================
  // Requirement 9.1: Scenario 1 dispatches RevokeSecurityGroupIngress
  // =========================================================================
  test('Scenario 1 calls RevokeSecurityGroupIngress with correct params', async () => {
    const result = await breakHandler(apiEvent({ scenarioId: 1 }));
    expect(result.statusCode).toBe(200);

    const ec2Calls = mockEc2Send.mock.calls;
    expect(ec2Calls.length).toBe(1);
    expect(ec2Calls[0][0]._type).toBe('RevokeSecurityGroupIngress');
    expect(ec2Calls[0][0].input.GroupId).toBe('sg-rds-test');
    expect(ec2Calls[0][0].input.IpPermissions[0].FromPort).toBe(3306);
    expect(ec2Calls[0][0].input.IpPermissions[0].ToPort).toBe(3306);
    expect(ec2Calls[0][0].input.IpPermissions[0].UserIdGroupPairs[0].GroupId).toBe('sg-ec2-test');
  });

  // =========================================================================
  // Requirement 10.1: Scenario 2 dispatches DeleteRoute
  // =========================================================================
  test('Scenario 2 calls DeleteRoute with correct params', async () => {
    const result = await breakHandler(apiEvent({ scenarioId: 2 }));
    expect(result.statusCode).toBe(200);

    const ec2Calls = mockEc2Send.mock.calls;
    expect(ec2Calls.length).toBe(1);
    expect(ec2Calls[0][0]._type).toBe('DeleteRoute');
    expect(ec2Calls[0][0].input.RouteTableId).toBe('rtb-private-test');
    expect(ec2Calls[0][0].input.DestinationCidrBlock).toBe('0.0.0.0/0');
  });

  // =========================================================================
  // Requirement 11.1: Scenario 3 dispatches ModifyVpcEndpoint with deny policy
  // =========================================================================
  test('Scenario 3 calls ModifyVpcEndpoint with deny policy', async () => {
    const result = await breakHandler(apiEvent({ scenarioId: 3 }));
    expect(result.statusCode).toBe(200);

    const ec2Calls = mockEc2Send.mock.calls;
    expect(ec2Calls.length).toBe(1);
    expect(ec2Calls[0][0]._type).toBe('ModifyVpcEndpoint');
    expect(ec2Calls[0][0].input.VpcEndpointId).toBe('vpce-s3-test');

    const policy = JSON.parse(ec2Calls[0][0].input.PolicyDocument);
    expect(policy.Statement[0].Effect).toBe('Deny');
  });

  // =========================================================================
  // Requirement 12.1: Scenario 4 dispatches ModifyVpcEndpoint removing subnets
  // =========================================================================
  test('Scenario 4 calls ModifyVpcEndpoint removing subnets', async () => {
    const result = await breakHandler(apiEvent({ scenarioId: 4 }));
    expect(result.statusCode).toBe(200);

    const ec2Calls = mockEc2Send.mock.calls;
    expect(ec2Calls.length).toBe(1);
    expect(ec2Calls[0][0]._type).toBe('ModifyVpcEndpoint');
    expect(ec2Calls[0][0].input.VpcEndpointId).toBe('vpce-bedrock-test');
    expect(ec2Calls[0][0].input.RemoveSubnetIds).toEqual(['subnet-a', 'subnet-b']);
  });

  // =========================================================================
  // Requirement 13.1: Scenario 5 dispatches ModifyListener with restrictive TLS
  // =========================================================================
  test('Scenario 5 calls ModifyListener with restrictive TLS policy', async () => {
    const result = await breakHandler(apiEvent({ scenarioId: 5 }));
    expect(result.statusCode).toBe(200);

    const elbCalls = mockElbv2Send.mock.calls;
    expect(elbCalls.length).toBe(1);
    expect(elbCalls[0][0]._type).toBe('ModifyListener');
    expect(elbCalls[0][0].input.ListenerArn).toBe(process.env.ALB_LISTENER_ARN);
    expect(elbCalls[0][0].input.SslPolicy).toBe('ELBSecurityPolicy-TLS13-1-2-2021-06');
  });

  // =========================================================================
  // Requirement 14.1: Scenario 6 dispatches two SSM SendCommand calls
  // =========================================================================
  test('Scenario 6 sends two SSM commands (iptables + tcpdump)', async () => {
    const result = await breakHandler(apiEvent({ scenarioId: 6 }));
    expect(result.statusCode).toBe(200);

    const ssmCalls = mockSsmSend.mock.calls;
    expect(ssmCalls.length).toBe(2);

    // First call: iptables block
    expect(ssmCalls[0][0]._type).toBe('SendCommand');
    expect(ssmCalls[0][0].input.InstanceIds).toEqual(['i-test-instance']);
    expect(ssmCalls[0][0].input.Parameters.commands[0]).toMatch(/iptables -A OUTPUT -p tcp --dport 443 -j DROP/);

    // Second call: tcpdump capture
    expect(ssmCalls[1][0]._type).toBe('SendCommand');
    expect(ssmCalls[1][0].input.InstanceIds).toEqual(['i-test-instance']);
    expect(ssmCalls[1][0].input.Parameters.commands[0]).toMatch(/tcpdump/);
    expect(ssmCalls[1][0].input.Parameters.commands[0]).toMatch(/s3 cp/);
  });

  // =========================================================================
  // CORS headers are present
  // =========================================================================
  test('response includes CORS headers', async () => {
    const result = await breakHandler(apiEvent({ scenarioId: 1 }));
    expect(result.headers['Access-Control-Allow-Origin']).toBe('*');
    expect(result.headers['Access-Control-Allow-Methods']).toMatch(/POST/);
  });
});

describe('Fix Lambda Handler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default: all AWS SDK calls succeed
    mockEc2Send.mockResolvedValue({});
    mockElbv2Send.mockResolvedValue({});
    mockSsmSend.mockResolvedValue({});
    mockDdbSend.mockResolvedValue({});
  });

  /** Helper: mock DynamoDB to return an active scenario */
  function mockActiveScenario(scenarioId: number, sessionId = 'active-session-123') {
    mockDdbSend.mockImplementation((cmd: any) => {
      if (cmd._type === 'GetItem') {
        return Promise.resolve({
          Item: {
            sessionId: { S: 'SYSTEM' },
            timestamp: { S: 'ACTIVE_SCENARIO' },
            scenarioId: { N: String(scenarioId) },
            activeSessionId: { S: sessionId },
          },
        });
      }
      return Promise.resolve({});
    });
  }

  // =========================================================================
  // Requirement 8.3: Fix returns 400 when no active scenario
  // =========================================================================
  test('returns 400 when no active scenario exists', async () => {
    mockDdbSend.mockResolvedValue({}); // GetItem returns no Item

    const result = await fixHandler(apiEvent({ scenarioId: 1 }));
    expect(result.statusCode).toBe(400);
    expect(parseBody(result).error).toMatch(/no active scenario/i);
  });

  // =========================================================================
  // Requirement 8.3: Fix returns 400 when scenarioId doesn't match
  // =========================================================================
  test('returns 400 when scenarioId does not match active scenario', async () => {
    mockActiveScenario(2); // Active scenario is 2

    const result = await fixHandler(apiEvent({ scenarioId: 1 })); // Trying to fix 1
    expect(result.statusCode).toBe(400);
    const body = parseBody(result);
    expect(body.error).toMatch(/Active scenario is 2/);
    expect(body.activeScenarioId).toBe(2);
  });

  // =========================================================================
  // Requirement 8.2: Invalid scenarioId returns 400
  // =========================================================================
  test('returns 400 for missing scenarioId', async () => {
    const result = await fixHandler(apiEvent({}));
    expect(result.statusCode).toBe(400);
    expect(parseBody(result).error).toMatch(/scenarioId/);
  });

  test('returns 400 for scenarioId out of range', async () => {
    const result = await fixHandler(apiEvent({ scenarioId: 0 }));
    expect(result.statusCode).toBe(400);
  });

  // =========================================================================
  // Requirement 8.4: Fix clears ACTIVE_SCENARIO record
  // =========================================================================
  test('deletes ACTIVE_SCENARIO record after successful fix', async () => {
    mockActiveScenario(1);

    const result = await fixHandler(apiEvent({ scenarioId: 1 }));
    expect(result.statusCode).toBe(200);

    // Verify DeleteItem was called for ACTIVE_SCENARIO
    const deleteCalls = mockDdbSend.mock.calls.filter(
      (call: any[]) => call[0]._type === 'DeleteItem',
    );
    expect(deleteCalls.length).toBe(1);
    expect(deleteCalls[0][0].input.Key.sessionId.S).toBe('SYSTEM');
    expect(deleteCalls[0][0].input.Key.timestamp.S).toBe('ACTIVE_SCENARIO');
  });

  // =========================================================================
  // Requirement 8.4: Fix writes scenario_fixed event
  // =========================================================================
  test('writes scenario_fixed event to Events_Table after fix', async () => {
    mockActiveScenario(1, 'session-abc');

    const result = await fixHandler(apiEvent({ scenarioId: 1 }));
    expect(result.statusCode).toBe(200);

    const putCalls = mockDdbSend.mock.calls.filter(
      (call: any[]) => call[0]._type === 'PutItem',
    );
    expect(putCalls.length).toBe(1);
    expect(putCalls[0][0].input.Item.sessionId.S).toBe('session-abc');
    expect(putCalls[0][0].input.Item.eventType.S).toBe('scenario_fixed');
  });

  // =========================================================================
  // Requirement 9.1 (fix): Scenario 1 dispatches AuthorizeSecurityGroupIngress
  // =========================================================================
  test('Scenario 1 fix calls AuthorizeSecurityGroupIngress', async () => {
    mockActiveScenario(1);

    const result = await fixHandler(apiEvent({ scenarioId: 1 }));
    expect(result.statusCode).toBe(200);

    const ec2Calls = mockEc2Send.mock.calls;
    expect(ec2Calls.length).toBe(1);
    expect(ec2Calls[0][0]._type).toBe('AuthorizeSecurityGroupIngress');
    expect(ec2Calls[0][0].input.GroupId).toBe('sg-rds-test');
    expect(ec2Calls[0][0].input.IpPermissions[0].FromPort).toBe(3306);
  });

  // =========================================================================
  // Requirement 10.1 (fix): Scenario 2 dispatches CreateRoute
  // =========================================================================
  test('Scenario 2 fix calls CreateRoute with NAT Gateway', async () => {
    mockActiveScenario(2);

    const result = await fixHandler(apiEvent({ scenarioId: 2 }));
    expect(result.statusCode).toBe(200);

    const ec2Calls = mockEc2Send.mock.calls;
    expect(ec2Calls.length).toBe(1);
    expect(ec2Calls[0][0]._type).toBe('CreateRoute');
    expect(ec2Calls[0][0].input.RouteTableId).toBe('rtb-private-test');
    expect(ec2Calls[0][0].input.DestinationCidrBlock).toBe('0.0.0.0/0');
    expect(ec2Calls[0][0].input.NatGatewayId).toBe('nat-gw-test');
  });

  // =========================================================================
  // Requirement 11.1 (fix): Scenario 3 dispatches ModifyVpcEndpoint with allow policy
  // =========================================================================
  test('Scenario 3 fix calls ModifyVpcEndpoint with allow-all policy', async () => {
    mockActiveScenario(3);

    const result = await fixHandler(apiEvent({ scenarioId: 3 }));
    expect(result.statusCode).toBe(200);

    const ec2Calls = mockEc2Send.mock.calls;
    expect(ec2Calls.length).toBe(1);
    expect(ec2Calls[0][0]._type).toBe('ModifyVpcEndpoint');
    expect(ec2Calls[0][0].input.VpcEndpointId).toBe('vpce-s3-test');

    const policy = JSON.parse(ec2Calls[0][0].input.PolicyDocument);
    expect(policy.Statement[0].Effect).toBe('Allow');
    expect(policy.Statement[0].Action).toBe('*');
  });

  // =========================================================================
  // Requirement 12.1 (fix): Scenario 4 dispatches ModifyVpcEndpoint adding subnets
  // =========================================================================
  test('Scenario 4 fix calls ModifyVpcEndpoint adding subnets', async () => {
    mockActiveScenario(4);

    const result = await fixHandler(apiEvent({ scenarioId: 4 }));
    expect(result.statusCode).toBe(200);

    const ec2Calls = mockEc2Send.mock.calls;
    expect(ec2Calls.length).toBe(1);
    expect(ec2Calls[0][0]._type).toBe('ModifyVpcEndpoint');
    expect(ec2Calls[0][0].input.VpcEndpointId).toBe('vpce-bedrock-test');
    expect(ec2Calls[0][0].input.AddSubnetIds).toEqual(['subnet-a', 'subnet-b']);
  });

  // =========================================================================
  // Requirement 13.1 (fix): Scenario 5 dispatches ModifyListener with permissive TLS
  // =========================================================================
  test('Scenario 5 fix calls ModifyListener with permissive TLS policy', async () => {
    mockActiveScenario(5);

    const result = await fixHandler(apiEvent({ scenarioId: 5 }));
    expect(result.statusCode).toBe(200);

    const elbCalls = mockElbv2Send.mock.calls;
    expect(elbCalls.length).toBe(1);
    expect(elbCalls[0][0]._type).toBe('ModifyListener');
    expect(elbCalls[0][0].input.ListenerArn).toBe(process.env.ALB_LISTENER_ARN);
    expect(elbCalls[0][0].input.SslPolicy).toBe('ELBSecurityPolicy-2016-08');
  });

  // =========================================================================
  // Requirement 14.1 (fix): Scenario 6 dispatches SSM SendCommand to remove iptables
  // =========================================================================
  test('Scenario 6 fix sends SSM command to remove iptables rule', async () => {
    mockActiveScenario(6);

    const result = await fixHandler(apiEvent({ scenarioId: 6 }));
    expect(result.statusCode).toBe(200);

    const ssmCalls = mockSsmSend.mock.calls;
    expect(ssmCalls.length).toBe(1);
    expect(ssmCalls[0][0]._type).toBe('SendCommand');
    expect(ssmCalls[0][0].input.InstanceIds).toEqual(['i-test-instance']);
    expect(ssmCalls[0][0].input.Parameters.commands[0]).toMatch(/iptables -D OUTPUT -p tcp --dport 443 -j DROP/);
  });

  // =========================================================================
  // CORS headers are present
  // =========================================================================
  test('response includes CORS headers', async () => {
    mockActiveScenario(1);
    const result = await fixHandler(apiEvent({ scenarioId: 1 }));
    expect(result.headers['Access-Control-Allow-Origin']).toBe('*');
    expect(result.headers['Access-Control-Allow-Methods']).toMatch(/POST/);
  });

  // =========================================================================
  // Fix returns sessionId in response
  // =========================================================================
  test('fix response includes sessionId from active scenario', async () => {
    mockActiveScenario(3, 'my-session-xyz');

    const result = await fixHandler(apiEvent({ scenarioId: 3 }));
    expect(result.statusCode).toBe(200);
    const body = parseBody(result);
    expect(body.sessionId).toBe('my-session-xyz');
    expect(body.scenarioId).toBe(3);
  });
});
