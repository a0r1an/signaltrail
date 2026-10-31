import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { openBatchTransport } from '../../packages/browser-sdk/dist/index.js';

export async function exerciseRequestAdmission({ url, publisher, runId }) {
  const sdk = await openBatchTransport(
    { ingestionUrl: url, projectKey: 'load-test-key' },
    { queue: { random: () => 0 } },
  );
  let held;
  const slowResponse = new Promise((resolve, reject) => {
    held = httpRequest(
      url,
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': '2' } },
      (response) => {
        response.resume();
        response.once('end', () => resolve(response.statusCode));
      },
    );
    held.once('error', reject);
    held.write('{');
  });
  void slowResponse.catch(() => {});
  try {
    const deadline = Date.now() + 3000;
    let observedActive = false;
    while (Date.now() < deadline) {
      const metrics = await fetch('http://127.0.0.1:9465/metrics', {
        signal: AbortSignal.timeout(1000),
      });
      const text = await metrics.text();
      if (/^signaltrail_http_active_requests 1$/m.test(text)) {
        observedActive = true;
        break;
      }
      await delay(20);
    }
    assert.ok(observedActive, 'Slow body must occupy the request-processing slot');
    assert.equal(
      publisher.snapshot().outstandingEvents,
      0,
      'No broker work has been admitted for an incomplete body',
    );
    const event = {
      schemaVersion: 1,
      eventId: runId + '-retained',
      eventName: 'request_admission',
      distinctId: 'visitor',
      sessionId: 'session',
      sequence: 0,
      clientTimestamp: new Date().toISOString(),
      url: 'https://load.invalid',
      properties: {},
      context: { sdkVersion: 'admission-test' },
    };
    await sdk.queue.enqueue(event);
    assert.deepEqual(await sdk.flush(), {
      status: 'retry_scheduled',
      reason: 'server',
      httpStatus: 503,
    });
    assert.deepEqual(
      (await sdk.queue.getAll()).events.map((entry) => entry.eventId),
      [event.eventId],
    );
    assert.equal(publisher.snapshot().completed, 0);
    held.end('}');
    assert.equal(await slowResponse, 401);
    const retryDeadline = Date.now() + 5000;
    while (Date.now() < retryDeadline && (await sdk.queue.getAll()).events.length) {
      await sdk.flush();
      await delay(50);
    }
    assert.equal((await sdk.queue.getAll()).events.length, 0);
    assert.equal(publisher.snapshot().completed, 1);
    assert.equal((await sdk.getHealth()).counters.accepted, 1);
    const metrics = await fetch('http://127.0.0.1:9465/metrics', {
      signal: AbortSignal.timeout(1000),
    });
    const text = await metrics.text();
    assert.match(text, /^signaltrail_http_active_requests 0$/m);
    assert.match(text, /^signaltrail_http_admission_refused_total 1$/m);
    return {
      passed: true,
      observedSlowBodyAdmission: true,
      refusedBeforeBrokerWork: true,
      retainedEventId: event.eventId,
      recoveredAcknowledgedEvents: 1,
      finalActiveRequests: 0,
      limitation:
        'One owned slow HTTP upload with Node SDK memory fallback; not a browser or connection-flood test.',
    };
  } finally {
    held?.destroy();
    sdk.close();
  }
}
