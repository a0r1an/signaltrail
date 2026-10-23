import { expect, it } from 'vitest';
import { createIngestionHandler } from '../../src/handler.ts';
it('accepts authenticated aggregate health reports without publishing analytics records', async () => {
  let publications = 0;
  const received: unknown[] = [];
  const handler = createIngestionHandler({
    resolveProjectKey: (key) => (key === 'public-key' ? 'trusted-project' : undefined),
    publish: async () => {
      publications++;
    },
    observeSdkHealth: (report) => received.push(report),
  });
  const report = {
    schemaVersion: 1,
    sdkVersion: '0.1.0',
    intervalMs: 60000,
    counters: { queued: 2 },
    timings: { enqueueMs: 3, uploadMs: 4 },
    queue: { status: 'read', storageMode: 'memory', count: 2, bytes: 700, oldestAgeMs: 1000 },
  };
  const response = await handler(
    new Request('http://localhost/v1/sdk-health', {
      method: 'POST',
      headers: { Authorization: 'Bearer public-key', 'Content-Type': 'application/json' },
      body: JSON.stringify(report),
    }),
  );
  expect(response.status).toBe(204);
  expect(received).toEqual([report]);
  expect(publications).toBe(0);
});

it('rejects unauthorized and oversized reports before updating metrics', async () => {
  let reports = 0;
  const handler = createIngestionHandler({
    resolveProjectKey: (key) => (key === 'key' ? 'project' : undefined),
    publish: async () => {},
    observeSdkHealth: () => {
      reports++;
    },
  });
  const request = (body: string, key: string) =>
    new Request('http://localhost/v1/sdk-health', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body,
    });
  expect((await handler(request('{}', 'wrong'))).status).toBe(401);
  expect((await handler(request(' '.repeat(16385), 'key'))).status).toBe(413);
  expect(reports).toBe(0);
});
