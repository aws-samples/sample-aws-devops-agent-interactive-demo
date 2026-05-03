import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatch_actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda-nodejs';
import * as lambdaRuntime from 'aws-cdk-lib/aws-lambda';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sns_subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import { NagSuppressions } from 'cdk-nag';
import * as path from 'path';
import { Construct } from 'constructs';

/**
 * Props passed from ComputeStack into AlarmStack.
 */
export interface AlarmStackProps extends cdk.StackProps {
  /** ALB full name for the ClientTLSNegotiationErrorCount alarm dimension. */
  readonly albFullName: string;
  /** ALB target group full name for alarm dimensions. */
  readonly albTargetGroupFullName: string;
}

/**
 * AlarmStack — 6 CloudWatch alarms, SNS topic, webhook Lambda.
 *
 * Exports consumed by DashboardStack.
 */
export class AlarmStack extends cdk.Stack {
  /** SNS topic ARN that all alarms publish to. */
  public readonly snsTopicArn: string;
  /** Webhook Lambda ARN (for dashboard webhook-config updates). */
  public readonly webhookLambdaArn: string;
  /** Secrets Manager secret ARN for webhook credentials. */
  public readonly webhookSecretArn: string;

  constructor(scope: Construct, id: string, props: AlarmStackProps) {
    super(scope, id, props);

    // -----------------------------------------------------------------------
    // Task 7.1 — SNS Topic
    // -----------------------------------------------------------------------
    const alarmTopic = new sns.Topic(this, 'AlarmTopic', {
      topicName: 'network-devops-demo-alarms',
      displayName: 'Network DevOps Demo Alarms',
    });

    this.snsTopicArn = alarmTopic.topicArn;

    // -----------------------------------------------------------------------
    // Task 7.1 — Custom metric alarms (Scenarios 1–4)
    //
    // All use Namespace=NetworkDevOpsDemo, MetricName=ConnectivityFailure
    // with a CheckType dimension identifying the scenario.
    // Threshold: > 0 for 1 period (60s)
    // Requirements: 5.1, 5.2
    // -----------------------------------------------------------------------

    const customAlarmConfigs: Array<{
      id: string;
      alarmName: string;
      checkType: string;
      description: string;
    }> = [
      {
        id: 'RdsConnectivityAlarm',
        alarmName: 'alarm-1',
        checkType: 'rds',
        description: 'Connectivity failure detected',
      },
      {
        id: 'NatConnectivityAlarm',
        alarmName: 'alarm-2',
        checkType: 'nat',
        description: 'Connectivity failure detected',
      },
      {
        id: 'S3ConnectivityAlarm',
        alarmName: 'alarm-3',
        checkType: 's3',
        description: 'Connectivity failure detected',
      },
      {
        id: 'BedrockConnectivityAlarm',
        alarmName: 'alarm-4',
        checkType: 'bedrock',
        description: 'Connectivity failure detected',
      },
    ];

    for (const cfg of customAlarmConfigs) {
      const metric = new cloudwatch.Metric({
        namespace: 'NetworkDevOpsDemo',
        metricName: 'ConnectivityFailure',
        dimensionsMap: {
          CheckType: cfg.checkType,
        },
        period: cdk.Duration.seconds(60),
        statistic: 'Sum',
      });

      const alarm = new cloudwatch.Alarm(this, cfg.id, {
        alarmName: cfg.alarmName,
        alarmDescription: cfg.description,
        metric,
        threshold: 0,
        comparisonOperator:
          cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });

      alarm.addAlarmAction(new cloudwatch_actions.SnsAction(alarmTopic));
    }

    // -----------------------------------------------------------------------
    // Task 7.1 — ALB 5XX error alarm (Scenario 5)
    //
    // Monitors HTTPCode_ELB_5XX_Count — triggers when backend is down
    // and ALB returns 502 Bad Gateway.
    // -----------------------------------------------------------------------

    const alb5xxMetric = new cloudwatch.Metric({
      namespace: 'AWS/ApplicationELB',
      metricName: 'HTTPCode_ELB_5XX_Count',
      dimensionsMap: {
        LoadBalancer: props.albFullName,
      },
      period: cdk.Duration.seconds(60),
      statistic: 'Sum',
    });

    const alb5xxAlarm = new cloudwatch.Alarm(this, 'Alb5xxErrorAlarm', {
      alarmName: 'alarm-5',
      alarmDescription: 'Application error detected',
      metric: alb5xxMetric,
      threshold: 0,
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    alb5xxAlarm.addAlarmAction(new cloudwatch_actions.SnsAction(alarmTopic));

    // -----------------------------------------------------------------------
    // Task 7.1 — Custom metric alarm for outbound-https (Scenario 6)
    //
    // Uses Namespace=NetworkDevOpsDemo, MetricName=ConnectivityFailure,
    // CheckType=outbound-https
    // Threshold: > 0 for 1 period (60s)
    // Requirements: 5.1, 5.2
    // -----------------------------------------------------------------------

    const outboundHttpsMetric = new cloudwatch.Metric({
      namespace: 'NetworkDevOpsDemo',
      metricName: 'ConnectivityFailure',
      dimensionsMap: {
        CheckType: 'outbound-https',
      },
      period: cdk.Duration.seconds(60),
      statistic: 'Sum',
    });

    const outboundHttpsAlarm = new cloudwatch.Alarm(
      this,
      'OutboundHttpsAlarm',
      {
        alarmName: 'alarm-6',
        alarmDescription:
          'Connectivity failure detected',
        metric: outboundHttpsMetric,
        threshold: 0,
        comparisonOperator:
          cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      },
    );

    outboundHttpsAlarm.addAlarmAction(
      new cloudwatch_actions.SnsAction(alarmTopic),
    );

    // -----------------------------------------------------------------------
    // Task 7.3 — Webhook Lambda
    //
    // Receives SNS notifications, formats DevOps Agent incident payload,
    // computes HMAC-SHA256 signature, POSTs to webhook URL, writes event
    // to Events_Table.
    // Requirements: 5.3, 5.4, 5.5
    // -----------------------------------------------------------------------

    // -----------------------------------------------------------------------
    // Secrets Manager secret for webhook credentials
    // -----------------------------------------------------------------------
    const webhookSecret = new secretsmanager.Secret(this, 'WebhookSecret', {
      secretName: 'network-devops-webhook-config',
      description: 'Webhook URL and HMAC secret for DevOps Agent integration',
      secretObjectValue: {
        webhookUrl: cdk.SecretValue.unsafePlainText(''),
        hmacSecret: cdk.SecretValue.unsafePlainText(''),
      },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    NagSuppressions.addResourceSuppressions(webhookSecret, [
      { id: 'AwsSolutions-SMG4', reason: 'Webhook credentials are manually configured by the user via the dashboard, automatic rotation is not applicable.' },
    ]);

    this.webhookSecretArn = webhookSecret.secretArn;

    const webhookLambdaRole = new iam.Role(this, 'WebhookLambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description:
        'Execution role for the webhook Lambda with CloudWatch Logs write and DynamoDB PutItem',
    });

    // CloudWatch Logs permissions
    webhookLambdaRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'logs:CreateLogGroup',
          'logs:CreateLogStream',
          'logs:PutLogEvents',
        ],
        resources: ['*'],
      }),
    );

    // DynamoDB PutItem + GetItem permission
    webhookLambdaRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['dynamodb:PutItem', 'dynamodb:GetItem'],
        resources: [
          `arn:aws:dynamodb:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:table/net-devops-dashboard-events-*`,
        ],
      }),
    );

    // Secrets Manager read permission
    webhookSecret.grantRead(webhookLambdaRole);

    const webhookLambda = new lambda.NodejsFunction(this, 'WebhookHandler', {
      runtime: lambdaRuntime.Runtime.NODEJS_20_X,
      handler: 'handler',
      entry: path.join(__dirname, '..', 'lambda', 'webhook', 'index.ts'),
      timeout: cdk.Duration.seconds(30),
      memorySize: 128,
      role: webhookLambdaRole,
      environment: {
        WEBHOOK_SECRET_ARN: webhookSecret.secretArn,
        EVENTS_TABLE_NAME: '', // Set by DashboardStack after deployment
      },
      bundling: {
        minify: false,
        sourceMap: true,
      },
    });

    this.webhookLambdaArn = webhookLambda.functionArn;

    // Subscribe webhook Lambda to the SNS alarm topic
    alarmTopic.addSubscription(
      new sns_subscriptions.LambdaSubscription(webhookLambda),
    );

    // -----------------------------------------------------------------------
    // CfnOutputs
    // -----------------------------------------------------------------------
    new cdk.CfnOutput(this, 'SnsTopicArn', {
      value: alarmTopic.topicArn,
      description: 'SNS topic ARN for CloudWatch alarm notifications',
    });

    new cdk.CfnOutput(this, 'WebhookLambdaArn', {
      value: webhookLambda.functionArn,
      description: 'Webhook Lambda ARN (for dashboard webhook-config updates)',
    });

    new cdk.CfnOutput(this, 'WebhookSecretArn', {
      value: webhookSecret.secretArn,
      description: 'Secrets Manager secret ARN for webhook credentials',
    });

    // -----------------------------------------------------------------------
    // cdk-nag suppressions
    // -----------------------------------------------------------------------
    NagSuppressions.addStackSuppressions(this, [
      {
        id: 'AwsSolutions-SNS2',
        reason: 'SNS topic encryption not required for this demo — alarm notifications contain no sensitive data.',
      },
      {
        id: 'AwsSolutions-SNS3',
        reason: 'SNS topic SSL enforcement handled at the subscriber level (Lambda).',
      },
      {
        id: 'AwsSolutions-IAM5',
        reason:
          'Wildcard resources required for CloudWatch Logs write (dynamic log group names) and DynamoDB PutItem (cross-stack table reference).',
      },
      {
        id: 'AwsSolutions-L1',
        reason:
          'Lambda runtime version (Node.js 20.x) is the latest LTS runtime supported by CDK NodejsFunction.',
      },
      {
        id: 'AwsSolutions-SNS2',
        reason:
          'SNS topic encryption not required for demo alarm notifications.',
      },
      {
        id: 'AwsSolutions-SNS3',
        reason:
          'SNS topic does not require SSL enforcement for Lambda subscriptions in this demo.',
      },
    ]);
  }
}
