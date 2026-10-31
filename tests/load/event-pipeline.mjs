import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import {
  createRedpandaEventConsumer,
  createClickHouseWriter,
} from '../../workers/event-processor/dist/index.js';
import { cleanupResources } from './cleanup.mjs';
const { Kafka, logLevel } = createRequire(
  new URL('../../apps/ingestion/package.json', import.meta.url),
)('kafkajs');
const topic = 'signaltrail.analytics.v1';

async function query(sql) {
  const response = await fetch('http://127.0.0.1:38123/?wait_end_of_query=1', {
    method: 'POST',
    headers: { 'X-ClickHouse-User': 'signaltrail', 'X-ClickHouse-Key': 'signaltrail_local' },
    body: sql,
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`ClickHouse probe failed with HTTP ${response.status}`);
  }
  return response.text();
}

export async function exerciseEventPipeline({ url, runId, docker }) {
  const kafka = new Kafka({
    brokers: ['127.0.0.1:29092'],
    clientId: runId,
    logLevel: logLevel.ERROR,
    retry: { retries: 2 },
  });
  const admin = kafka.admin();
  const producer = kafka.producer({ allowAutoTopicCreation: false });
  let worker;
  const dlqConsumer = kafka.consumer({
    groupId: runId + '-dlq',
    sessionTimeout: 6000,
    heartbeatInterval: 1000,
  });
  const deadLetterTopic = 'signaltrail.analytics.dlq.v1';
  const outcomes = [];
  const letters = [];
  let storagePaused = false;
  let processingError;
  let probeError;
  const waitFor = async (check, message) => {
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      if (processingError) throw processingError;
      if (check()) return;
      await delay(100);
    }
    throw new Error(message);
  };
  try {
    await query(
      await readFile(
        new URL('../../infra/clickhouse/001-analytics-events.sql', import.meta.url),
        'utf8',
      ),
    );
    assert.equal(
      Number(await query('SELECT count() FROM signaltrail.analytics_events')),
      0,
      'Pipeline probe requires empty isolated storage',
    );
    await admin.connect();
    await admin.createTopics({
      waitForLeaders: true,
      topics: [
        {
          topic: deadLetterTopic,
          numPartitions: 1,
          replicationFactor: 1,
          configEntries: [{ name: 'write.caching', value: 'false' }],
        },
      ],
    });
    await producer.connect();
    worker = createRedpandaEventConsumer({
      brokers: ['127.0.0.1:29092'],
      topic,
      deadLetterTopic,
      groupId: runId,
      writeEvent: createClickHouseWriter({
        endpoint: 'http://127.0.0.1:38123',
        username: 'signaltrail',
        password: 'signaltrail_local',
      }),
      onProcessed: (status) => outcomes.push({ status }),
    });
    void worker.finished.catch((error) => {
      processingError = error;
    });
    const event = {
      schemaVersion: 1,
      eventId: 'pipeline-repeated',
      eventName: 'view',
      distinctId: 'visitor',
      sessionId: 'session',
      sequence: 0,
      clientTimestamp: '9999-01-01T00:00:00.000Z',
      url: 'https://pipeline.invalid',
      properties: { productId: '123' },
      context: { sdkVersion: 'pipeline-test' },
    };
    const ingest = async (key, events) => {
      const response = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ events }),
        signal: AbortSignal.timeout(10000),
      });
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.ok(result.results.every((item) => item.status === 'accepted'));
    };
    await docker(['pause', 'clickhouse']);
    storagePaused = true;
    await ingest('load-test-key', [
      event,
      event,
      { ...event, eventId: 'pipeline-second', sequence: 1 },
    ]);
    await ingest('pipeline-other-key', [event]);
    assert.equal(outcomes.length, 0);
    await docker(['unpause', 'clickhouse']);
    storagePaused = false;
    await worker.start();
    await producer.send({ topic, acks: -1, messages: [{ value: '{invalid-json' }] });
    await waitFor(
      () => outcomes.length === 5,
      'Processor did not acknowledge all pipeline messages',
    );
    assert.equal(outcomes.filter((outcome) => outcome.status === 'stored').length, 4);
    assert.equal(outcomes.filter((outcome) => outcome.status === 'dead_lettered').length, 1);
    const rows = (
      await query(
        'SELECT project_id, event_id, client_timestamp FROM signaltrail.analytics_events FINAL ORDER BY project_id, event_id FORMAT JSONEachRow',
      )
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      rows.map((row) => [row.project_id, row.event_id]),
      [
        ['load-other-project', 'pipeline-repeated'],
        ['load-project', 'pipeline-repeated'],
        ['load-project', 'pipeline-second'],
      ],
    );
    assert.ok(rows.every((row) => row.client_timestamp === event.clientTimestamp));
    const offsets = await admin.fetchOffsets({ groupId: runId, topics: [topic] });
    for (const { partition, offset } of await admin.fetchTopicOffsets(topic)) {
      if (BigInt(offset) > 0n)
        assert.equal(
          offsets[0].partitions.find((entry) => entry.partition === partition)?.offset,
          offset,
        );
    }
    await dlqConsumer.connect();
    await dlqConsumer.subscribe({ topic: deadLetterTopic, fromBeginning: true });
    await dlqConsumer.run({
      autoCommit: false,
      eachMessage: async ({ message }) => {
        letters.push(JSON.parse(message.value.toString()));
      },
    });
    await waitFor(() => letters.length === 1, 'Acknowledged dead-letter record was missing');
    assert.equal(letters[0].reason, 'INVALID_JSON');
    assert.equal(Buffer.from(letters[0].payloadBase64, 'base64').toString(), '{invalid-json');
    return {
      passed: true,
      ingestedWhileStoragePaused: 4,
      outcomes,
      rows,
      committed: Object.fromEntries(
        offsets[0].partitions
          .filter((entry) => entry.offset !== '-1')
          .map((entry) => [entry.partition, entry.offset]),
      ),
      deadLetters: letters.length,
      limitations: [
        'Small isolated correctness probe, not throughput or production sizing.',
        'Unique reads use FINAL; background replacement is eventual.',
        'No query API or retention policy is deployed.',
      ],
    };
  } catch (error) {
    probeError = error;
    throw error;
  } finally {
    try {
      await cleanupResources([
        {
          name: 'resume isolated storage',
          run: (signal) =>
            storagePaused ? docker(['unpause', 'clickhouse'], false, false, signal) : undefined,
        },
        { name: 'stop pipeline consumer', run: () => worker?.close() },
        { name: 'stop dead-letter observer', run: () => dlqConsumer.disconnect() },
        { name: 'stop pipeline producer', run: () => producer.disconnect() },
        { name: 'stop pipeline admin', run: () => admin.disconnect() },
      ]);
    } catch (cleanupError) {
      if (probeError)
        throw new AggregateError([probeError, cleanupError], 'Pipeline probe and cleanup failed');
      throw cleanupError;
    }
  }
}
