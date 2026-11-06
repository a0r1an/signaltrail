import { readFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { openAutomaticDelivery } from '../packages/browser-sdk/dist/index.js';
import { createAnalyticsReader } from '../packages/analytics/dist/index.js';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let delivery;
try {
  if (process.argv.length !== 2) throw new Error();
  const state = JSON.parse(
    await readFile(join(root, '.local-data/dashboard-local-setup.json'), 'utf8'),
  );
  const eventId = randomUUID(),
    now = new Date();
  let acknowledged = false;
  delivery = await openAutomaticDelivery(
    { projectKey: state.publicKey, ingestionUrl: 'http://127.0.0.1:4102/v1/events' },
    {
      onEventAccepted: (event) => {
        if (event.eventId === eventId) acknowledged = true;
      },
    },
  );
  const result = await delivery.enqueue(
    {
      schemaVersion: 1,
      eventId,
      eventName: 'local_pipeline_probe',
      distinctId: 'local-cli-probe',
      sessionId: 'local-cli-probe',
      sequence: 0,
      clientTimestamp: now.toISOString(),
      url: 'http://localhost:3001/',
      properties: { source: 'command-line verification' },
      context: { sdkVersion: '0.1.0' },
    },
    { sendImmediately: true },
  );
  if (result.status !== 'queued') throw new Error();
  const reader = createAnalyticsReader({
    endpoint: 'http://127.0.0.1:8123',
    username: state.readerName,
    password: state.chPassword,
  });
  const window = {
    projectId: state.projectId,
    from: new Date(now.getTime() - 60000).toISOString(),
    to: new Date(now.getTime() + 60000).toISOString(),
    eventName: 'local_pipeline_probe',
  };
  let stored = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    if (!acknowledged) await delivery.flush();
    const page = await reader.listOccurredEvents(window);
    stored = page.events.some((event) => event.eventId === eventId);
    if (acknowledged && stored) break;
    await delay(500);
  }
  if (!acknowledged || !stored) throw new Error();
  const parent = join(root, 'test-results/local-pipeline');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, 'probe-'));
  const report = {
    passed: true,
    eventId,
    eventName: 'local_pipeline_probe',
    sdkAcknowledged: true,
    storedEventVerified: true,
    browserCaptureVerified: false,
    limitation:
      'One labeled command-line probe event remains in the local project. This is not browser capture or production capacity evidence.',
  };
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
  console.log(JSON.stringify({ directory, ...report }, null, 2));
} catch {
  console.error(
    'Local pipeline probe was not confirmed. A labeled local_pipeline_probe event may have been accepted; no credentials printed.',
  );
  process.exitCode = 1;
} finally {
  delivery?.close();
}
