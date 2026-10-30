import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { cleanupResources } from './cleanup.mjs';
import { openBatchTransport } from '../../packages/browser-sdk/dist/index.js';
// Resolve the same Kafka client version used by ingestion, without a second installation.
const { Kafka, logLevel } = createRequire(
  new URL('../../apps/ingestion/package.json', import.meta.url),
)('kafkajs');

async function until(check, message, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(100);
  }
  throw new Error(message);
}

// This probe owns only the isolated signaltrail-load broker created by run.mjs.
export async function exerciseBrokerRecovery({ url, publisher, docker, runId }) {
  const captured = new Date().toISOString();
  const events = Array.from({ length: 6 }, (_, index) => ({
    schemaVersion: 1,
    eventId: `${runId}-${index}`,
    eventName: 'broker_recovery',
    distinctId: 'recovery-visitor',
    sessionId: 'recovery-session',
    sequence: index,
    clientTimestamp: captured,
    url: 'https://load.invalid/recovery',
    properties: {},
    context: { sdkVersion: 'recovery-test' },
  }));
  const responses = [];
  const sdk = await openBatchTransport(
    { ingestionUrl: url, projectKey: 'load-test-key' },
    {
      queue: { random: () => 0 },
      fetch: async (...args) => {
        const response = await fetch(...args);
        responses.push(await response.clone().json());
        return response;
      },
    },
  );
  const kafka = new Kafka({
    brokers: ['127.0.0.1:29092'],
    clientId: 'signaltrail-recovery-observer',
    logLevel: logLevel.ERROR,
    connectionTimeout: 1000,
    requestTimeout: 3000,
    retry: { retries: 2 },
  });
  const consumer = kafka.consumer({
    groupId: runId,
    sessionTimeout: 6000,
    heartbeatInterval: 1000,
  });
  const observed = new Set();
  let paused = false;
  let probeError;
  try {
    await sdk.queue.enqueue(events[0]);
    assert.equal((await sdk.flush()).status, 'applied');
    assert.equal((await sdk.getHealth()).counters.accepted, 1);
    await docker(['pause', 'redpanda']);
    paused = true;
    const start = responses.length;
    for (const event of events.slice(1, 3)) await sdk.queue.enqueue(event);
    await sdk.flush();
    const duringPause = publisher.snapshot();
    assert.equal(
      duringPause.outstandingEvents,
      2,
      'HTTP timeout must not release underlying sends',
    );
    await sdk.queue.enqueue(events[3]);
    await sdk.flush();
    const pausedResponses = responses.slice(start);
    assert.ok(pausedResponses.length >= 2);
    assert.ok(
      pausedResponses.every((response) =>
        response.results.every((result) => result.status === 'retry'),
      ),
      'A paused broker must not produce accepted responses',
    );
    assert.deepEqual(
      (await sdk.queue.getAll()).events.map((event) => event.eventId),
      events.slice(1, 4).map((event) => event.eventId),
    );
    assert.ok(publisher.snapshot().refused > 0, 'Occupied slots must reject excess publication');
    await docker(['unpause', 'redpanda']);
    paused = false;
    await until(
      () => publisher.snapshot().outstandingEvents === 0,
      'Underlying publications did not settle after broker recovery',
    );
    await until(async () => {
      await sdk.flush();
      return (await sdk.queue.getAll()).events.length === 0;
    }, 'SDK did not drain after broker recovery');
    // Keep a second interruption long enough to exhaust real Kafka request retries.
    await docker(['pause', 'redpanda']);
    paused = true;
    const beforeOutage = publisher.snapshot();
    for (const event of events.slice(4)) await sdk.queue.enqueue(event);
    await sdk.flush();
    await until(
      () => publisher.snapshot().failed >= beforeOutage.failed + 2,
      'Paused broker did not exhaust publication retries',
      30000,
    );
    const exhausted = publisher.snapshot();
    assert.equal(exhausted.outstandingEvents, 0);
    assert.deepEqual(
      (await sdk.queue.getAll()).events.map((event) => event.eventId),
      events.slice(4).map((event) => event.eventId),
    );
    assert.equal((await sdk.getHealth()).counters.accepted, 4);
    await docker(['unpause', 'redpanda']);
    paused = false;
    await until(
      async () => {
        await sdk.flush();
        return (await sdk.queue.getAll()).events.length === 0;
      },
      'SDK did not recover after exhausted broker retries',
      30000,
    );
    const health = await sdk.getHealth();
    assert.equal(health.counters.accepted, events.length);
    assert.ok(health.counters.retryEvents >= 3);
    assert.equal(publisher.snapshot().outstandingEvents, 0);
    // Read actual records, allowing duplicates from sends acknowledged after the HTTP deadline.
    await consumer.connect();
    await consumer.subscribe({ topic: 'signaltrail.analytics.v1', fromBeginning: true });
    await consumer.run({
      eachMessage: async ({ message }) => {
        const record = JSON.parse(message.value.toString());
        assert.equal(record.projectId, 'load-project');
        observed.add(record.event.eventId);
      },
    });
    await until(
      () => events.every((event) => observed.has(event.eventId)),
      'Acknowledged IDs were missing from Redpanda',
    );
    return {
      passed: true,
      duringPause,
      exhausted,
      final: publisher.snapshot(),
      health,
      originalIds: events.map((event) => event.eventId),
      observedIds: [...observed],
      pausedResponses,
    };
  } catch (error) {
    probeError = error;
    throw error;
  } finally {
    // Resume before shutdown: a paused broker cannot drain its publisher.
    try {
      await cleanupResources([
        {
          name: 'resume isolated broker',
          run: (signal) =>
            paused ? docker(['unpause', 'redpanda'], false, false, signal) : undefined,
        },
        { name: 'close recovery SDK', run: () => sdk.close() },
        { name: 'disconnect recovery observer', run: () => consumer.disconnect() },
      ]);
    } catch (cleanupError) {
      if (probeError)
        throw new AggregateError(
          [probeError, cleanupError],
          'Recovery probe and cleanup both failed',
        );
      throw cleanupError;
    }
  }
}
