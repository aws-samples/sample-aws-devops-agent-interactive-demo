import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { NetworkStack } from '../lib/network-stack';

describe('NetworkStack', () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const stack = new NetworkStack(app, 'TestNetworkStack', {
      env: { account: '123456789012', region: 'us-east-1' },
    });
    template = Template.fromStack(stack);
  });

  // ---------------------------------------------------------------------------
  // Requirement 1.1: VPC with correct CIDR and subnet configuration
  // ---------------------------------------------------------------------------
  describe('VPC configuration', () => {
    test('VPC is created with CIDR 10.0.0.0/16', () => {
      template.hasResourceProperties('AWS::EC2::VPC', {
        CidrBlock: '10.0.0.0/16',
      });
    });

    test('at least 4 subnets are created (2 public, 2 private)', () => {
      template.resourceCountIs('AWS::EC2::Subnet', 4);
    });
  });

  // ---------------------------------------------------------------------------
  // Requirement 1.2: NAT Gateway and route in private route table
  // ---------------------------------------------------------------------------
  describe('NAT Gateway', () => {
    test('NAT Gateway resource exists', () => {
      template.resourceCountIs('AWS::EC2::NatGateway', 1);
    });

    test('route to 0.0.0.0/0 via NAT Gateway exists in a route table', () => {
      template.hasResourceProperties('AWS::EC2::Route', {
        DestinationCidrBlock: '0.0.0.0/0',
        NatGatewayId: Match.anyValue(),
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Requirement 1.3: S3 Gateway VPC Endpoint
  // ---------------------------------------------------------------------------
  describe('S3 Gateway VPC Endpoint', () => {
    test('S3 Gateway Endpoint exists', () => {
      template.hasResourceProperties('AWS::EC2::VPCEndpoint', {
        ServiceName: Match.objectLike({
          'Fn::Join': Match.arrayWith([
            Match.arrayWith([
              Match.stringLikeRegexp('com\\.amazonaws\\.'),
              Match.stringLikeRegexp('\\.s3'),
            ]),
          ]),
        }),
        VpcEndpointType: 'Gateway',
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Requirement 1.4: Bedrock Interface VPC Endpoint
  // ---------------------------------------------------------------------------
  describe('Bedrock Interface VPC Endpoint', () => {
    test('Bedrock Runtime Interface Endpoint exists', () => {
      template.hasResourceProperties('AWS::EC2::VPCEndpoint', {
        ServiceName: Match.objectLike({
          'Fn::Join': Match.arrayWith([
            Match.arrayWith([
              Match.stringLikeRegexp('com\\.amazonaws\\.'),
              Match.stringLikeRegexp('bedrock-runtime'),
            ]),
          ]),
        }),
        VpcEndpointType: 'Interface',
        PrivateDnsEnabled: true,
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Requirement 1.6: VPC Flow Logs configured to S3
  // ---------------------------------------------------------------------------
  describe('VPC Flow Logs', () => {
    test('VPC Flow Log resource exists with S3 destination', () => {
      template.hasResourceProperties('AWS::EC2::FlowLog', {
        LogDestinationType: 's3',
        TrafficType: 'ALL',
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Requirement 2.6: VPC Flow Log Bucket with encryption and lifecycle
  // ---------------------------------------------------------------------------
  describe('VPC Flow Log S3 Bucket', () => {
    test('Flow Log bucket has SSE-S3 encryption and 30-day lifecycle', () => {
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
        LifecycleConfiguration: {
          Rules: Match.arrayWith([
            Match.objectLike({
              ExpirationInDays: 30,
              Status: 'Enabled',
            }),
          ]),
        },
      });
    });
  });
});
