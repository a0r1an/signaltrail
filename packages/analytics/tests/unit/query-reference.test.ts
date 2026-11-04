import { expect, it } from 'vitest';
import { createAnalyticsQueryHandler } from '../../src/index.ts';
import { matchesQueryReference, readQueryReferenceResponse } from '../query-reference.ts';

const target =
  'https://query.invalid/v1/analytics/count?projectId=trusted&from=2026-11-01T00:00:00Z&to=2026-11-02T00:00:00Z';
const event = {
  eventId: 'event-1',
  eventName: 'view',
  sessionId: 'session-1',
  sequence: '18446744073709551615',
  receivedAt: '2026-11-01T12:00:00.000Z',
};

it('confirms the handler count response preserves the documented exact decimal type', async () => {
  const handler = createAnalyticsQueryHandler({
    resolveProjectAccess: async () => ({ status: 'authorized', projectId: 'trusted' }),
    countReceivedEvents: async () => ({ count: '18446744073709551615' }),
  });
  const response = await handler(new Request(target));
  expect(response.status).toBe(200);
  expect(matchesQueryReference('count', response.status, await response.json())).toBe(true);
});

it.each([
  { events: [event], hasMore: false },
  { events: [event], hasMore: true, nextCursor: 'opaque-cursor' },
])('confirms actual handler page variants against the reference schema', async (page) => {
  const handler = createAnalyticsQueryHandler({
    resolveProjectAccess: async () => ({ status: 'authorized', projectId: 'trusted' }),
    countReceivedEvents: async () => ({ count: '0' }),
    listReceivedEvents: async () => page,
  });
  const response = await handler(new Request(target.replace('/count?', '/events?')));
  expect(response.status).toBe(200);
  expect(matchesQueryReference('events', response.status, await response.json())).toBe(true);
});

it.each([
  ['count', { count: 7 }],
  ['count', { count: '01' }],
  ['count', { count: '1', rawSql: 'private' }],
  ['events', { events: [event], hasMore: true }],
  ['events', { events: [event], hasMore: false, nextCursor: 'unexpected' }],
  ['events', { events: [{ ...event, sequence: 7 }], hasMore: false }],
  ['events', { events: [{ ...event, url: 'https://private.invalid' }], hasMore: false }],
] as const)('detects incompatible %s response shapes', (operation, body) => {
  expect(matchesQueryReference(operation, 200, body)).toBe(false);
});

it.each(['unauthenticated', 'forbidden'] as const)(
  'checks %s handler failures against the reference',
  async (status) => {
    const handler = createAnalyticsQueryHandler({
      resolveProjectAccess: async () => ({ status }),
      countReceivedEvents: async () => {
        throw new Error('Should not read');
      },
    });
    const response = await handler(new Request(target));
    expect(response.status).toBe(status === 'unauthenticated' ? 401 : 403);
    expect(matchesQueryReference('count', response.status, await response.json())).toBe(true);
  },
);

it.each([
  { url: target.replace('projectId=trusted&', ''), method: 'GET', status: 400 },
  { url: target, method: 'POST', status: 405 },
  { url: target + '&eventName=' + 'x'.repeat(5000), method: 'GET', status: 414 },
  { url: target.replace('/count?', '/unknown?'), method: 'GET', status: 404 },
  { url: target, method: 'GET', status: 503 },
])('checks handler status $status against the reference', async ({ url, method, status }) => {
  const handler = createAnalyticsQueryHandler({
    resolveProjectAccess: async () => ({ status: 'authorized', projectId: 'trusted' }),
    countReceivedEvents: async () => {
      if (status === 503) throw new Error('private failure');
      return { count: '0' };
    },
  });
  const response = await handler(new Request(url, { method }));
  expect(response.status).toBe(status);
  expect(matchesQueryReference('count', response.status, await response.json())).toBe(true);
});

it.each([
  () => Response.json({ count: '1' }),
  () =>
    new Response('{"count":"1"}', {
      headers: { 'cache-control': 'no-store', 'content-type': 'text/plain' },
    }),
  () => Response.json({ count: 1 }, { headers: { 'cache-control': 'no-store' } }),
  () =>
    new Response('private invalid JSON', {
      headers: { 'cache-control': 'no-store', 'content-type': 'application/json' },
    }),
])(
  'rejects incompatible wire headers or bodies without exposing their contents',
  async (response) => {
    await expect(readQueryReferenceResponse('count', response())).rejects.toThrow(
      /^(Query response did not match the reference contract|Reference query response could not be decoded)$/,
    );
  },
);

it('reads a conforming wire response without changing the decimal value', async () => {
  const response = Response.json(
    { count: '18446744073709551615' },
    { headers: { 'cache-control': 'no-store' } },
  );
  expect(await readQueryReferenceResponse('count', response)).toEqual({
    count: '18446744073709551615',
  });
});
