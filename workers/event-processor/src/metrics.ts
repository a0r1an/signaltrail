import { Counter, Gauge, Registry } from '@prometheus-io/client';
import { createServer } from 'node:http';

interface ProcessorSnapshot {
  running: boolean;
  stored: number;
  deadLettered: number;
  retries: number;
}
export function createProcessorMetrics(snapshot: () => ProcessorSnapshot) {
  const registry = new Registry();
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
    close() {
      if (closing) return closing;
      closing = new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => {
          registry.clear();
          if (error && (!('code' in error) || error.code !== 'ERR_SERVER_NOT_RUNNING')) reject(error);
          else resolve();
        });
      });
      return closing;
    },
  };
}
