import { expect, it, vi } from 'vitest';
import { request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { once } from 'node:events';
import { createAnalyticsHttpServer } from '../../src/index.ts';

it.each([
  { origin: 'not-a-url' },
  { origin: 'file:///tmp/query' },
  { origin: 'https://user:password@query.invalid' },
  { origin: 'https://query.invalid/path' },
  { maxConnections: 0 },
  { shutdownTimeoutMs: 0 },
])('rejects invalid HTTP configuration before listening', (invalid) => {
  expect(() =>
    createAnalyticsHttpServer({
      origin: 'https://query.invalid',
      query: {
        resolveProjectAccess: async () => ({ status: 'unauthenticated' }),
        countReceivedEvents: async () => ({ count: '0' }),
      },
      ...invalid,
    }),
  ).toThrow('Invalid query HTTP configuration');
});

const path =
  '/v1/analytics/count?projectId=project-1&from=2026-11-01T00:00:00Z&to=2026-11-02T00:00:00Z';

async function fixture() {
  const resolveProjectAccess = vi.fn(async () => ({
    status: 'authorized' as const,
    projectId: 'trusted-project',
  }));
  const countReceivedEvents = vi.fn(async () => ({ count: '7' }));
  const app = createAnalyticsHttpServer({
    origin: 'https://query.invalid',
    query: { resolveProjectAccess, countReceivedEvents },
  });
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test address');
  return { app, resolveProjectAccess, countReceivedEvents, port: address.port };
}

function wire(port: number, headers: string[] = ['Host', 'query.invalid']) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port, path, headers }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        body += chunk;
      });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
    });
    request.on('error', reject);
    request.end();
  });
}

it('uses configured origin and authorized project over real HTTP', async () => {
  const f = await fixture();
  try {
    expect(await wire(f.port, ['Host', 'attacker.invalid'])).toEqual({
      status: 200,
      body: '{"count":"7"}',
    });
    const call = f.resolveProjectAccess.mock.calls[0] as unknown as [Request];
    expect(new URL(call[0].url).origin).toBe('https://query.invalid');
    expect(call[0].headers.get('host')).toBe('query.invalid');
    expect(f.countReceivedEvents).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'trusted-project' }),
      expect.any(AbortSignal),
    );
  } finally {
    await f.app.close();
  }
});

it.each([
  ['Host', 'query.invalid', 'Authorization', 'Bearer first', 'Authorization', 'Bearer second'],
  ['Host', 'query.invalid', 'Content-Length', '1'],
])('rejects ambiguous credentials or request bodies before authorization', async (...headers) => {
  const f = await fixture();
  try {
    expect((await wire(f.port, headers)).status).toBe(400);
    expect(f.resolveProjectAccess).not.toHaveBeenCalled();
    expect(f.countReceivedEvents).not.toHaveBeenCalled();
  } finally {
    await f.app.close();
  }
});

it('closes an unbound server idempotently', async () => {
  const app = createAnalyticsHttpServer({
    origin: 'https://query.invalid',
    query: {
      resolveProjectAccess: async () => ({ status: 'unauthenticated' }),
      countReceivedEvents: async () => ({ count: '0' }),
    },
  });
  const closing = app.close();
  expect(app.close()).toBe(closing);
  await closing;
});

it('aborts underlying work when the client disconnects', async () => {
  let received!: (signal: AbortSignal) => void;
  const started = new Promise<AbortSignal>((resolve) => {
    received = resolve;
  });
  const app = createAnalyticsHttpServer({
    origin: 'https://query.invalid',
    query: {
      resolveProjectAccess: async () => ({ status: 'authorized', projectId: 'trusted-project' }),
      countReceivedEvents: async (_window, signal) => {
        received(signal!);
        await new Promise<void>((resolve) =>
          signal!.addEventListener('abort', () => resolve(), { once: true }),
        );
        throw new Error('cancelled');
      },
    },
  });
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test address');
  const request = httpRequest({ host: '127.0.0.1', port: address.port, path });
  request.on('error', () => {});
  request.end();
  try {
    const signal = await started;
    expect(signal.aborted).toBe(false);
    const aborted = new Promise<void>((resolve) =>
      signal.addEventListener('abort', () => resolve(), { once: true }),
    );
    request.destroy();
    await aborted;
    expect(signal.aborted).toBe(true);
  } finally {
    request.destroy();
    await app.close();
  }
});

it('aborts pending reads on shutdown and returns a bounded failure response', async () => {
  let received!: (signal: AbortSignal) => void;
  const started = new Promise<AbortSignal>((resolve) => {
    received = resolve;
  });
  const app = createAnalyticsHttpServer({
    origin: 'https://query.invalid',
    query: {
      resolveProjectAccess: async () => ({ status: 'authorized', projectId: 'trusted-project' }),
      countReceivedEvents: async (_window, signal) => {
        received(signal!);
        await new Promise<void>((resolve) =>
          signal!.addEventListener('abort', () => resolve(), { once: true }),
        );
        throw new Error('private database failure');
      },
    },
  });
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test address');
  try {
    const response = wire(address.port);
    const signal = await started;
    await app.close();
    expect(signal.aborted).toBe(true);
    expect(await response).toEqual({ status: 503, body: '{"error":"SERVICE_UNAVAILABLE"}' });
  } finally {
    await app.close();
  }
});

it('forces incomplete-header connections closed by the shutdown deadline', async () => {
  const app = createAnalyticsHttpServer({
    origin: 'https://query.invalid',
    shutdownTimeoutMs: 100,
    query: {
      resolveProjectAccess: async () => ({ status: 'unauthenticated' }),
      countReceivedEvents: async () => ({ count: '0' }),
    },
  });
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test address');
  const socket = connect(address.port, '127.0.0.1');
  socket.on('error', () => {});
  try {
    await once(socket, 'connect');
    socket.write('GET /v1/analytics/count HTTP/1.1\r\nHost: query.invalid\r\n');
    const disconnected = new Promise<void>((resolve) => socket.once('close', () => resolve()));
    await app.close();
    await disconnected;
    expect(socket.destroyed).toBe(true);
  } finally {
    socket.destroy();
    await app.close();
  }
});
