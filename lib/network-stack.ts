import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';

/**
 * NetworkStack — VPC, subnets, NAT Gateway, VPC endpoints, VPC Flow Logs.
 *
 * Exports consumed by ComputeStack, DashboardStack, and break/fix Lambdas.
 */
export class NetworkStack extends cdk.Stack {
  /** The demo VPC (10.0.0.0/16). */
  public readonly vpc: ec2.IVpc;
  /** Public subnets across 2 AZs. */
  public readonly publicSubnets: ec2.ISubnet[];
  /** Private subnets across 2 AZs. */
  public readonly privateSubnets: ec2.ISubnet[];
  /** Private route table ID (target of Scenario 2 break/fix). */
  public readonly privateRouteTableId: string;
  /** NAT Gateway ID (needed to restore route in Scenario 2 fix). */
  public readonly natGatewayId: string;
  /** S3 Gateway VPC Endpoint ID (target of Scenario 3 break/fix). */
  public readonly s3EndpointId: string;
  /** Bedrock Interface VPC Endpoint ID (target of Scenario 4 break/fix). */
  public readonly bedrockEndpointId: string;
  /** Subnet IDs associated with the Bedrock Interface Endpoint. */
  public readonly bedrockEndpointSubnetIds: string[];
  /** S3 bucket receiving VPC Flow Logs. */
  public readonly vpcFlowLogBucket: s3.IBucket;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // -----------------------------------------------------------------------
    // VPC Flow Log Bucket (must be created before VPC Flow Logs reference it)
    // -----------------------------------------------------------------------
    const flowLogBucket = new s3.Bucket(this, 'VpcFlowLogBucket', {
      bucketName: `vpc-flow-logs-${cdk.Aws.ACCOUNT_ID}-${cdk.Aws.REGION}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [
        {
          expiration: cdk.Duration.days(30),
        },
      ],
    });

    NagSuppressions.addResourceSuppressions(flowLogBucket, [
      {
        id: 'AwsSolutions-S1',
        reason: 'VPC Flow Log bucket does not need access logging for this demo.',
      },
    ]);

    this.vpcFlowLogBucket = flowLogBucket;

    // -----------------------------------------------------------------------
    // VPC with explicit subnet configuration
    // -----------------------------------------------------------------------
    const vpc = new ec2.Vpc(this, 'DemoVpc', {
      ipAddresses: ec2.IpAddresses.cidr('10.0.0.0/16'),
      maxAzs: 2,
      natGateways: 1, // Single NAT GW in AZ-a for cost savings
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          cidrMask: 24,
          name: 'Private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
      ],
    });

    this.vpc = vpc;
    this.publicSubnets = vpc.publicSubnets;
    this.privateSubnets = vpc.privateSubnets;

    // -----------------------------------------------------------------------
    // VPC Flow Logs → S3 (ALL traffic: ACCEPT + REJECT)
    // -----------------------------------------------------------------------
    vpc.addFlowLog('FlowLogToS3', {
      destination: ec2.FlowLogDestination.toS3(flowLogBucket, 'AWSLogs'),
      trafficType: ec2.FlowLogTrafficType.ALL,
    });

    NagSuppressions.addResourceSuppressions(
      vpc,
      [
        {
          id: 'AwsSolutions-VPC7',
          reason: 'VPC Flow Logs are configured to S3 (not CloudWatch Logs). cdk-nag may not detect S3 destination.',
        },
      ],
      true,
    );

    // -----------------------------------------------------------------------
    // S3 Gateway Endpoint (attached to private route tables)
    // -----------------------------------------------------------------------
    const s3Endpoint = vpc.addGatewayEndpoint('S3GatewayEndpoint', {
      service: ec2.GatewayVpcEndpointAwsService.S3,
      subnets: [{ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }],
    });

    this.s3EndpointId = s3Endpoint.vpcEndpointId;

    // -----------------------------------------------------------------------
    // CloudWatch Monitoring Interface VPC Endpoint
    // Required so the health-check-app can publish ConnectivityFailure metrics
    // even when the NAT Gateway route is deleted (Scenario 2). Without this,
    // PutMetricData calls fail when outbound internet is lost.
    // -----------------------------------------------------------------------
    vpc.addInterfaceEndpoint('CloudWatchMonitoringEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_MONITORING,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      privateDnsEnabled: true,
    });

    // -----------------------------------------------------------------------
    // SSM Interface VPC Endpoints
    // Required so SSM agent stays connected and SSM commands (Scenarios 5-6)
    // work even when the NAT Gateway route is deleted (Scenario 2).
    // -----------------------------------------------------------------------
    vpc.addInterfaceEndpoint('SsmEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.SSM,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      privateDnsEnabled: true,
    });
    vpc.addInterfaceEndpoint('SsmMessagesEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.SSM_MESSAGES,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      privateDnsEnabled: true,
    });
    vpc.addInterfaceEndpoint('Ec2MessagesEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.EC2_MESSAGES,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      privateDnsEnabled: true,
    });

    // -----------------------------------------------------------------------
    // Bedrock Runtime Interface VPC Endpoint (in both private subnets)
    // -----------------------------------------------------------------------
    const bedrockEndpoint = vpc.addInterfaceEndpoint('BedrockRuntimeEndpoint', {
      service: new ec2.InterfaceVpcEndpointService(
        `com.amazonaws.${cdk.Aws.REGION}.bedrock-runtime`,
      ),
      subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      privateDnsEnabled: true,
    });

    // Bedrock control plane endpoint (for ListFoundationModels health check)
    vpc.addInterfaceEndpoint('BedrockControlPlaneEndpoint', {
      service: new ec2.InterfaceVpcEndpointService(
        `com.amazonaws.${cdk.Aws.REGION}.bedrock`,
      ),
      subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      privateDnsEnabled: true,
    });

    this.bedrockEndpointId = bedrockEndpoint.vpcEndpointId;
    this.bedrockEndpointSubnetIds = vpc.privateSubnets.map((s) => s.subnetId);

    // -----------------------------------------------------------------------
    // Amazon Location Service (Maps) Interface VPC Endpoint (Scenario 6)
    // Used by the health-check-app TLS verification check. When scenario 6
    // poisons /etc/hosts, traffic to maps.geo.region.amazonaws.com goes to
    // local nginx instead, causing a TLS cert mismatch that triggers alarm-6.
    // -----------------------------------------------------------------------
    vpc.addInterfaceEndpoint('LocationMapsEndpoint', {
      service: new ec2.InterfaceVpcEndpointService(
        `com.amazonaws.${cdk.Aws.REGION}.geo.maps`,
      ),
      subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      privateDnsEnabled: true,
    });

    // -----------------------------------------------------------------------
    // STS Interface VPC Endpoint
    // Required so AWS SDK credential refresh works when NAT is down (Scenario 2).
    // Without this, Bedrock/S3/other SDK calls fail because they can't reach
    // STS to get temporary credentials, causing alarm-4 to false-trigger.
    // -----------------------------------------------------------------------
    vpc.addInterfaceEndpoint('StsEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.STS,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      privateDnsEnabled: true,
    });

    NagSuppressions.addResourceSuppressions(
      bedrockEndpoint,
      [
        {
          id: 'AwsSolutions-EC23',
          reason: 'Bedrock Interface Endpoint security group is scoped to VPC CIDR by default.',
        },
      ],
      true,
    );

    // Suppress CdkNagValidationFailure warnings for all VPC endpoint security groups.
    // cdk-nag can't validate security group rules that reference VPC CIDR via Fn::GetAtt.
    NagSuppressions.addStackSuppressions(this, [
      {
        id: 'CdkNagValidationFailure',
        reason: 'VPC endpoint security groups use Fn::GetAtt for VPC CIDR which cdk-nag cannot validate at synth time. The security groups are correctly scoped to the VPC CIDR.',
      },
    ]);

    // -----------------------------------------------------------------------
    // Extract NAT Gateway ID and private route table ID for break/fix
    // -----------------------------------------------------------------------
    // CDK creates NAT Gateways as part of the VPC construct. We need the
    // physical NAT Gateway ID and the private route table ID for Scenario 2.
    // The first private subnet's route table contains the NAT GW route.
    const privateSubnet = vpc.privateSubnets[0] as ec2.PrivateSubnet;
    this.privateRouteTableId = privateSubnet.routeTable.routeTableId;

    // The NAT Gateway ID is not directly exposed by the L2 VPC construct.
    // We look it up from the VPC's public subnet where it was placed.
    // CDK places the NAT GW in the first public subnet (AZ-a).
    const publicSubnet = vpc.publicSubnets[0] as ec2.PublicSubnet;

    // Find the CfnNatGateway child of the public subnet
    const cfnNatGw = publicSubnet.node.children.find(
      (child) => (child as cdk.CfnResource).cfnResourceType === 'AWS::EC2::NatGateway',
    ) as ec2.CfnNatGateway | undefined;

    if (cfnNatGw) {
      this.natGatewayId = cfnNatGw.ref;
    } else {
      // Fallback: use a token that resolves at deploy time
      this.natGatewayId = cdk.Fn.ref('PlaceholderNatGw');
    }

    // -----------------------------------------------------------------------
    // CfnOutputs
    // -----------------------------------------------------------------------
    new cdk.CfnOutput(this, 'VpcId', { value: vpc.vpcId });
    new cdk.CfnOutput(this, 'PublicSubnetIds', {
      value: vpc.publicSubnets.map((s) => s.subnetId).join(','),
    });
    new cdk.CfnOutput(this, 'PrivateSubnetIds', {
      value: vpc.privateSubnets.map((s) => s.subnetId).join(','),
    });
    new cdk.CfnOutput(this, 'PrivateRouteTableId', {
      value: this.privateRouteTableId,
    });
    new cdk.CfnOutput(this, 'NatGatewayId', { value: this.natGatewayId });
    new cdk.CfnOutput(this, 'S3EndpointId', { value: this.s3EndpointId });
    new cdk.CfnOutput(this, 'BedrockEndpointId', {
      value: this.bedrockEndpointId,
    });
    new cdk.CfnOutput(this, 'VpcFlowLogBucketArn', {
      value: flowLogBucket.bucketArn,
    });
  }
}
