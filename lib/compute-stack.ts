import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as elbv2_targets from 'aws-cdk-lib/aws-elasticloadbalancingv2-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';

/**
 * Props passed from NetworkStack into ComputeStack.
 */
export interface ComputeStackProps extends cdk.StackProps {
  /** VPC created by NetworkStack. */
  readonly vpc: ec2.IVpc;
  /** Public subnets for ALB placement. */
  readonly publicSubnets: ec2.ISubnet[];
  /** Private subnets for EC2 and RDS placement. */
  readonly privateSubnets: ec2.ISubnet[];
  /** Private route table ID (passed through to dashboard for break/fix). */
  readonly privateRouteTableId: string;
  /** NAT Gateway ID (passed through to dashboard for break/fix). */
  readonly natGatewayId: string;
  /** S3 Gateway Endpoint ID (passed through). */
  readonly s3EndpointId: string;
  /** Bedrock Interface Endpoint ID (passed through). */
  readonly bedrockEndpointId: string;
  /** Bedrock endpoint subnet IDs (passed through). */
  readonly bedrockEndpointSubnetIds: string[];
  /** VPC Flow Log bucket (for IAM policy scoping). */
  readonly vpcFlowLogBucket: s3.IBucket;
}

/**
 * ComputeStack — EC2 instance, ALB, RDS, S3 log buckets.
 *
 * Exports consumed by TrafficGenStack, AlarmStack, DashboardStack.
 */
export class ComputeStack extends cdk.Stack {
  /** EC2 instance ID (for SSM commands in Scenario 6). */
  public readonly ec2InstanceId: string;
  /** ALB public URL (for traffic generator and dashboard). */
  public readonly albUrl: string;
  /** ALB HTTPS listener ARN (target of Scenario 5 break/fix). */
  public readonly albListenerArn: string;
  /** ALB full name (for CloudWatch alarm dimensions). */
  public readonly albFullName: string;
  /** ALB target group full name (for CloudWatch alarm dimensions). */
  public readonly albTargetGroupFullName: string;
  /** RDS endpoint address. */
  public readonly rdsEndpoint: string;
  /** ELB Access Log S3 bucket. */
  public readonly elbAccessLogBucket: s3.IBucket;
  /** EC2 security group ID (source in RDS SG rule — Scenario 1). */
  public readonly ec2SecurityGroupId: string;
  /** RDS security group ID (target of Scenario 1 break/fix). */
  public readonly rdsSecurityGroupId: string;

  constructor(scope: Construct, id: string, props: ComputeStackProps) {
    super(scope, id, props);

    // -----------------------------------------------------------------------
    // Security Groups (Task 3.1)
    // -----------------------------------------------------------------------

    // ALB Security Group — inbound 443 from anywhere (ALB itself created in 3.2)
    const albSecurityGroup = new ec2.SecurityGroup(this, 'AlbSecurityGroup', {
      vpc: props.vpc,
      description: 'Security group for the internet-facing ALB',
      allowAllOutbound: true,
    });
    albSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(80),
      'Allow HTTP from anywhere',
    );

    // EC2 Security Group — inbound port 80 from ALB SG
    const ec2SecurityGroup = new ec2.SecurityGroup(this, 'Ec2SecurityGroup', {
      vpc: props.vpc,
      description: 'Security group for the Health Check EC2 instance',
      allowAllOutbound: true,
    });
    ec2SecurityGroup.addIngressRule(
      albSecurityGroup,
      ec2.Port.tcp(80),
      'Allow HTTP from ALB',
    );
    // Allow HTTPS from within VPC (for Scenario 6 TLS/SNI mismatch test)
    ec2SecurityGroup.addIngressRule(
      ec2.Peer.ipv4(props.vpc.vpcCidrBlock),
      ec2.Port.tcp(443),
      'Allow HTTPS from within VPC for TLS mismatch scenario',
    );

    // RDS Security Group — inbound port 3306 from EC2 SG only
    const rdsSecurityGroup = new ec2.SecurityGroup(this, 'RdsSecurityGroup', {
      vpc: props.vpc,
      description: 'Security group for the RDS MySQL instance',
      allowAllOutbound: false,
    });
    rdsSecurityGroup.addIngressRule(
      ec2SecurityGroup,
      ec2.Port.tcp(3306),
      'Allow MySQL from EC2 instance',
    );

    this.ec2SecurityGroupId = ec2SecurityGroup.securityGroupId;
    this.rdsSecurityGroupId = rdsSecurityGroup.securityGroupId;

    // -----------------------------------------------------------------------
    // RDS MySQL Instance (Task 3.1)
    // -----------------------------------------------------------------------

    const rdsSubnetGroup = new rds.SubnetGroup(this, 'RdsSubnetGroup', {
      vpc: props.vpc,
      description: 'Subnet group for RDS MySQL in private subnets',
      vpcSubnets: {
        subnets: props.privateSubnets,
      },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const rdsInstance = new rds.DatabaseInstance(this, 'RdsMysqlInstance', {
      engine: rds.DatabaseInstanceEngine.mysql({
        version: rds.MysqlEngineVersion.VER_8_0,
      }),
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.T3,
        ec2.InstanceSize.MICRO,
      ),
      vpc: props.vpc,
      subnetGroup: rdsSubnetGroup,
      securityGroups: [rdsSecurityGroup],
      multiAz: false,
      allocatedStorage: 20,
      maxAllocatedStorage: 20,
      deletionProtection: false,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      backupRetention: cdk.Duration.days(0),
      storageEncrypted: true,
    });

    this.rdsEndpoint = rdsInstance.dbInstanceEndpointAddress;

    // -----------------------------------------------------------------------
    // cdk-nag suppressions for RDS and security groups
    // -----------------------------------------------------------------------
    NagSuppressions.addResourceSuppressions(
      rdsInstance,
      [
        {
          id: 'AwsSolutions-RDS3',
          reason: 'Multi-AZ disabled for demo/cost savings.',
        },
        {
          id: 'AwsSolutions-RDS2',
          reason: 'Storage encryption disabled for demo to reduce cost.',
        },
        {
          id: 'AwsSolutions-RDS10',
          reason: 'Deletion protection disabled for clean teardown (RemovalPolicy.DESTROY).',
        },
        {
          id: 'AwsSolutions-RDS11',
          reason: 'Using default MySQL port 3306 for demo simplicity.',
        },
        {
          id: 'AwsSolutions-SMG4',
          reason: 'RDS credentials secret rotation not required for demo.',
        },
        {
          id: 'AwsSolutions-RDS6',
          reason: 'IAM authentication not required for demo.',
        },
        {
          id: 'AwsSolutions-RDS14',
          reason: 'Backtrack not supported on MySQL (Aurora only).',
        },
        {
          id: 'AwsSolutions-RDS13',
          reason: 'Automated backups disabled for demo (backupRetention=0).',
        },
        {
          id: 'AwsSolutions-RDS16',
          reason: 'CloudWatch Logs exports not required for demo.',
        },
      ],
      true, // Apply to child constructs (includes the auto-generated Secret)
    );

    NagSuppressions.addResourceSuppressions(
      albSecurityGroup,
      [
        {
          id: 'AwsSolutions-EC23',
          reason: 'ALB security group intentionally allows inbound 443 from 0.0.0.0/0 for public access.',
        },
      ],
      true,
    );

    NagSuppressions.addResourceSuppressions(
      ec2SecurityGroup,
      [
        {
          id: 'AwsSolutions-EC23',
          reason: 'EC2 security group allows inbound only from ALB security group.',
        },
      ],
      true,
    );

    // -----------------------------------------------------------------------
    // CfnOutputs for Task 3.1 resources
    // -----------------------------------------------------------------------
    new cdk.CfnOutput(this, 'Ec2SecurityGroupId', {
      value: ec2SecurityGroup.securityGroupId,
    });
    new cdk.CfnOutput(this, 'RdsSecurityGroupId', {
      value: rdsSecurityGroup.securityGroupId,
    });
    new cdk.CfnOutput(this, 'RdsEndpoint', {
      value: rdsInstance.dbInstanceEndpointAddress,
    });

    // -----------------------------------------------------------------------
    // ELB Access Log Bucket (Task 3.2)
    // -----------------------------------------------------------------------
    const elbAccessLogBucket = new s3.Bucket(this, 'ElbAccessLogBucket', {
      bucketName: `elb-access-logs-${cdk.Aws.ACCOUNT_ID}-${cdk.Aws.REGION}`,
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

    this.elbAccessLogBucket = elbAccessLogBucket;

    NagSuppressions.addResourceSuppressions(elbAccessLogBucket, [
      {
        id: 'AwsSolutions-S1',
        reason: 'ELB Access Log bucket does not need access logging for this demo.',
      },
    ]);

    // -----------------------------------------------------------------------
    // Application Load Balancer (Task 3.2)
    // -----------------------------------------------------------------------
    const alb = new elbv2.ApplicationLoadBalancer(this, 'DemoAlb', {
      vpc: props.vpc,
      internetFacing: true,
      vpcSubnets: { subnets: props.publicSubnets },
      securityGroup: albSecurityGroup,
    });

    // Enable ALB access logs to the ELB Access Log bucket.
    // The logAccessLogs method automatically adds the required bucket policy
    // granting the regional ELB service principal write access.
    alb.logAccessLogs(elbAccessLogBucket);

    this.albUrl = `http://${alb.loadBalancerDnsName}`;
    this.albFullName = alb.loadBalancerFullName;

    NagSuppressions.addResourceSuppressions(alb, [
      {
        id: 'AwsSolutions-ELB2',
        reason: 'ALB access logging is enabled via logAccessLogs().',
      },
    ]);
    // ALB HTTP-only is acceptable for this demo — traffic is internal (VPC private subnet)
    // and the frontend is served via CloudFront HTTPS. The ALB is not directly internet-facing for user traffic.

    // -----------------------------------------------------------------------
    // Target Group — EC2 instance port 80 (Task 3.2)
    // Instance registration happens in Task 3.3
    // -----------------------------------------------------------------------
    const targetGroup = new elbv2.ApplicationTargetGroup(this, 'DemoTargetGroup', {
      vpc: props.vpc,
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.INSTANCE,
      healthCheck: {
        path: '/',
        interval: cdk.Duration.seconds(30),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
    });

    this.albTargetGroupFullName = targetGroup.targetGroupFullName;

    // -----------------------------------------------------------------------
    // HTTP Listener — port 80 (Task 3.2)
    // Uses HTTP for initial deployment (no certificate required).
    // Scenario 5 break/fix modifies the listener TLS policy at runtime.
    // -----------------------------------------------------------------------
    const httpListener = alb.addListener('HttpListener', {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      defaultTargetGroups: [targetGroup],
    });

    this.albListenerArn = httpListener.listenerArn;

    // -----------------------------------------------------------------------
    // CfnOutputs for Task 3.2 resources
    // -----------------------------------------------------------------------
    new cdk.CfnOutput(this, 'AlbUrl', {
      value: this.albUrl,
      description: 'ALB public HTTP URL',
    });
    new cdk.CfnOutput(this, 'AlbListenerArn', {
      value: this.albListenerArn,
      description: 'ALB HTTPS listener ARN (target of Scenario 5 break/fix)',
    });
    new cdk.CfnOutput(this, 'AlbFullName', {
      value: this.albFullName,
      description: 'ALB full name for CloudWatch alarm dimensions',
    });
    new cdk.CfnOutput(this, 'AlbTargetGroupFullName', {
      value: this.albTargetGroupFullName,
      description: 'ALB target group full name for CloudWatch alarm dimensions',
    });
    new cdk.CfnOutput(this, 'ElbAccessLogBucketArn', {
      value: elbAccessLogBucket.bucketArn,
      description: 'ELB Access Log bucket ARN',
    });

    // -----------------------------------------------------------------------
    // EC2 IAM Role and Instance Profile (Task 3.3)
    // -----------------------------------------------------------------------
    const ec2Role = new iam.Role(this, 'Ec2InstanceRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      description: 'IAM role for the Health Check EC2 instance',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });

    // Inline policy: CloudWatch PutMetricData for NetworkDevOpsDemo namespace
    ec2Role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'CloudWatchPutMetricData',
        effect: iam.Effect.ALLOW,
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'],
        conditions: {
          StringEquals: {
            'cloudwatch:namespace': 'NetworkDevOpsDemo',
          },
        },
      }),
    );

    // Inline policy: S3 PutObject on PCAP_Storage_Bucket (for tcpdump upload in Scenario 6)
    // The PCAP bucket is in PcapMcpStack, so we use a wildcard pattern here.
    ec2Role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'S3PutObjectPcapBucket',
        effect: iam.Effect.ALLOW,
        actions: ['s3:PutObject'],
        resources: [`arn:aws:s3:::pcap-analyzer-storage-*/*`],
      }),
    );

    // -----------------------------------------------------------------------
    // EC2 Instance — t3.medium, Amazon Linux 2023, private subnet AZ-a (Task 3.3)
    // -----------------------------------------------------------------------
    // S3 bucket name for health check (uses VPC Flow Log bucket as a convenient existing bucket)
    const s3BucketNameForCheck = props.vpcFlowLogBucket.bucketName;

    // Grant EC2 role read access to the S3 bucket for HeadBucket checks
    props.vpcFlowLogBucket.grantRead(ec2Role);

    // Grant EC2 role Bedrock ListFoundationModels for health checks
    ec2Role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'BedrockRuntimeInvokeModel',
        effect: iam.Effect.ALLOW,
        actions: ['bedrock:InvokeModel'],
        resources: [`arn:aws:bedrock:${this.region}::foundation-model/amazon.nova-2-lite-v1:0`],
      }),
    );

    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      '#!/bin/bash',
      'set -euxo pipefail',
      '',
      '# Install Node.js 20 via dnf',
      'dnf install -y nodejs20 npm',
      'alternatives --install /usr/bin/node node /usr/bin/node-20 100',
      'alternatives --install /usr/bin/npm npm /usr/bin/npm-20 100',
      '',
      '# Install tcpdump for packet capture (Scenario 6), nginx + openssl for TLS server, unzip for assets',
      'dnf install -y tcpdump unzip nginx openssl',
      '',
      '# Create self-signed cert for CN=server.internal.lab (deliberate mismatch for Scenario 6)',
      'mkdir -p /etc/pki/tls/private /etc/pki/tls/certs',
      'openssl req -x509 -nodes -days 365 -newkey rsa:2048 \\',
      '  -keyout /etc/pki/tls/private/server.key \\',
      '  -out /etc/pki/tls/certs/server.crt \\',
      '  -subj "/CN=server.internal.lab/O=Net Lab/C=US"',
      '',
      '# Configure nginx: HTTP on 80 (health check) + HTTPS on 443 (TLS mismatch scenario)',
      'cat > /etc/nginx/conf.d/app.conf << \'NGINXCONF\'',
      'server {',
      '    listen 443 ssl;',
      '    server_name _;',
      '    ssl_certificate /etc/pki/tls/certs/server.crt;',
      '    ssl_certificate_key /etc/pki/tls/private/server.key;',
      '    ssl_protocols TLSv1.2 TLSv1.3;',
      '    location / {',
      '        return 200 \'{"app":"web-app","status":"running","tls":true}\\n\';',
      '        add_header Content-Type application/json;',
      '    }',
      '}',
      'NGINXCONF',
      '',
      '# Replace nginx.conf with a clean version (no default server block)',
      '# The sed approach was corrupting the file — write a known-good config instead',
      'rm -f /etc/nginx/conf.d/default.conf 2>/dev/null || true',
      'cat > /etc/nginx/nginx.conf << \'NGINXMAIN\'',
      'user nginx;',
      'worker_processes auto;',
      'error_log /var/log/nginx/error.log notice;',
      'pid /run/nginx.pid;',
      'include /usr/share/nginx/modules/*.conf;',
      'events {',
      '    worker_connections 1024;',
      '}',
      'http {',
      '    log_format  main  \'$remote_addr - $remote_user [$time_local] "$request" \'',
      '                      \'$status $body_bytes_sent "$http_referer" \'',
      '                      \'"$http_user_agent" "$http_x_forwarded_for"\';',
      '    access_log  /var/log/nginx/access.log  main;',
      '    sendfile            on;',
      '    tcp_nopush          on;',
      '    keepalive_timeout   65;',
      '    types_hash_max_size 4096;',
      '    include             /etc/nginx/mime.types;',
      '    default_type        application/octet-stream;',
      '    include /etc/nginx/conf.d/*.conf;',
      '}',
      'NGINXMAIN',
      'systemctl start nginx && systemctl enable nginx',
      '',
      '# Create health check app directory and deploy app',
      'mkdir -p /opt/health-check-app',
    );

    // Deploy the health-check-app files via CDK asset
    const healthCheckAppAsset = new cdk.aws_s3_assets.Asset(this, 'HealthCheckAppAsset', {
      path: require('path').join(__dirname, '..', 'health-check-app'),
    });
    healthCheckAppAsset.grantRead(ec2Role);

    userData.addS3DownloadCommand({
      bucket: healthCheckAppAsset.bucket,
      bucketKey: healthCheckAppAsset.s3ObjectKey,
      localFile: '/tmp/health-check-app.zip',
    });

    userData.addCommands(
      '# Extract health check app',
      'cd /opt/health-check-app',
      'unzip -o /tmp/health-check-app.zip -d /opt/health-check-app',
      '',
      '# Install npm dependencies',
      'cd /opt/health-check-app && npm install --production',
      '',
      '# Create systemd service for the health check app',
      'cat > /etc/systemd/system/health-check-app.service << \'SVCEOF\'',
      '[Unit]',
      'Description=Health Check Application',
      'After=network.target',
      '',
      '[Service]',
      'Type=simple',
      'User=root',
      'WorkingDirectory=/opt/health-check-app',
      'ExecStart=/usr/bin/node /opt/health-check-app/index.js',
      'Restart=always',
      'RestartSec=5',
      'Environment=NODE_ENV=production',
      `Environment=RDS_ENDPOINT=${rdsInstance.dbInstanceEndpointAddress}`,
      `Environment=S3_BUCKET_NAME=${s3BucketNameForCheck}`,
      `Environment=AWS_REGION=${cdk.Aws.REGION}`,
      '',
      '[Install]',
      'WantedBy=multi-user.target',
      'SVCEOF',
      '',
      '# Enable and start the health check app service',
      'systemctl daemon-reload',
      'systemctl enable health-check-app',
      'systemctl start health-check-app',
    );

    const ec2Instance = new ec2.Instance(this, 'HealthCheckInstance', {
      vpc: props.vpc,
      vpcSubnets: { subnets: [props.privateSubnets[0]] }, // Private subnet AZ-a
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.T3,
        ec2.InstanceSize.MEDIUM,
      ),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      securityGroup: ec2SecurityGroup,
      role: ec2Role,
      userData,
      userDataCausesReplacement: false,
      requireImdsv2: true,
      blockDevices: [{
        deviceName: '/dev/xvda',
        volume: ec2.BlockDeviceVolume.ebs(30, { encrypted: true }),
      }],
    });

    this.ec2InstanceId = ec2Instance.instanceId;

    // -----------------------------------------------------------------------
    // Register EC2 instance with ALB target group (Task 3.3)
    // -----------------------------------------------------------------------
    targetGroup.addTarget(new elbv2_targets.InstanceTarget(ec2Instance, 80));

    // -----------------------------------------------------------------------
    // cdk-nag suppressions for EC2 (Task 3.3)
    // -----------------------------------------------------------------------
    NagSuppressions.addResourceSuppressions(
      ec2Instance,
      [
        {
          id: 'AwsSolutions-EC26',
          reason: 'EBS encryption enabled via blockDevices configuration.',
        },
        {
          id: 'AwsSolutions-EC28',
          reason: 'Detailed monitoring not required for demo instance.',
        },
        {
          id: 'AwsSolutions-EC29',
          reason: 'Termination protection not required for demo instance (RemovalPolicy.DESTROY).',
        },
      ],
      true,
    );

    NagSuppressions.addResourceSuppressions(
      ec2Role,
      [
        {
          id: 'AwsSolutions-IAM4',
          reason: 'AmazonSSMManagedInstanceCore is required for SSM Run Command in Scenario 6.',
        },
        {
          id: 'AwsSolutions-IAM5',
          reason: 'Wildcard resource used for CloudWatch PutMetricData (namespace-scoped) and S3 PutObject on PCAP bucket pattern.',
        },
      ],
      true,
    );

    // -----------------------------------------------------------------------
    // CfnOutputs for Task 3.3 resources
    // -----------------------------------------------------------------------
    new cdk.CfnOutput(this, 'Ec2InstanceId', {
      value: ec2Instance.instanceId,
      description: 'EC2 instance ID for SSM commands in Scenario 6',
    });
  }
}
