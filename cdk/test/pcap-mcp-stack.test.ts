import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { PcapMcpStack } from '../lib/pcap-mcp-stack';

describe('PcapMcpStack', () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();

    // Create SSM parameter for the test (simulates CodeBuild having written it)
    app.node.setContext('ssm:account=123456789012:parameterName=/pcap-mcp/mcp-endpoint-url:region=us-east-1', 'https://bedrock-agentcore.us-east-1.amazonaws.com/runtimes/test/invocations?qualifier=DEFAULT');

    const stack = new PcapMcpStack(app, 'TestPcapMcpStack', {
      env: { account: '123456789012', region: 'us-east-1' },
    });
    template = Template.fromStack(stack);
  });

  // ---------------------------------------------------------------------------
  // Requirement 6.1: PCAP Storage Bucket with encryption and lifecycle
  // ---------------------------------------------------------------------------
  describe('PCAP Storage Bucket', () => {
    test('bucket has SSE-S3 encryption enabled', () => {
      template.hasResourceProperties('AWS::S3::Bucket', {
        BucketEncryption: {
          ServerSideEncryptionConfiguration: [
            {
              ServerSideEncryptionByDefault: {
                SSEAlgorithm: 'AES256',
              },
            },
          ],
        },
      });
    });

    test('bucket has a 7-day lifecycle expiration rule', () => {
      template.hasResourceProperties('AWS::S3::Bucket', {
        LifecycleConfiguration: {
          Rules: Match.arrayWith([
            Match.objectLike({
              ExpirationInDays: 7,
              Status: 'Enabled',
            }),
          ]),
        },
      });
    });

    test('bucket blocks all public access', () => {
      template.hasResourceProperties('AWS::S3::Bucket', {
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        },
      });
    });
  });

  // ---------------------------------------------------------------------------
  // AgentCore execution role
  // ---------------------------------------------------------------------------
  describe('AgentCore Execution Role', () => {
    test('Runtime role has S3 access to PCAP bucket', () => {
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Sid: 'S3PcapAccess',
              Action: ['s3:GetObject', 's3:PutObject', 's3:ListBucket', 's3:DeleteObject'],
              Effect: 'Allow',
            }),
          ]),
        },
      });
    });

    test('Runtime role has ECR read managed policy', () => {
      template.hasResourceProperties('AWS::IAM::Role', {
        ManagedPolicyArns: Match.arrayWith([
          Match.objectLike({
            'Fn::Join': Match.anyValue(),
          }),
        ]),
      });
    });

    test('Runtime role has CloudWatch logging permissions', () => {
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Sid: 'AgentCoreLogging',
              Effect: 'Allow',
            }),
          ]),
        },
      });
    });
  });
});
