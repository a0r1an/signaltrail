import { expect, it, vi } from 'vitest';
import { createIngestionHandler } from '../../src/handler.ts';

it('refuses excess body-parsing work before reading another request and releases the slot afterward', async () => {
  let release!: () => void;
  let reads = 0;
  const observations: { active: number; refused: boolean }[] = [];
  const handle = createIngestionHandler({
    maxConcurrentRequests: 1,
    allowedOrigins: ['https://client.example'],
    observeAdmission: async (active, refused) => {
      observations.push({ active, refused });
      throw new Error('diagnostic failure');
    },
    resolveProjectKey: async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return undefined;
    },
    publish: async () => {},
  });
  const pending = handle(
    new Request('http://localhost/v1/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer key' },
      body: '{}',
    }),
  );
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        reads++;
        controller.close();
      },
    },
    { highWaterMark: 0 },
  );
  const init: RequestInit & { duplex: 'half' } = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://client.example' },
    body,
    duplex: 'half',
  };
  try {
    const refused = await handle(new Request('http://localhost/v1/events', init));
    expect(refused.status).toBe(503);
    expect(refused.headers.get('Retry-After')).toBe('1');
    expect(refused.headers.get('Access-Control-Allow-Origin')).toBe('https://client.example');
    expect(refused.headers.get('Access-Control-Expose-Headers')).toBe('Retry-After');
    expect(reads).toBe(0);
    expect((await handle(new Request('http://localhost/health'))).status).toBe(200);
  } finally {
    release();
    await pending;
  }
  const next = await handle(
    new Request('http://localhost/v1/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    }),
  );
  expect(next.status).toBe(401);
  expect(observations).toContainEqual({ active: 1, refused: true });
  expect(observations.at(-1)).toEqual({ active: 0, refused: false });
});

it('releases request slots after malformed JSON and project resolver failures', async () => {
  const resolveProjectKey = vi
    .fn()
    .mockRejectedValueOnce(new Error('unavailable'))
    .mockResolvedValue(undefined);
  const handle = createIngestionHandler({
    maxConcurrentRequests: 1,
    resolveProjectKey,
    publish: async () => {},
  });
  const request = (body: string) =>
    new Request('http://localhost/v1/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer key' },
      body,
    });
  expect((await handle(request('{'))).status).toBe(400);
  expect((await handle(request('{}'))).status).toBe(503);
  expect((await handle(request('{}'))).status).toBe(401);
});

it.each([0, -1, 0.5, NaN, Infinity])(
  'rejects an invalid concurrent request limit: %s',
  (maxConcurrentRequests) => {
    expect(() =>
      createIngestionHandler({
        maxConcurrentRequests,
        resolveProjectKey: () => undefined,
        publish: async () => {},
      }),
    ).toThrow('maxConcurrentRequests');
  },
);
