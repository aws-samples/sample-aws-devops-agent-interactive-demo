import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { AlarmStack } from '../lib/alarm-stack';

describe('AlarmStack', () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const stack = new AlarmStack(app, 'TestAlarmStack', {
      env: { account: '123456789012', region: 'us-east-1' },
      albFullName: 'app/test-alb/1234567890abcdef',
      albTargetGroupFullName:
        'targetgroup/test-tg/1234567890abcdef',
    });
    template = Template.fromStack(stack);
  });

  // ---------------------------------------------------------------------------
  // Requirement 5.1: Six CloudWatch alarms are created
  // ---------------------------------------------------------------------------
  describe('CloudWatch Alarms', () => {
    test('exactly 6 CloudWatch alarms are created', () => {
      template.resourceCountIs('AWS::CloudWatch::Alarm', 6);
    });

    test('4 custom metric alarms use namespace NetworkDevOpsDemo and metric ConnectivityFailure', () => {
      const checkTypes = ['rds', 'nat', 's3', 'bedrock'];
      for (const checkType of checkTypes) {
        template.hasResourceProperties('AWS::CloudWatch::Alarm', {
          Namespace: 'NetworkDevOpsDemo',
          MetricName: 'ConnectivityFailure',
          Dimensions: Match.arrayWith([
            Match.objectLike({
              Name: 'CheckType',
              Value: checkType,
            }),
          ]),
          Threshold: 0,
          ComparisonOperator: 'GreaterThanThreshold',
          EvaluationPeriods: 1,
          Period: 60,
        });
      }
    });

    test('ALB TLS alarm uses namespace AWS/ApplicationELB and metric ClientTLSNegotiationErrorCount', () => {
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        Namespace: 'AWS/ApplicationELB',
        MetricName: 'ClientTLSNegotiationErrorCount',
        Dimensions: Match.arrayWith([
          Match.objectLike({
            Name: 'LoadBalancer',
            Value: 'app/test-alb/1234567890abcdef',
          }),
        ]),
        Threshold: 0,
        ComparisonOperator: 'GreaterThanThreshold',
        EvaluationPeriods: 1,
        Period: 60,
      });
    });

    test('outbound-https alarm uses namespace NetworkDevOpsDemo and metric ConnectivityFailure', () => {
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        Namespace: 'NetworkDevOpsDemo',
        MetricName: 'ConnectivityFailure',
        Dimensions: Match.arrayWith([
          Match.objectLike({
            Name: 'CheckType',
            Value: 'outbound-https',
          }),
        ]),
        Threshold: 0,
        ComparisonOperator: 'GreaterThanThreshold',
        EvaluationPeriods: 1,
        Period: 60,
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Requirement 5.2: SNS topic with all alarm subscriptions
  // ---------------------------------------------------------------------------
  describe('SNS Topic', () => {
    test('SNS topic exists with name network-devops-demo-alarms', () => {
      template.hasResourceProperties('AWS::SNS::Topic', {
        TopicName: 'network-devops-demo-alarms',
      });
    });

    test('all 6 alarms have an alarm action targeting the SNS topic', () => {
      // Each alarm should have at least one AlarmActions entry
      const alarms = template.findResources('AWS::CloudWatch::Alarm');
      const alarmKeys = Object.keys(alarms);
      expect(alarmKeys).toHaveLength(6);

      for (const key of alarmKeys) {
        const props = alarms[key].Properties;
        expect(props.AlarmActions).toBeDefined();
        expect(props.AlarmActions.length).toBeGreaterThanOrEqual(1);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Requirement 5.3: Webhook Lambda
  // ---------------------------------------------------------------------------
  describe('Webhook Lambda', () => {
    test('webhook Lambda function exists with Node.js 20.x runtime', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        Runtime: 'nodejs20.x',
        Handler: 'index.handler',
      });
    });

    test('webhook Lambda has DynamoDB PutItem permission', () => {
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: 'dynamodb:PutItem',
              Effect: 'Allow',
            }),
          ]),
        },
      });
    });

    test('webhook Lambda is subscribed to the SNS topic', () => {
      template.hasResourceProperties('AWS::SNS::Subscription', {
        Protocol: 'lambda',
      });
    });
  });
});
