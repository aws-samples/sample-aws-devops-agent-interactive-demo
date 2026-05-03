import * as cdk from 'aws-cdk-lib';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';
import * as path from 'path';

/**
 * Props passed from ComputeStack into TrafficGenStack.
 */
export interface TrafficGenStackProps extends cdk.StackProps {
  /** ALB public URL to send HTTPS traffic to. */
  readonly albUrl: string;
}

/**
 * TrafficGenStack — Lambda + EventBridge schedule (every 30s) hitting the ALB.
 *
 * Ensures ELB Access Logs and VPC Flow Logs have consistent traffic data.
 * When the ALB TLS policy is misconfigured (Scenario 5), the Lambda's TLS
 * negotiation failures naturally generate the ClientTLSNegotiationErrorCount
 * metric on the ALB.
 */
export class TrafficGenStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: TrafficGenStackProps) {
    super(scope, id, props);

    // -------------------------------------------------------------------
    // Traffic Generator Lambda (Task 6.1)
    // -------------------------------------------------------------------
    const trafficGeneratorFn = new NodejsFunction(this, 'TrafficGeneratorFn', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'handler',
      entry: path.join(__dirname, '..', 'lambda', 'traffic-generator', 'index.ts'),
      description: 'Makes HTTPS GET requests to the ALB every 30s for traffic generation',
      timeout: cdk.Duration.seconds(15),
      memorySize: 128,
      environment: {
        ALB_URL: props.albUrl,
      },
      logGroup: new logs.LogGroup(this, 'TrafficGenLogGroup', {
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
      bundling: {
        minify: true,
        sourceMap: true,
      },
    });

    // -------------------------------------------------------------------
    // EventBridge Schedule Rule — every 30 seconds (Task 6.1)
    // -------------------------------------------------------------------
    const scheduleRule = new events.Rule(this, 'TrafficScheduleRule', {
      description: 'Triggers traffic generator Lambda every 30 seconds',
      schedule: events.Schedule.rate(cdk.Duration.minutes(1)),
    });

    scheduleRule.addTarget(new targets.LambdaFunction(trafficGeneratorFn, {
      retryAttempts: 0,
    }));

    // -------------------------------------------------------------------
    // cdk-nag suppressions
    // -------------------------------------------------------------------
    NagSuppressions.addResourceSuppressions(
      trafficGeneratorFn,
      [
        {
          id: 'AwsSolutions-IAM4',
          reason: 'Lambda basic execution role uses AWSLambdaBasicExecutionRole managed policy.',
        },
        {
          id: 'AwsSolutions-IAM5',
          reason: 'Lambda log group ARN uses wildcard for log stream.',
        },
        {
          id: 'AwsSolutions-L1',
          reason: 'Node.js 20.x is the target runtime for this demo; upgrading may break compatibility.',
        },
      ],
      true,
    );

    // -------------------------------------------------------------------
    // CfnOutputs
    // -------------------------------------------------------------------
    new cdk.CfnOutput(this, 'TrafficGeneratorFunctionArn', {
      value: trafficGeneratorFn.functionArn,
      description: 'Traffic Generator Lambda function ARN',
    });
  }
}
