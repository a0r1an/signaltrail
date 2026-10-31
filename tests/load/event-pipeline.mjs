import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import {
  createRedpandaEventConsumer,
  createClickHouseWriter,
  createClickHouseBatchWriter,
} from '../../workers/event-processor/dist/index.js';
import { cleanupResources } from './cleanup.mjs';
import { startWorkerProcess } from './worker-process.mjs';
import { openInsertResponseGate } from './insert-response-gate.mjs';
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

export async function exerciseEventPipeline({ url, runId, docker, browser = false, directory }) {
  const kafka = new Kafka({
    brokers: ['127.0.0.1:29092'],
    clientId: runId,
    logLevel: logLevel.ERROR,
    retry: { retries: 2 },
  });
  const admin = kafka.admin();
  const producer = kafka.producer({ allowAutoTopicCreation: false });
  let worker;
  let workerProcess;
  let responseGate;
  const dlqConsumer = kafka.consumer({
    groupId: runId + '-dlq',
    sessionTimeout: 6000,
    heartbeatInterval: 1000,
  });
  const deadLetterTopic = 'signaltrail.analytics.dlq.v1';
  const outcomes = [];
  const insertSizes = [];
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
  const waitForCommitted = async (highOffsets) => {
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      const current = await admin.fetchOffsets({ groupId: runId, topics: [topic] });
      if (
        highOffsets.every(
          ({ partition, offset }) =>
            BigInt(offset) === 0n ||
            current[0].partitions.find((entry) => entry.partition === partition)?.offset === offset,
        )
      )
        return current;
      await delay(100);
    }
    throw new Error('Replacement worker did not acknowledge retained source records');
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
      writeEvents: async (records) => {
        await createClickHouseBatchWriter({
          endpoint: 'http://127.0.0.1:38123',
          username: 'signaltrail',
          password: 'signaltrail_local',
        })(records);
        insertSizes.push(records.length);
      },
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
    const firstBulkInsert = insertSizes.length;
    const bulkStarted = performance.now();
    await producer.send({
      topic,
      acks: -1,
      messages: Array.from({ length: 205 }, (_, index) => ({
        partition: 0,
        value: JSON.stringify({
          projectId: 'load-project',
          receivedAt: new Date().toISOString(),
          event: { ...event, eventId: `pipeline-bulk-${index}`, sequence: index },
        }),
      })),
    });
    await waitFor(
      () => outcomes.length === 210,
      'Processor did not complete the bounded bulk probe',
    );
    await waitForCommitted(await admin.fetchTopicOffsets(topic));
    const bulkInsertSizes = insertSizes.slice(firstBulkInsert);
    assert.equal(
      bulkInsertSizes.reduce((total, count) => total + count, 0),
      205,
    );
    assert.ok(bulkInsertSizes.every((count) => count > 0 && count <= 100));
    assert.ok(bulkInsertSizes.length < 205, 'Bulk records must share storage requests');
    assert.equal(
      Number(
        await query(
          "SELECT count() FROM signaltrail.analytics_events FINAL WHERE startsWith(event_id, 'pipeline-bulk-')",
        ),
      ),
      205,
    );
    const boundedBulk = {
      events: 205,
      recordsPerInsert: bulkInsertSizes,
      elapsedSeconds: (performance.now() - bulkStarted) / 1000,
      limitation: 'Small local correctness sample, not sustained throughput or production sizing.',
    };
    await worker.close();
    workerProcess = startWorkerProcess({
      groupId: runId,
      topic,
      deadLetterTopic,
      metricsPort: 9466,
    });
    await workerProcess.waitFor('SignalTrail event processor started');
    await docker(['pause', 'clickhouse']);
    storagePaused = true;
    await ingest('load-test-key', [{ ...event, eventId: 'pipeline-recovery', sequence: 2 }]);
    await workerProcess.waitFor('SignalTrail event processor retry scheduled');
    const stalledMetrics = await fetch('http://127.0.0.1:9466/metrics', {
      signal: AbortSignal.timeout(2000),
    });
    assert.equal(stalledMetrics.status, 200);
    const stalledBody = await stalledMetrics.text();
    assert.match(stalledBody, /signaltrail_processor_running 1/);
    assert.match(stalledBody, /signaltrail_processor_retries_total [1-9]/);
    assert.match(stalledBody, /signaltrail_processor_stored_total 0/);
    assert.match(
      stalledBody,
      /signaltrail_processor_attempt_duration_seconds_count\{outcome="failed"\} [1-9]/,
    );
    assert.ok(!stalledBody.includes('pipeline-recovery'));

    const highOffsets = await admin.fetchTopicOffsets(topic);
    const pendingOffsets = await admin.fetchOffsets({ groupId: runId, topics: [topic] });
    assert.ok(
      highOffsets.some(({ partition, offset }) => {
        const committed =
          pendingOffsets[0].partitions.find((entry) => entry.partition === partition)?.offset ??
          '-1';
        return BigInt(committed) < BigInt(offset);
      }),
      'Failed storage write must leave an uncommitted source record',
    );
    assert.equal((await workerProcess.stop('SIGKILL')).signal, 'SIGKILL');
    await docker(['unpause', 'clickhouse']);
    storagePaused = false;
    workerProcess = startWorkerProcess({
      groupId: runId,
      topic,
      deadLetterTopic,
      metricsPort: 9466,
    });
    await workerProcess.waitFor('SignalTrail event processor started');
    const recoveredOffsets = await waitForCommitted(highOffsets);
    assert.equal(
      Number(
        await query(
          "SELECT count() FROM signaltrail.analytics_events FINAL WHERE project_id = 'load-project' AND event_id = 'pipeline-recovery'",
        ),
      ),
      1,
    );
    const recoveredMetrics = await fetch('http://127.0.0.1:9466/metrics', {
      signal: AbortSignal.timeout(2000),
    });
    assert.equal(recoveredMetrics.status, 200);
    const recoveredBody = await recoveredMetrics.text();
    assert.match(recoveredBody, /signaltrail_processor_stored_total 1/);
    assert.match(
      recoveredBody,
      /signaltrail_processor_attempt_duration_seconds_count\{outcome="stored"\} 1/,
    );
    const unknownMetricsPath = await fetch('http://127.0.0.1:9466/events', {
      signal: AbortSignal.timeout(2000),
    });
    assert.equal(unknownMetricsPath.status, 404);
    assert.equal((await workerProcess.stop()).code, 0);
    await ingest('load-test-key', [
      { ...event, eventId: 'pipeline-lost-ack', sequence: 3 },
      { ...event, eventId: 'pipeline-lost-ack', sequence: 3 },
    ]);
    responseGate = await openInsertResponseGate();
    workerProcess = startWorkerProcess({
      groupId: runId,
      topic,
      deadLetterTopic,
      clickhouseUrl: responseGate.endpoint,
      timeoutMs: 30000,
    });
    await workerProcess.waitFor('SignalTrail event processor started');
    await responseGate.waitForStored();
    assert.deepEqual(responseGate.rowCounts, [2], 'Retained source records must share one insert');
    assert.equal(
      Number(
        await query(
          "SELECT count() FROM signaltrail.analytics_events FINAL WHERE project_id = 'load-project' AND event_id = 'pipeline-lost-ack'",
        ),
      ),
      1,
    );
    const lostAckHigh = await admin.fetchTopicOffsets(topic);
    const lostAckPending = await admin.fetchOffsets({ groupId: runId, topics: [topic] });
    assert.ok(
      lostAckHigh.some(
        ({ partition, offset }) =>
          BigInt(
            lostAckPending[0].partitions.find((entry) => entry.partition === partition)?.offset ??
              '-1',
          ) < BigInt(offset),
      ),
      'A stored insert without a delivered response must remain uncommitted',
    );
    assert.equal((await workerProcess.stop('SIGKILL')).signal, 'SIGKILL');
    await responseGate.close();
    responseGate = undefined;
    workerProcess = startWorkerProcess({
      groupId: runId,
      topic,
      deadLetterTopic,
      metricsPort: 9466,
    });
    await workerProcess.waitFor('SignalTrail event processor started');
    const lostAckRecovered = await waitForCommitted(lostAckHigh);
    assert.equal(
      Number(
        await query(
          "SELECT count() FROM signaltrail.analytics_events FINAL WHERE project_id = 'load-project' AND event_id = 'pipeline-lost-ack'",
        ),
      ),
      1,
    );
    const replayMetrics = await fetch('http://127.0.0.1:9466/metrics', {
      signal: AbortSignal.timeout(2000),
    });
    assert.equal(replayMetrics.status, 200);
    const replayBody = await replayMetrics.text();
    assert.match(replayBody, /signaltrail_processor_stored_total 2/);
    assert.match(replayBody, /signaltrail_processor_chunk_records_count 1/);
    assert.match(replayBody, /signaltrail_processor_chunk_records_sum 2/);
    assert.match(replayBody, /signaltrail_processor_chunk_source_bytes_count 1/);
    let browserPipeline;
    if (browser) {
      const { exerciseBrowserPipeline } = await import('./browser-pipeline.mjs');
      browserPipeline = await exerciseBrowserPipeline({ url, docker, query, directory });
      await waitForCommitted(await admin.fetchTopicOffsets(topic));
    }
    assert.equal((await workerProcess.stop()).code, 0);
    return {
      browserPipeline,
      boundedBulk,
      lostStorageAcknowledgement: {
        recordsPerInsert: 2,
        storedBeforeCrash: true,
        uncommittedBeforeCrash: lostAckPending,
        sourceHighOffsets: lostAckHigh,
        committedAfterRestart: lostAckRecovered,
        replacementStoredAgain: true,
        uniqueLogicalRows: 1,
      },
      passed: true,
      processRecovery: {
        abruptTermination: 'SIGKILL',
        sameConsumerGroup: true,
        retainedUntilStorageAcknowledgement: true,
        uniqueRecoveredRows: 1,
        gracefulExitCode: 0,
        metricsVerified: true,
        beforeRestart: pendingOffsets,
        sourceHighOffsets: highOffsets,
        afterRestart: recoveredOffsets,
      },
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
        { name: 'close insert response gate', run: () => responseGate?.close() },
        { name: 'stop owned worker process', timeoutMs: 25000, run: () => workerProcess?.stop() },
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
