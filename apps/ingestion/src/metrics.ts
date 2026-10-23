import { SDK_HEALTH_COUNTERS, type SdkHealthReport } from '@signaltrail/contracts';
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from '@prometheus-io/client';
import { createServer } from 'node:http';
import type { PublicationSnapshot } from './publication-capacity.ts';

export function createIngestionMetrics(
  snapshot: () => PublicationSnapshot,
  limits: { maxEvents: number; maxBytes: number },
) {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry, prefix: 'signaltrail_' });
  const fields = {
    outstanding_events: 'outstandingEvents',
    outstanding_bytes: 'outstandingBytes',
    peak_events: 'peakEvents',
    peak_bytes: 'peakBytes',
    refused_total: 'refused',
    completed_total: 'completed',
    failed_total: 'failed',
    cancelled_total: 'cancelled',
    late_completions_total: 'lateCompletions',
    duration_seconds_total: 'durationSeconds',
  } as const;
  for (const [name, field] of Object.entries(fields)) {
    const config = {
      name: `signaltrail_publications_${name}`,
      help: `Publisher ${name.replaceAll('_', ' ')}`,
      registers: [registry],
    };
    if (name.endsWith('_total')) {
      let last = 0;
      new Counter({
        ...config,
        collect() {
          const current = snapshot()[field];
          this.inc(Math.max(0, current - last));
          last = current;
        },
      });
    } else
      new Gauge({
        ...config,
        collect() {
          this.set(snapshot()[field]);
        },
      });
  }
  for (const [name, value] of [
    ['events', limits.maxEvents],
    ['bytes', limits.maxBytes],
  ] as const)
    new Gauge({
      name: `signaltrail_publications_limit_${name}`,
      help: `Publication ${name} budget`,
      registers: [registry],
    }).set(value);
  const publicationDuration = new Histogram({
    name: 'signaltrail_publication_duration_seconds',
    help: 'Underlying broker send duration, including late completion',
    labelNames: ['outcome'],
    buckets: [0.005, 0.01, 0.05, 0.1, 0.5, 1, 3, 5, 10, 30],
    registers: [registry],
  });
  const requests = new Counter({
    name: 'signaltrail_http_requests_total',
    help: 'Completed HTTP requests',
    labelNames: ['status_class'],
    registers: [registry],
  });
  const duration = new Histogram({
    name: 'signaltrail_http_request_duration_seconds',
    help: 'HTTP handler duration',
    buckets: [0.005, 0.01, 0.05, 0.1, 0.5, 1, 3, 5, 10],
    registers: [registry],
  });
  const sdkCounters = Object.fromEntries(
    SDK_HEALTH_COUNTERS.map((kind) => [
      kind,
      new Counter({
        name: `signaltrail_sdk_reported_${kind.replace(/[A-Z]/g, (letter) => '_' + letter.toLowerCase())}_total`,
        help: `Best-effort sampled SDK ${kind}; not exact global totals`,
        registers: [registry],
      }),
    ]),
  );
  const sdkReports = new Counter({
    name: 'signaltrail_sdk_health_reports_total',
    help: 'Received sampled health reports',
    labelNames: ['storage_mode'],
    registers: [registry],
  });
  const sdkQueue = new Histogram({
    name: 'signaltrail_sdk_reported_queue_events',
    help: 'Queue sizes observed in sampled reports, not a sum across tabs',
    buckets: [0, 1, 10, 50, 100, 250, 500, 1000],
    registers: [registry],
  });
  const sdkAge = new Histogram({
    name: 'signaltrail_sdk_reported_oldest_event_age_seconds',
    help: 'Oldest client event timestamp age in sampled queue reports',
    buckets: [1, 10, 60, 300, 3600, 86400],
    registers: [registry],
  });
  const sdkEnqueue = new Counter({
    name: 'signaltrail_sdk_reported_enqueue_duration_seconds_total',
    help: 'Reported aggregate enqueue duration',
    registers: [registry],
  });
  const sdkUpload = new Counter({
    name: 'signaltrail_sdk_reported_upload_duration_seconds_total',
    help: 'Reported aggregate upload duration',
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
  return {
    registry,
    server,
    observeSdkHealth(report: SdkHealthReport) {
      sdkReports.inc({ storage_mode: report.queue.storageMode });
      for (const kind of SDK_HEALTH_COUNTERS) sdkCounters[kind]!.inc(report.counters[kind] ?? 0);
      sdkEnqueue.inc(report.timings.enqueueMs / 1000);
      sdkUpload.inc(report.timings.uploadMs / 1000);
      if (report.queue.status === 'read') {
        sdkQueue.observe(report.queue.count);
        sdkAge.observe(report.queue.oldestAgeMs / 1000);
      }
    },
    observePublication(seconds: number, failed: boolean) {
      publicationDuration.observe({ outcome: failed ? 'failed' : 'completed' }, seconds);
    },
    observeRequest(status: number, seconds: number) {
      requests.inc({ status_class: `${Math.floor(status / 100)}xx` });
      duration.observe(seconds);
    },
    close() {
      server.close();
      registry.clear();
    },
  };
}
