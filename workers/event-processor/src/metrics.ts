import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from '@prometheus-io/client';
import { createServer } from 'node:http';

interface ProcessorSnapshot {
  running: boolean;
  stored: number;
  deadLettered: number;
  retries: number;
}
export function createProcessorMetrics(snapshot: () => ProcessorSnapshot) {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry, prefix: 'signaltrail_processor_' });
  new Gauge({
    name: 'signaltrail_processor_running',
    help: 'Consumer loop is running; not proof of storage availability or zero lag',
    registers: [registry],
    collect() {
      this.set(snapshot().running ? 1 : 0);
    },
  });
  for (const [name, field] of [
    ['stored', 'stored'],
    ['dead_lettered', 'deadLettered'],
    ['retries', 'retries'],
  ] as const) {
    let last = 0;
    new Counter({
      name: `signaltrail_processor_${name}_total`,
      help: `Process-local ${name}; resets on restart, not a unique event count`,
      registers: [registry],
      collect() {
        const current = snapshot()[field];
        this.inc(Math.max(0, current - last));
        last = current;
      },
    });
  }
  const chunkRecords = new Histogram({
    name: 'signaltrail_processor_chunk_records',
    help: 'Source records in each selected chunk, observed once before retries; not completed events',
    buckets: [1, 5, 10, 25, 50, 100],
    registers: [registry],
  });
  const chunkBytes = new Histogram({
    name: 'signaltrail_processor_chunk_source_bytes',
    help: 'Source payload bytes in each selected chunk before validation, including poison records',
    buckets: [1024, 4096, 16384, 65536, 262144, 524288, 1048576],
    registers: [registry],
  });
  const attemptDuration = new Histogram({
    name: 'signaltrail_processor_attempt_duration_seconds',
    help: 'Chunk processing attempt duration including sink acknowledgement and source-offset commit; mixed chunks use stored outcome',
    labelNames: ['outcome'],
    buckets: [0.005, 0.01, 0.05, 0.1, 0.5, 1, 3, 5, 10, 30],
    registers: [registry],
  });
  const server = createServer((request, response) => {
    if (request.method !== 'GET' || request.url !== '/metrics') {
      response.writeHead(404).end();
      return;
    }
    void registry
      .metrics()
      .then((body) => {
        response
          .writeHead(200, { 'Content-Type': registry.contentType, 'Cache-Control': 'no-store' })
          .end(body);
      })
      .catch(() => {
        response.writeHead(503).end();
      });
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.keepAliveTimeout = 1000;
  server.maxConnections = 16;
  let closing: Promise<void> | undefined;
  return {
    registry,
    server,
    observeChunk(records: number, bytes: number) {
      chunkRecords.observe(records);
      chunkBytes.observe(bytes);
    },
    observeAttempt(outcome: 'stored' | 'dead_lettered' | 'failed', seconds: number) {
      attemptDuration.observe({ outcome }, seconds);
    },
    close() {
      if (closing) return closing;
      closing = new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => {
          registry.clear();
          if (error && (!('code' in error) || error.code !== 'ERR_SERVER_NOT_RUNNING'))
            reject(error);
          else resolve();
        });
      });
      return closing;
    },
  };
}
