import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { NetworkStack } from '../lib/network-stack';
import { ComputeStack } from '../lib/compute-stack';

describe('ComputeStack', () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const env = { account: '123456789012', region: 'us-east-1' };

    const networkStack = new NetworkStack(app, 'TestNetworkStack', { env });
    const computeStack = new ComputeStack(app, 'TestComputeStack', {
      env,
      vpc: networkStack.vpc,
      publicSubnets: networkStack.publicSubnets,
      privateSubnets: networkStack.privateSubnets,
      privateRouteTableId: networkStack.privateRouteTableId,
      natGatewayId: networkStack.natGatewayId,
      s3EndpointId: networkStack.s3EndpointId,
      bedrockEndpointId: networkStack.bedrockEndpointId,
      bedrockEndpointSubnetIds: networkStack.bedrockEndpointSubnetIds,
      vpcFlowLogBucket: networkStack.vpcFlowLogBucket,
    });

    template = Template.fromStack(computeStack);
  });

  // ---------------------------------------------------------------------------
  // Requirement 2.1: ALB is internet-facing in public subnets
  // ---------------------------------------------------------------------------
  describe('Application Load Balancer', () => {
    test('ALB is internet-facing', () => {
      template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
        Scheme: 'internet-facing',
        Type: 'application',
      });
    });

    test('HTTP listener exists on port 80', () => {
      template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
        Port: 80,
        Protocol: 'HTTP',
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Requirement 1.5: RDS security group allows inbound 3306 from EC2 SG
  // ---------------------------------------------------------------------------
  describe('RDS Security Group', () => {
    test('RDS security group has inbound rule on port 3306 from EC2 SG', () => {
      template.hasResourceProperties('AWS::EC2::SecurityGroup', {
        GroupDescription: 'Security group for the RDS MySQL instance',
        SecurityGroupEgress: [
          {
            CidrIp: '255.255.255.255/32',
            Description: 'Disallow all traffic',
            FromPort: 252,
            IpProtocol: 'icmp',
            ToPort: 86,
          },
        ],
      });

      // Verify the ingress rule exists as a separate resource (CDK creates these
      // as AWS::EC2::SecurityGroupIngress when referencing another SG)
      template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
        IpProtocol: 'tcp',
        FromPort: 3306,
        ToPort: 3306,
        Description: 'Allow MySQL from EC2 instance',
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Requirement 3.8: EC2 instance has SSM managed policy attached
  // ---------------------------------------------------------------------------
  describe('EC2 Instance IAM', () => {
    test('EC2 IAM role has AmazonSSMManagedInstanceCore managed policy', () => {
      template.hasResourceProperties('AWS::IAM::Role', {
        ManagedPolicyArns: Match.arrayWith([
          {
            'Fn::Join': Match.arrayWith([
              Match.arrayWith([
                Match.stringLikeRegexp('arn:'),
                Match.stringLikeRegexp(':iam::aws:policy/AmazonSSMManagedInstanceCore'),
              ]),
            ]),
          },
        ]),
      });
    });

    test('EC2 instance has an instance profile', () => {
      template.resourceCountIs('AWS::IAM::InstanceProfile', 1);
    });
  });

  // ---------------------------------------------------------------------------
  // Requirement 2.2, 2.4: ELB Access Log bucket has encryption and lifecycle
  // ---------------------------------------------------------------------------
  describe('ELB Access Log S3 Bucket', () => {
    test('ELB Access Log bucket has SSE-S3 encryption and 30-day lifecycle', () => {
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

  // ---------------------------------------------------------------------------
  // EC2 instance type and configuration
  // ---------------------------------------------------------------------------
  describe('EC2 Instance', () => {
    test('EC2 instance type is t3.medium', () => {
      template.hasResourceProperties('AWS::EC2::Instance', {
        InstanceType: 't3.medium',
      });
    });
  });

  // ---------------------------------------------------------------------------
  // RDS instance configuration
  // ---------------------------------------------------------------------------
  describe('RDS Instance', () => {
    test('RDS instance is MySQL 8.0 with db.t3.micro', () => {
      template.hasResourceProperties('AWS::RDS::DBInstance', {
        DBInstanceClass: 'db.t3.micro',
        Engine: 'mysql',
        EngineVersion: '8.0',
      });
    });
  });
});
