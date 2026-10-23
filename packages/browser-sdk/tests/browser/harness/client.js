import { openAutomaticDelivery } from '/sdk.js';

const params = new URLSearchParams(location.search);
const scenario = params.get('scenario') || crypto.randomUUID();
if (!params.has('scenario')) {
  params.set('scenario', scenario);
  history.replaceState(null, '', `/?${params}`);
}
const interval = Number(params.get('interval') || 2000);
const log = (value) => {
  document.querySelector('[aria-label="Delivery log"]').textContent += `${JSON.stringify(value)}\n`;
};
const delivery = await openAutomaticDelivery(
  {
    projectKey: params.get('real') === '1' ? `harness-real-${scenario}` : 'harness-project',
    ingestionUrl:
      params.get('real') === '1'
        ? 'http://127.0.0.1:4178/v1/events'
        : `${location.origin}/ingest/${scenario}`,
  },
  {
    flushIntervalMs: interval,
    onEventDropped: log,
    ...(params.get('telemetry') === '1' ? { telemetry: { enabled: true, sampleRate: 1 } } : {}),
  },
);
let sequence = 0;
let lastId;
function event(extra = {}) {
  lastId = crypto.randomUUID();
  return {
    schemaVersion: 1,
    eventId: lastId,
    eventName: 'harness_event',
    distinctId: 'harness-visitor',
    sessionId: 'harness-session',
    sequence: sequence++,
    clientTimestamp: new Date().toISOString(),
    url: location.href,
    properties: {},
    context: { sdkVersion: 'harness' },
    ...extra,
  };
}
async function refresh() {
  const queue = await delivery.getAll();
  document.querySelector('[aria-label="Queue"]').textContent = JSON.stringify(
    queue.status === 'read' ? queue.events.map((event) => event.eventId) : queue,
  );
  const state = await fetch(`/control/${scenario}`).then((response) => response.json());
  document.querySelector('[aria-label="Received events"]').textContent = JSON.stringify(
    state.requests,
  );
}
async function capture({ immediate = false, oversized = false } = {}) {
  const captured = event(oversized ? { properties: { text: 'x'.repeat(256 * 1024) } } : {});
  const result = await delivery.enqueue(captured, { sendImmediately: immediate });
  log(result);
  await refresh();
  return { ...result, eventId: captured.eventId };
}
window.harness = {
  delivery,
  capture,
  refresh,
  scenario,
  get lastId() {
    return lastId;
  },
};
document.querySelector('#event').onclick = () => {
  void capture().catch(log);
};
document.querySelector('#immediate').onclick = () => {
  void capture({ immediate: true }).catch(log);
};
document.querySelector('#oversized').onclick = () => {
  void capture({ oversized: true }).catch(log);
};
document.querySelector('#burst').onclick = () => {
  void (async () => {
    for (let i = 0; i < 100; i++) await capture();
  })().catch(log);
};
document.querySelector('#flush').onclick = () => {
  void delivery.flush().then(log).catch(log);
};
document.querySelector('#configure').onclick = () => {
  void fetch(`/control/${scenario}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      status: Number(document.querySelector('#status').value),
      delayMs: Number(document.querySelector('#delay').value),
    }),
  })
    .then(refresh)
    .catch(log);
};
await refresh();
document.querySelector('#capture').disabled = false;
// Keep this running through pagehide: a real departure must exercise SDK listeners.
setInterval(() => {
  void refresh().catch(log);
}, 200);
