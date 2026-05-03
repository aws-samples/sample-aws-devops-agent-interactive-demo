import http from 'http';
import https from 'https';

/**
 * Traffic Generator Lambda — makes HTTP/HTTPS GET requests to the ALB endpoint.
 *
 * Triggered every ~1 minute by EventBridge schedule rule.
 * Ensures ELB Access Logs and VPC Flow Logs have consistent traffic data.
 *
 * When the ALB TLS security policy is misconfigured (Scenario 5),
 * TLS negotiation failures naturally increment the ALB
 * ClientTLSNegotiationErrorCount metric.
 */
export const handler = async (): Promise<void> => {
  const albUrl = process.env.ALB_URL;
  if (!albUrl) {
    console.error('ALB_URL environment variable is not set');
    return;
  }

  console.log(`Making GET request to ${albUrl}`);

  try {
    const statusCode = await makeRequest(albUrl);
    console.log(`Response status code: ${statusCode}`);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Request failed: ${message}`);
  }
};

/**
 * Makes an HTTP or HTTPS GET request and returns the status code.
 * Automatically selects the right module based on the URL protocol.
 */
function makeRequest(url: string): Promise<number> {
  const client = url.startsWith('https') ? https : http;
  return new Promise((resolve, reject) => {
    const req = client.get(
      url,
      {
        timeout: 10_000,
      },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );

    req.on('error', (err) => {
      reject(err);
    });

    req.on('timeout', () => {
      req.destroy(new Error('Request timed out after 10 seconds'));
    });
  });
}
