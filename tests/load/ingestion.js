import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';
const accepted = new Counter('events_accepted');
const retry = new Counter('events_retry');
const rejected = new Counter('events_rejected');
const malformed = new Counter('responses_malformed');
const batchSize = Number(__ENV.BATCH_SIZE || 20);
const rate = Number(__ENV.RATE || 10);
export const options = {
  scenarios: {
    traffic: {
      executor: 'constant-arrival-rate',
      rate,
      timeUnit: '1s',
      duration: __ENV.DURATION || '15s',
      preAllocatedVUs: 250,
      maxVUs: 500,
    },
  },
  thresholds: {
    http_req_failed: ['rate==0'],
    responses_malformed: ['count==0'],
    events_rejected: ['count==0'],
    dropped_iterations: ['count==0'],
  },
};
export default function () {
  // Separate sessions distribute load; IDs remain unique across VUs and iterations.
  const events = Array.from({ length: batchSize }, (_, i) => ({
    schemaVersion: 1,
    eventId: `${__ENV.RUN_ID}-${__VU}-${__ITER}-${i}`,
    eventName: 'load_event',
    distinctId: `load-${__VU}`,
    sessionId: `session-${__VU}`,
    sequence: __ITER * batchSize + i,
    clientTimestamp: new Date().toISOString(),
    url: 'https://load.invalid',
    properties: { padding: 'x'.repeat(Number(__ENV.PADDING_BYTES || 0)) },
    context: { sdkVersion: 'load-test' },
  }));
  const response = http.post(__ENV.TARGET, JSON.stringify({ events }), {
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer load-test-key' },
    timeout: '10s',
  });
  let valid = false;
  try {
    const results = response.json().results;
    valid =
      Array.isArray(results) &&
      results.length === events.length &&
      results.every(
        (r, i) =>
          r.index === i &&
          ['accepted', 'retry', 'rejected'].includes(r.status) &&
          (r.status === 'rejected' || r.eventId === events[i].eventId),
      );
    if (valid)
      for (const result of results) {
        if (result.status === 'accepted') accepted.add(1);
        else if (result.status === 'retry') retry.add(1);
        else rejected.add(1);
      }
  } catch {
    /* Count malformed responses below, including non-JSON errors. */
  }
  malformed.add(valid ? 0 : 1);
  rejected.add(0);
  retry.add(0);
  accepted.add(0);
  check(response, { 'complete event outcomes': () => valid });
}
export function handleSummary(data) {
  return { stdout: JSON.stringify(data, null, 2) + '\n' };
}
