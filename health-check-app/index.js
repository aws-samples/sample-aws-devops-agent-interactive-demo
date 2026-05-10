'use strict';

const http = require('http');
const https = require('https');
const net = require('net');
const {
  CloudWatchClient,
  PutMetricDataCommand,
} = require('@aws-sdk/client-cloudwatch');
const { S3Client, HeadBucketCommand } = require('@aws-sdk/client-s3');
const {
  BedrockRuntimeClient,
  InvokeModelCommand,
} = require('@aws-sdk/client-bedrock-runtime');

// ---------------------------------------------------------------------------
// Configuration from environment variables
// ---------------------------------------------------------------------------
const RDS_ENDPOINT = process.env.RDS_ENDPOINT || '';
const S3_BUCKET_NAME = process.env.S3_BUCKET_NAME || '';
const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
const PORT = 80;

// ---------------------------------------------------------------------------
// AWS SDK v3 clients
// ---------------------------------------------------------------------------
const cwClient = new CloudWatchClient({ region: AWS_REGION });
const s3Client = new S3Client({ region: AWS_REGION });
const bedrockRuntimeClient = new BedrockRuntimeClient({ region: AWS_REGION, requestHandler: { requestTimeout: 8000 } });

// ---------------------------------------------------------------------------
// Track latest check results for the health endpoint
// ---------------------------------------------------------------------------
const checkStatus = {
  rds: { healthy: true, lastError: null, lastCheck: null },
  nat: { healthy: true, lastError: null, lastCheck: null },
  s3: { healthy: true, lastError: null, lastCheck: null },
  bedrock: { healthy: true, lastError: null, lastCheck: null },
  'outbound-https': { healthy: true, lastError: null, lastCheck: null },
};

// ---------------------------------------------------------------------------
// Publish a ConnectivityFailure metric to CloudWatch
// ---------------------------------------------------------------------------
async function publishFailureMetric(checkType, reason) {
  try {
    await cwClient.send(
      new PutMetricDataCommand({
        Namespace: 'DevOpsDemo',
        MetricData: [
          {
            MetricName: 'ConnectivityFailure',
            Dimensions: [
              { Name: 'CheckType', Value: checkType },
            ],
            Value: 1,
            Unit: 'Count',
            Timestamp: new Date(),
          },
        ],
      }),
    );
    console.log(
      `[metric] Published ConnectivityFailure for ${checkType}`,
    );
  } catch (err) {
    console.error(
      `[metric] Failed to publish metric for ${checkType}: ${err.message}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Check 1: RDS MySQL connectivity (TCP socket to port 3306) — every 5s
// ---------------------------------------------------------------------------
function checkRds() {
  if (!RDS_ENDPOINT) {
    console.log('[rds] RDS_ENDPOINT not set, skipping check');
    return;
  }

  const socket = net.createConnection({ host: RDS_ENDPOINT, port: 3306, timeout: 4000 });

  socket.on('connect', () => {
    checkStatus.rds = { healthy: true, lastError: null, lastCheck: new Date().toISOString() };
    socket.destroy();
  });

  socket.on('timeout', () => {
    const reason = 'ETIMEDOUT connecting to RDS on port 3306';
    console.error(`[rds] ${reason}`);
    checkStatus.rds = { healthy: false, lastError: reason, lastCheck: new Date().toISOString() };
    publishFailureMetric('rds', reason);
    socket.destroy();
  });

  socket.on('error', (err) => {
    const reason = `${err.code || err.message} connecting to RDS on port 3306`;
    console.error(`[rds] ${reason}`);
    checkStatus.rds = { healthy: false, lastError: reason, lastCheck: new Date().toISOString() };
    publishFailureMetric('rds', reason);
    socket.destroy();
  });
}

// ---------------------------------------------------------------------------
// Check 2: Outbound internet via NAT Gateway (https://aws.amazon.com) — every 15s
// ---------------------------------------------------------------------------
function checkNat() {
  const req = https.get('https://aws.amazon.com', { timeout: 10000 }, (res) => {
    checkStatus.nat = { healthy: true, lastError: null, lastCheck: new Date().toISOString() };
    res.resume(); // drain the response
  });

  req.on('timeout', () => {
    const reason = 'Timeout reaching https://aws.amazon.com via NAT Gateway';
    console.error(`[nat] ${reason}`);
    checkStatus.nat = { healthy: false, lastError: reason, lastCheck: new Date().toISOString() };
    publishFailureMetric('nat', reason);
    req.destroy();
  });

  req.on('error', (err) => {
    const reason = `${err.code || err.message} reaching https://aws.amazon.com`;
    console.error(`[nat] ${reason}`);
    checkStatus.nat = { healthy: false, lastError: reason, lastCheck: new Date().toISOString() };
    publishFailureMetric('nat', reason);
  });
}

// ---------------------------------------------------------------------------
// Check 3: S3 HeadBucket via VPC Gateway Endpoint — every 10s
// ---------------------------------------------------------------------------
async function checkS3() {
  if (!S3_BUCKET_NAME) {
    console.log('[s3] S3_BUCKET_NAME not set, skipping check');
    return;
  }

  try {
    await s3Client.send(new HeadBucketCommand({ Bucket: S3_BUCKET_NAME }));
    checkStatus.s3 = { healthy: true, lastError: null, lastCheck: new Date().toISOString() };
  } catch (err) {
    const reason = `${err.name || err.code || err.message} on HeadBucket for ${S3_BUCKET_NAME}`;
    console.error(`[s3] ${reason}`);
    checkStatus.s3 = { healthy: false, lastError: reason, lastCheck: new Date().toISOString() };
    await publishFailureMetric('s3', reason);
  }
}

// ---------------------------------------------------------------------------
// Check 4: Bedrock Runtime VPC Endpoint connectivity — every 10s
// Calls InvokeModel via the Bedrock Runtime VPC Interface Endpoint.
// When healthy, the API returns a validation error (model not found)
// which proves the endpoint is reachable. When scenario 4 removes the
// endpoint subnets, the call times out — a real VPC endpoint failure.
// ---------------------------------------------------------------------------
async function checkBedrock() {
  try {
    await bedrockRuntimeClient.send(new InvokeModelCommand({
      modelId: 'amazon.nova-2-lite-v1:0',
      contentType: 'application/json',
      body: Buffer.from('{}'),
    }));
    checkStatus.bedrock = { healthy: true, lastError: null, lastCheck: new Date().toISOString() };
  } catch (err) {
    const code = err.name || err.code || '';
    const msg = err.message || '';
    // Validation/auth errors mean the VPC endpoint IS reachable
    if (code === 'ValidationException' || code === 'AccessDeniedException' ||
        code === 'ResourceNotFoundException' || code === 'UnrecognizedClientException' ||
        msg.includes('not authorized') || msg.includes('not found') || msg.includes('validation')) {
      checkStatus.bedrock = { healthy: true, lastError: null, lastCheck: new Date().toISOString() };
    } else {
      // Timeout, network, DNS errors mean the VPC endpoint is broken
      const reason = `${code || msg} on Bedrock Runtime VPC Endpoint`;
      console.error(`[bedrock] ${reason}`);
      checkStatus.bedrock = { healthy: false, lastError: reason, lastCheck: new Date().toISOString() };
      await publishFailureMetric('bedrock', reason);
    }
  }
}

// ---------------------------------------------------------------------------
// Check 5: TLS verification on Location Service endpoint — every 10s
// Connects to the Amazon Location Service regional endpoint via VPC Interface
// Endpoint. When scenario 6 poisons /etc/hosts, this resolves to local nginx
// which has a cert for server.internal.lab — TLS handshake fails.
// ---------------------------------------------------------------------------
function checkCloudWatchTls() {
  const hostname = `maps.geo.${AWS_REGION}.amazonaws.com`;
  const req = https.get({ hostname, port: 443, path: '/', timeout: 8000, rejectUnauthorized: true }, (res) => {
    checkStatus['outbound-https'] = { healthy: true, lastError: null, lastCheck: new Date().toISOString() };
    res.resume();
  });

  req.on('timeout', () => {
    checkStatus['outbound-https'] = { healthy: true, lastError: 'timeout (not a TLS failure)', lastCheck: new Date().toISOString() };
    req.destroy();
  });

  req.on('error', (err) => {
    const msg = err.message || '';
    if (msg.includes('certificate') || msg.includes('self signed') || msg.includes('ERR_TLS') || msg.includes('CERT') || err.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || err.code === 'ERR_TLS_CERT_ALTNAME_INVALID' || err.code === 'DEPTH_ZERO_SELF_SIGNED_CERT') {
      const reason = `TLS verification failed for ${hostname}: ${err.code || msg}`;
      console.error(`[outbound-https] ${reason}`);
      checkStatus['outbound-https'] = { healthy: false, lastError: reason, lastCheck: new Date().toISOString() };
      publishFailureMetric('outbound-https', reason);
    } else {
      checkStatus['outbound-https'] = { healthy: true, lastError: `non-TLS error: ${err.code || msg}`, lastCheck: new Date().toISOString() };
    }
  });
}

// ---------------------------------------------------------------------------
// HTTP health check server — port 80, root path returns 200
// ---------------------------------------------------------------------------
const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        checks: checkStatus,
      }),
    );
  } else {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Health check app listening on port ${PORT}`);
  console.log(`  RDS_ENDPOINT:  ${RDS_ENDPOINT || '(not set)'}`);
  console.log(`  S3_BUCKET_NAME: ${S3_BUCKET_NAME || '(not set)'}`);
  console.log(`  AWS_REGION:     ${AWS_REGION}`);
});

// ---------------------------------------------------------------------------
// Start periodic checks
// ---------------------------------------------------------------------------
setInterval(checkRds, 5000);       // every 5 seconds
setInterval(checkNat, 15000);      // every 15 seconds
setInterval(checkS3, 10000);       // every 10 seconds
setInterval(checkBedrock, 10000);  // every 10 seconds
setInterval(checkCloudWatchTls, 10000); // every 10 seconds

// Run all checks immediately on startup
checkRds();
checkNat();
checkS3();
checkBedrock();
checkCloudWatchTls();
