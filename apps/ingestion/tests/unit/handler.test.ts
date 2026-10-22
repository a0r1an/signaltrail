import { expect, it, vi } from 'vitest';
import { createIngestionHandler } from '../../src/index.ts';
const event = {
  schemaVersion: 1,
  eventId: 'event-1',
  eventName: 'view',
  distinctId: 'visitor',
  sessionId: 'session',
  sequence: 0,
  clientTimestamp: '2026-10-22T12:00:00.000Z',
  url: 'https://example.com',
  properties: {},
  context: { sdkVersion: '0.1.0' },
};
const request = (
  events: unknown[] = [event],
  headers: Record<string, string> = {
    Authorization: 'Bearer public-key',
    'Content-Type': 'application/json',
  },
) =>
  new Request('http://localhost/v1/events', {
    method: 'POST',
    headers,
    body: JSON.stringify({ events }),
  });
it('publishes parsed events with trusted project identity before accepting them', async () => {
  const publish = vi.fn().mockResolvedValue(undefined);
  const handle = createIngestionHandler({
    resolveProjectKey: (key) => (key === 'public-key' ? 'project-1' : undefined),
    publish,
    now: () => Date.parse('2026-10-22T13:00:00.000Z'),
  });
  const response = await handle(
    request([{ ...event, projectId: 'forged', projectKey: 'forged', extra: true }]),
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    results: [{ index: 0, eventId: event.eventId, status: 'accepted' }],
  });
  expect(publish).toHaveBeenCalledExactlyOnceWith(
    { projectId: 'project-1', receivedAt: '2026-10-22T13:00:00.000Z', event },
    expect.any(AbortSignal),
  );
});
it('keeps valid siblings and reports publication failure as retry rather than acceptance', async () => {
  const publish = vi
    .fn()
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error('publication uncertain'));
  const handle = createIngestionHandler({ resolveProjectKey: () => 'project-1', publish });
  const response = await handle(
    request([event, { ...event, eventId: '' }, { ...event, eventId: 'event-3' }]),
  );
  expect(await response.json()).toEqual({
    results: [
      { index: 0, eventId: event.eventId, status: 'accepted' },
      { index: 1, status: 'rejected', code: 'INVALID_EVENT' },
      {
        index: 2,
        eventId: 'event-3',
        status: 'retry',
        code: 'PUBLICATION_UNCONFIRMED',
        retryAfterMs: 1000,
      },
    ],
  });
  expect(publish).toHaveBeenCalledTimes(2);
});
it.each([[], new Array(101).fill(event), 'not-an-array', undefined])(
  'rejects malformed batch structure without publishing: %s',
  async (events) => {
    const publish = vi.fn();
    const handle = createIngestionHandler({ resolveProjectKey: () => 'project-1', publish });
    const response = await handle(
      new Request('http://localhost/v1/events', {
        method: 'POST',
        headers: { Authorization: 'Bearer public-key', 'Content-Type': 'application/json' },
        body: JSON.stringify({ events }),
      }),
    );
    expect(response.status).toBe(400);
    expect(publish).not.toHaveBeenCalled();
  },
);
it('authenticates a text/plain beacon using its request-level body key', async () => {
  const publish = vi.fn().mockResolvedValue(undefined);
  const handle = createIngestionHandler({
    resolveProjectKey: (key) => (key === 'public-key' ? 'project-1' : undefined),
    publish,
  });
  const response = await handle(
    new Request('http://localhost/v1/events', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ projectKey: 'public-key', events: [event] }),
    }),
  );
  expect(response.status).toBe(200);
  expect(publish).toHaveBeenCalledTimes(1);
});
it('enforces actual UTF-8 body bytes including the envelope without requiring Content-Length', async () => {
  const publish = vi.fn().mockResolvedValue(undefined);
  const payload = { events: [{ ...event, properties: { text: '🚀' } }] };
  const encoded = JSON.stringify(payload);
  const size = new TextEncoder().encode(encoded).byteLength;
  const handle = createIngestionHandler({
    resolveProjectKey: () => 'project-1',
    publish,
    maxRequestBytes: size - 1,
  });
  const response = await handle(
    new Request('http://localhost/v1/events', {
      method: 'POST',
      headers: { Authorization: 'Bearer public-key', 'Content-Type': 'application/json' },
      body: encoded,
    }),
  );
  expect(response.status).toBe(413);
  expect(publish).not.toHaveBeenCalled();
});
it('serves health and rejects unknown routes or unsupported ingestion methods', async () => {
  const publish = vi.fn();
  const handle = createIngestionHandler({ resolveProjectKey: () => undefined, publish });
  expect((await handle(new Request('http://localhost/health'))).status).toBe(200);
  expect((await handle(new Request('http://localhost/unknown'))).status).toBe(404);
  expect((await handle(new Request('http://localhost/v1/events'))).status).toBe(405);
  expect(publish).not.toHaveBeenCalled();
});
it('allows configured cross-origin preflight and returns CORS headers on ingestion responses', async () => {
  const publish = vi.fn().mockResolvedValue(undefined);
  const handle = createIngestionHandler({
    resolveProjectKey: () => 'project-1',
    publish,
    allowedOrigins: ['https://app.example.com'],
  });
  const preflight = await handle(
    new Request('http://localhost/v1/events', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://app.example.com',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization,content-type',
      },
    }),
  );
  expect(preflight.status).toBe(204);
  expect(preflight.headers.get('access-control-allow-origin')).toBe('https://app.example.com');
  const response = await handle(
    request([event], {
      Origin: 'https://app.example.com',
      Authorization: 'Bearer public-key',
      'Content-Type': 'application/json',
    }),
  );
  expect(response.headers.get('access-control-allow-origin')).toBe('https://app.example.com');
  expect(response.status).toBe(200);
});
it('returns retry and aborts the publication attempt at its deadline without claiming late success', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  let started!: () => void;
  const publishing = new Promise<void>((resolve) => {
    started = resolve;
  });
  let complete!: () => void;
  let signal!: AbortSignal;
  const handle = createIngestionHandler({
    resolveProjectKey: () => 'project-1',
    publicationTimeoutMs: 50,
    publish: async (_record, attemptSignal) => {
      signal = attemptSignal;
      started();
      await new Promise<void>((resolve) => {
        complete = resolve;
      });
    },
  });
  try {
    const pending = handle(request());
    await publishing;
    await vi.advanceTimersByTimeAsync(50);
    const response = await pending;
    expect(signal.aborted).toBe(true);
    expect(await response.json()).toEqual({
      results: [
        {
          index: 0,
          eventId: event.eventId,
          status: 'retry',
          code: 'PUBLICATION_UNCONFIRMED',
          retryAfterMs: 1000,
        },
      ],
    });
    complete();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
}, 1000);
it.each(['application/x-www-form-urlencoded', 'text/html'])(
  'rejects unsupported content type %s before publication',
  async (contentType) => {
    const publish = vi.fn();
    const handle = createIngestionHandler({ resolveProjectKey: () => 'project-1', publish });
    expect(
      (
        await handle(
          request([event], { Authorization: 'Bearer public-key', 'Content-Type': contentType }),
        )
      ).status,
    ).toBe(415);
    expect(publish).not.toHaveBeenCalled();
  },
);
it.each([
  { headers: {}, bodyKey: undefined },
  { headers: { Authorization: 'Bearer wrong' }, bodyKey: undefined },
  { headers: { Authorization: 'Basic public-key' }, bodyKey: 'public-key' },
  { headers: { Authorization: 'Bearer public-key' }, bodyKey: 'different-key' },
])(
  'rejects missing, unknown, malformed, or conflicting credentials: %s',
  async ({ headers, bodyKey }) => {
    const publish = vi.fn();
    const handle = createIngestionHandler({
      resolveProjectKey: (key) => (key === 'public-key' ? 'project-1' : undefined),
      publish,
    });
    const response = await handle(
      new Request('http://localhost/v1/events', {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectKey: bodyKey, events: [event] }),
      }),
    );
    expect(response.status).toBe(401);
    expect(publish).not.toHaveBeenCalled();
  },
);
it('does not publish for forbidden origins or malformed JSON', async () => {
  const publish = vi.fn();
  const handle = createIngestionHandler({ resolveProjectKey: () => 'project-1', publish });
  expect(
    (
      await handle(
        request([event], {
          Authorization: 'Bearer public-key',
          Origin: 'https://forbidden.example',
          'Content-Type': 'application/json',
        }),
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await handle(
        new Request('http://localhost/v1/events', {
          method: 'POST',
          headers: { Authorization: 'Bearer public-key', 'Content-Type': 'application/json' },
          body: '{',
        }),
      )
    ).status,
  ).toBe(400);
  expect(publish).not.toHaveBeenCalled();
});
it('fails closed with a retryable service error when project resolution fails', async () => {
  const publish = vi.fn();
  const handle = createIngestionHandler({
    resolveProjectKey: () => {
      throw new Error('private database detail');
    },
    publish,
  });
  const response = await handle(request());
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: 'SERVICE_UNAVAILABLE' });
  expect(publish).not.toHaveBeenCalled();
});
it('bounds JSON nesting before recursive validation without counting brackets inside strings', async () => {
  const publish = vi.fn().mockResolvedValue(undefined);
  const handle = createIngestionHandler({ resolveProjectKey: () => 'project-1', publish });
  let nested: unknown = null;
  for (let depth = 0; depth < 70; depth++) nested = { value: nested };
  expect((await handle(request([{ ...event, properties: { nested } }]))).status).toBe(400);
  expect(publish).not.toHaveBeenCalled();
  expect(
    (await handle(request([{ ...event, properties: { text: '{['.repeat(100) + '"\\' } }]))).status,
  ).toBe(200);
  expect(publish).toHaveBeenCalledTimes(1);
});
