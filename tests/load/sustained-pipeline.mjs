import assert from 'node:assert/strict';
import { applyClickHouseSchema } from './clickhouse-schema.mjs';
import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { resolve } from 'node:path';
import { runStorageInterruption } from './storage-interruption.mjs';
import { startWorkerProcess } from './worker-process.mjs';
import { cleanupResources } from './cleanup.mjs';
import { summarizeWorkerSamples } from './pipeline-report.mjs';
import { measureSourceLag, verifyPipelineTotals } from './pipeline-measurements.mjs';

const { Kafka, logLevel } = createRequire(
  new URL('../../apps/ingestion/package.json', import.meta.url),
)('kafkajs');
const topic = 'signaltrail.analytics.v1';
const deadLetterTopic = 'signaltrail.analytics.dlq.v1';
async function query(sql) {
  const response = await fetch('http://127.0.0.1:38123/?wait_end_of_query=1', {
    method: 'POST',
    headers: { 'X-ClickHouse-User': 'signaltrail', 'X-ClickHouse-Key': 'signaltrail_local' },
    body: sql,
    signal: AbortSignal.timeout(10000),
  });
  const text = await response.text();
  if (
    response.status !== 200 ||
    ![null, '0'].includes(response.headers.get('X-ClickHouse-Exception-Code'))
  )
    throw new Error('Sustained storage query was not acknowledged');
  return text;
}
function metric(text, series) {
  const line = text.split('\n').find((line) => line.startsWith(series + ' '));
  if (!line) return null;
  const value = Number(line.slice(series.length + 1));
  if (!Number.isFinite(value)) throw new Error('Invalid worker metric sample');
  return value;
}

export async function openSustainedPipeline({
  runId,
  directory,
  docker,
  interrupted,
  storageInterruption = false,
  expectedPaddingBytes = 0,
}) {
  const kafka = new Kafka({
    brokers: ['127.0.0.1:29092'],
    clientId: runId + '-observer',
    logLevel: logLevel.ERROR,
    requestTimeout: 3000,
    retry: { retries: 2 },
  });
  const admin = kafka.admin();
  const samples = [];
  const resourceSamples = [];
  let worker,
    interval,
    sampling = Promise.resolve(),
    samplingError,
    lastResources = 0,
    samplePending = false;
  const started = performance.now();
  let phase = 'ready';
  const interruptionController = new AbortController();
  const interruptionStates = [];
  let interruption;
  let closing;
  const lag = async () => {
    // Read commits first so a concurrent commit cannot exceed an older high watermark.
    const committed = await admin.fetchOffsets({ groupId: runId, topics: [topic] });
    const high = await admin.fetchTopicOffsets(topic);
    const result = measureSourceLag(high, committed[0]?.partitions ?? []);
    if (result.partitions.some((entry) => entry.retentionGap))
      throw new Error('Source retention overtook the worker');
    return result;
  };
  const sample = async () => {
    const source = await lag();
    const response = await fetch('http://127.0.0.1:9466/metrics', {
      signal: AbortSignal.timeout(3000),
    });
    assert.equal(response.status, 200);
    const text = await response.text();
    const rss = metric(text, 'signaltrail_processor_process_resident_memory_bytes');
    const cpu = metric(text, 'signaltrail_processor_process_cpu_seconds_total');
    assert.ok(rss > 0 && cpu !== null, 'Worker resource metrics must be available');
    const observation = {
      at: new Date().toISOString(),
      elapsedSeconds: (performance.now() - started) / 1000,
      phase,
      storagePaused: interruptionStates.at(-1)?.state === 'paused',
      source,
      worker: {
        rssBytes: rss,
        cpuSeconds: cpu,
        heapBytes: metric(text, 'signaltrail_processor_nodejs_heap_size_used_bytes'),
        stored: metric(text, 'signaltrail_processor_stored_total'),
        retries: metric(text, 'signaltrail_processor_retries_total'),
      },
      metrics: text,
    };
    samples.push(observation);
    await writeFile(resolve(directory, 'worker.prom'), text);
    if (performance.now() - lastResources >= 5000) {
      lastResources = performance.now();
      const raw = await docker(
        ['stats', '--no-stream', '--format', 'json'],
        true,
        false,
        AbortSignal.timeout(5000),
      );
      resourceSamples.push({
        at: new Date().toISOString(),
        phase,
        containers: raw
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line)),
      });
    }
    return observation;
  };
  const stopSampling = async () => {
    clearInterval(interval);
    await sampling;
    if (samplingError) throw samplingError;
  };
  const close = () => {
    if (closing) return closing;
    closing = cleanupResources([
      {
        name: 'finish storage interruption',
        timeoutMs: 15000,
        run: async () => {
          interruptionController.abort();
          await interruption;
        },
      },
      { name: 'stop sustained sampling', timeoutMs: 15000, run: stopSampling },
      {
        name: 'save sustained worker samples',
        run: () => writeFile(resolve(directory, 'worker-samples.json'), JSON.stringify(samples)),
      },
      {
        name: 'save sustained container samples',
        run: () =>
          writeFile(resolve(directory, 'container-samples.json'), JSON.stringify(resourceSamples)),
      },
      { name: 'stop sustained worker', timeoutMs: 25000, run: () => worker?.stop() },
      { name: 'disconnect sustained observer', run: () => admin.disconnect() },
    ]);
    return closing;
  };
  try {
    await applyClickHouseSchema(query);
    assert.equal(Number(await query('SELECT count() FROM signaltrail.analytics_events')), 0);
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
    worker = startWorkerProcess({
      groupId: runId,
      topic,
      deadLetterTopic,
      metricsPort: 9466,
      timeoutMs: 5000,
    });
    await worker.waitFor('SignalTrail event processor started');
    await sample();
    phase = 'traffic';
    if (storageInterruption) {
      interruption = runStorageInterruption({
        signal: interruptionController.signal,
        pause: () =>
          docker(
            ['pause', 'clickhouse'],
            false,
            false,
            AbortSignal.any([interruptionController.signal, AbortSignal.timeout(5000)]),
          ),
        resume: () => docker(['unpause', 'clickhouse'], false, false, AbortSignal.timeout(5000)),
        onState: (state) => interruptionStates.push({ state, at: new Date().toISOString() }),
      });
      void interruption.catch(() => {});
    }
    interval = setInterval(() => {
      // Skip a tick while sampling is pending; never accumulate an unbounded work queue.
      if (samplePending) return;
      const current = sample();
      samplePending = true;
      sampling = current;
      void current
        .catch((error) => {
          samplingError ??= error;
          clearInterval(interval);
        })
        .finally(() => {
          samplePending = false;
        });
    }, 1000);
    return {
      close,
      async finish(summary) {
        await interruption;
        await stopSampling();
        phase = 'drain';
        const stoppedTraffic = performance.now();
        let final;
        const deadline = Date.now() + 60000;
        do {
          if (interrupted()) throw new Error('Sustained test interrupted');
          final = await sample();
          if (final.source.total === '0') break;
          await delay(1000);
        } while (Date.now() < deadline);
        const uniqueRows = Number(
          await query('SELECT count() FROM signaltrail.analytics_events FINAL'),
        );
        const padding = JSON.parse(
          await query(
            "SELECT min(length(JSONExtractString(properties_json, 'padding'))) AS minimum, max(length(JSONExtractString(properties_json, 'padding'))) AS maximum FROM signaltrail.analytics_events FINAL FORMAT JSONEachRow",
          ),
        );
        assert.equal(
          Number(padding.minimum),
          expectedPaddingBytes,
          'Stored minimum padding length must match the generated payload',
        );
        assert.equal(
          Number(padding.maximum),
          expectedPaddingBytes,
          'Stored maximum padding length must match the generated payload',
        );
        const dlq = await admin.fetchTopicOffsets(deadLetterTopic);
        const totals = {
          accepted: summary.metrics.events_accepted?.values.count,
          retried: summary.metrics.events_retry?.values.count,
          rejected: summary.metrics.events_rejected?.values.count,
          droppedIterations: summary.metrics.dropped_iterations?.values.count ?? 0,
          malformedResponses: summary.metrics.responses_malformed?.values.count,
          uniqueRows,
          sourceLag: final.source.total,
          brokerRecords: final.source.partitions
            .reduce((sum, entry) => sum + BigInt(entry.high), 0n)
            .toString(),
          deadLetters: dlq.reduce((sum, entry) => sum + BigInt(entry.offset), 0n).toString(),
        };
        const report = {
          passed: false,
          totals,
          verifiedPaddingBytes: expectedPaddingBytes,
          drainSeconds: (performance.now() - stoppedTraffic) / 1000,
          maxSampledLag: samples.reduce(
            (max, entry) => (BigInt(entry.source.total) > BigInt(max) ? entry.source.total : max),
            '0',
          ),
          storageInterruption: storageInterruption ? { states: interruptionStates } : null,
          traffic: {
            durationSeconds: summary.state.testRunDurationMs / 1000,
            iterations: summary.metrics.iterations.values.count,
            httpDurationMs: summary.metrics.http_req_duration.values,
          },
          workerSummary: summarizeWorkerSamples(samples),
          maxWorkerRssBytes: Math.max(...samples.map((entry) => entry.worker.rssBytes)),
          first: samples[0],
          final,
          sampleCount: samples.length,
          limitations: [
            'Same-host k6, broker, storage and worker; not production sizing.',
            'Lag and resource observations are sampled sequentially, not an atomic snapshot.',
            'No SDK retry simulation or browser execution in this scenario.',
            'FINAL reads enforce logical uniqueness; physical duplicate rows are permitted.',
          ],
        };
        await writeFile(resolve(directory, 'sustained.json'), JSON.stringify(report, null, 2));
        verifyPipelineTotals(totals);
        assert.ok(
          report.workerSummary.storage?.confirmedWrites > 0,
          'Storage latency must be observed',
        );
        assert.equal(final.worker.stored, Number(totals.brokerRecords));
        if (storageInterruption) {
          assert.deepEqual(
            interruptionStates.map((entry) => entry.state),
            ['paused', 'resumed'],
          );
          assert.ok(
            samples.some((entry) => entry.storagePaused && BigInt(entry.source.total) > 0n),
            'Source backlog must be observed during storage outage',
          );
          assert.ok(
            report.workerSummary.storage.failedWrites > 0 && final.worker.retries > 0,
            'Outage must exercise a real storage failure and retry',
          );
        }
        const exited = await worker.stop();
        assert.equal(exited.code, 0, 'Sustained worker must exit gracefully');
        report.passed = true;
        await writeFile(resolve(directory, 'sustained.json'), JSON.stringify(report, null, 2));
        return report;
      },
    };
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Sustained setup and cleanup failed');
    }
    throw error;
  }
}
