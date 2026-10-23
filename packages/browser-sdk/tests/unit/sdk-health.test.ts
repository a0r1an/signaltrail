import { expect, it } from 'vitest';
import { createSdkHealth } from '../../src/sdk-health.ts';
it('reports aggregate counters without queue event content', async () => {
  const health = createSdkHealth(
    { storageMode: 'memory', getAll: async () => ({ status: 'read', events: [] }) },
    () => 1000,
  );
  health.increment('queued');
  const report = await health.snapshot();
  expect(report.counters.queued).toBe(1);
  expect(report.queue).toEqual({
    status: 'read',
    storageMode: 'memory',
    count: 0,
    bytes: 0,
    oldestAgeMs: 0,
  });
  expect(JSON.stringify(report)).not.toContain('eventId');
});

it('counts committed enqueue outcomes through the real transport queue', async () => {
  const { openBatchTransport } = await import('../../src/batch-transport.ts');
  const transport = await openBatchTransport(
    { projectKey: 'health', ingestionUrl: 'https://ingest.example.com/v1/events' },
    { queue: { maxEvents: 1, memory: { maxEvents: 1 } } },
  );
  const event = {
    schemaVersion: 1 as const,
    eventId: 'one',
    eventName: 'view',
    distinctId: 'visitor',
    sessionId: 'session',
    clientTimestamp: new Date().toISOString(),
    sequence: 0,
    url: 'https://example.com',
    properties: {},
    context: { sdkVersion: '0.1.0' },
  };
  try {
    await transport.queue.enqueue(event);
    await transport.queue.enqueue({ ...event, eventId: 'two' });
    expect((await transport.getHealth()).counters).toMatchObject({ queued: 1, droppedCapacity: 1 });
  } finally {
    transport.close();
  }
});

it('records confirmed per-event outcomes separately from upload attempts', async () => {
  const { openBatchTransport } = await import('../../src/batch-transport.ts');
  const transport = await openBatchTransport(
    { projectKey: 'health-outcomes', ingestionUrl: 'https://ingest.example.com/v1/events' },
    {
      fetch: async () =>
        Response.json({
          results: [
            { index: 0, eventId: 'one', status: 'accepted' },
            {
              index: 1,
              eventId: 'two',
              status: 'retry',
              code: 'PUBLICATION_UNCONFIRMED',
              retryAfterMs: 1000,
            },
          ],
        }),
    },
  );
  const event = {
    schemaVersion: 1 as const,
    eventId: 'one',
    eventName: 'view',
    distinctId: 'visitor',
    sessionId: 'session',
    clientTimestamp: new Date().toISOString(),
    sequence: 0,
    url: 'https://example.com',
    properties: {},
    context: { sdkVersion: '0.1.0' },
  };
  try {
    await transport.queue.enqueue(event);
    await transport.queue.enqueue({ ...event, eventId: 'two' });
    expect(await transport.flush()).toEqual({ status: 'applied' });
    const report = await transport.getHealth();
    expect(report.counters).toMatchObject({ uploadAttempts: 1, accepted: 1, retryEvents: 1 });
    expect(report.queue).toMatchObject({ count: 1 });
  } finally {
    transport.close();
  }
});

it('sends an opt-in aggregate report on its own path and stops on close', async () => {
  const { vi } = await import('vitest');
  const { startSdkTelemetry } = await import('../../src/telemetry-reporter.ts');
  vi.useFakeTimers();
  const health = createSdkHealth(
    { storageMode: 'memory', getAll: async () => ({ status: 'read', events: [] }) },
    Date.now,
  );
  health.increment('queued');
  const send = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
  const close = startSdkTelemetry(
    { projectKey: 'public-key', ingestionUrl: 'https://ingest.example.com/v1/events' },
    { enabled: true, sampleRate: 1 },
    health,
    send,
  );
  try {
    await vi.advanceTimersByTimeAsync(60000);
    expect(send).toHaveBeenCalledTimes(1);
    expect(String(send.mock.calls[0]![0])).toBe('https://ingest.example.com/v1/sdk-health');
    const init = send.mock.calls[0]![1]!;
    expect(init.headers).toMatchObject({ Authorization: 'Bearer public-key' });
    expect(JSON.parse(init.body as string).counters).toEqual({ queued: 1 });
    close();
    await vi.advanceTimersByTimeAsync(60000);
    expect(send).toHaveBeenCalledTimes(1);
  } finally {
    close();
    vi.useRealTimers();
  }
});

it('keeps work recorded during a shared queue read for the next reporting interval', async () => {
  let resolveRead!: (value: { status: 'read'; events: [] }) => void;
  let first = true;
  const health = createSdkHealth(
    {
      storageMode: 'memory',
      getAll: async () => {
        if (!first) return { status: 'read', events: [] };
        first = false;
        return new Promise((resolve) => {
          resolveRead = resolve;
        });
      },
    },
    Date.now,
  );
  health.increment('queued');
  const reporting = health.take();
  health.increment('queued', 2);
  resolveRead({ status: 'read', events: [] });
  expect((await reporting).counters.queued).toBe(1);
  expect((await health.snapshot()).counters.queued).toBe(2);
});

it('does not send diagnostics by default and survives a hung reporting request', async () => {
  const { vi } = await import('vitest');
  const { startSdkTelemetry } = await import('../../src/telemetry-reporter.ts');
  vi.useFakeTimers();
  const health = createSdkHealth(
    { storageMode: 'memory', getAll: async () => ({ status: 'read', events: [] }) },
    Date.now,
  );
  const send = vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => {}));
  const config = { projectKey: 'key', ingestionUrl: 'https://ingest.example.com/v1/events' };
  const disabled = startSdkTelemetry(config, {}, health, send);
  let close = () => {};
  try {
    await vi.advanceTimersByTimeAsync(60000);
    expect(send).not.toHaveBeenCalled();
    close = startSdkTelemetry(config, { enabled: true, sampleRate: 1 }, health, send);
    await vi.advanceTimersByTimeAsync(60000);
    expect(send).toHaveBeenCalledTimes(1);
    const signal = send.mock.calls[0]![1]!.signal!;
    await vi.advanceTimersByTimeAsync(3000);
    expect(signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(60000);
    expect(send).toHaveBeenCalledTimes(2);
    expect((await health.snapshot()).counters.uploadAttempts).toBeUndefined();
  } finally {
    disabled();
    close();
    vi.useRealTimers();
  }
});
