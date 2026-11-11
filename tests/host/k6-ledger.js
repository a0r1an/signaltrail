// One singleton event per request (the browser SDK's pattern at low rates). Every
// event's outcome is logged as a JSON line: the generator-side acceptance ledger.
import http from 'k6/http';
import execution from 'k6/execution';
import { Counter } from 'k6/metrics';
const accepted = new Counter('events_accepted');
const retry = new Counter('events_retry');
const rejected = new Counter('events_rejected');
const transportErrors = new Counter('transport_errors');

export const options = {
  scenarios: {
    traffic: {
      executor: 'constant-arrival-rate',
      rate: Number(__ENV.RATE),
      timeUnit: '1s',
      duration: __ENV.DURATION,
      preAllocatedVUs: Number(__ENV.VUS || 50),
      maxVUs: Number(__ENV.VUS || 50) * 4,
    },
  },
  summaryTrendStats: ['avg', 'p(50)', 'p(95)', 'p(99)', 'max'],
};

export default function () {
  const id = `${__ENV.PREFIX}-${execution.scenario.iterationInTest}`;
  const session = execution.scenario.iterationInTest % 100;
  const response = http.post(
    __ENV.TARGET,
    JSON.stringify({
      events: [
        {
          schemaVersion: 1,
          eventId: id,
          eventName: 'remote_load',
          distinctId: `visitor-${session}`,
          sessionId: `session-${session}`,
          sequence: execution.scenario.iterationInTest,
          clientTimestamp: new Date().toISOString(),
          url: 'https://load.invalid/',
          properties: {},
          context: { sdkVersion: 'remote-load' },
        },
      ],
    }),
    {
      headers: { 'content-type': 'application/json', authorization: `Bearer ${__ENV.KEY}` },
      timeout: '10s',
    },
  );
  let status = 'transport_error';
  try {
    const result = response.status === 200 ? response.json().results[0] : undefined;
    if (result && ['accepted', 'retry', 'rejected'].includes(result.status)) status = result.status;
  } catch {
    /* Non-JSON responses stay transport errors. */
  }
  ({ accepted, retry, rejected, transport_error: transportErrors })[status].add(1);
  console.log(JSON.stringify({ id, status }));
}

export function handleSummary(data) {
  return { stdout: JSON.stringify(data) };
}
