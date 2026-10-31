import { expect, it, vi } from 'vitest';
import { createClickHouseWriter } from '../../src/clickhouse-writer.ts';
import { record } from '../fixtures.ts';

it('sends a JSONEachRow insert and waits for server acknowledgement', async () => {
  const requests: { url: string; init: RequestInit | undefined }[] = [];
  let acknowledge!: () => void;
  const write = createClickHouseWriter({
    endpoint: 'http://clickhouse:8123',
    database: 'signaltrail',
    username: 'writer',
    password: 'test-password',
    fetch: async (url, init) => {
      requests.push({ url: String(url), init });
      await new Promise<void>((resolve) => {
        acknowledge = resolve;
      });
      return new Response(null, { status: 200 });
    },
  });
  let completed = false;
  const pending = write(record).then(() => {
    completed = true;
  });
  expect(requests).toHaveLength(1);
  expect(new URL(requests[0]!.url).searchParams.get('query')).toBe(
    'INSERT INTO signaltrail.analytics_events FORMAT JSONEachRow',
  );
  expect(JSON.parse(requests[0]!.init!.body as string)).toMatchObject({
    project_id: 'trusted-project',
    event_id: 'stable-id',
    client_timestamp: record.event.clientTimestamp,
  });
  expect(completed).toBe(false);
  acknowledge();
  await pending;
  expect(completed).toBe(true);
});

it.each([200, 500])(
  'does not treat an HTTP %i error payload as a confirmed insert or expose its contents',
  async (status) => {
    const write = createClickHouseWriter({
      endpoint: 'http://clickhouse:8123',
      username: 'writer',
      password: 'test-password',
      fetch: async () =>
        new Response('Code: 27. DB::Exception: secret-customer-payload', { status }),
    });
    await expect(write(record)).rejects.toThrow('ClickHouse insert was not acknowledged');
    try {
      await write(record);
    } catch (error) {
      expect(String(error)).not.toContain('secret-customer-payload');
      expect(String(error)).not.toContain('test-password');
    }
  },
);

it('bounds an unresponsive insert and aborts the request without confirming it', async () => {
  vi.useFakeTimers();
  let signal: AbortSignal | undefined;
  try {
    const write = createClickHouseWriter({
      endpoint: 'http://clickhouse:8123',
      username: 'writer',
      password: 'test-password',
      timeoutMs: 25,
      fetch: async (_url, init) => {
        signal = init?.signal ?? undefined;
        return new Promise(() => {});
      },
    });
    let outcome;
    void write(record).then(
      () => {
        outcome = 'confirmed';
      },
      () => {
        outcome = 'unconfirmed';
      },
    );
    await vi.advanceTimersByTimeAsync(26);
    expect(outcome).toBe('unconfirmed');
    expect(signal?.aborted).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

it('bounds response buffering and cancels an oversized acknowledgement body', async () => {
  let reads = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (++reads > 100) controller.close();
      else controller.enqueue(new Uint8Array(1024).fill(32));
    },
    cancel() {
      cancelled = true;
    },
  });
  const write = createClickHouseWriter({
    endpoint: 'http://clickhouse:8123',
    username: 'writer',
    password: 'test-password',
    fetch: async () => new Response(body, { status: 200 }),
  });
  await expect(write(record)).rejects.toThrow('ClickHouse insert was not acknowledged');
  expect(reads).toBeLessThan(20);
  expect(cancelled).toBe(true);
});

it('rejects an exception header even when the HTTP body is empty', async () => {
  const write = createClickHouseWriter({
    endpoint: 'http://clickhouse:8123',
    username: 'writer',
    password: 'test-password',
    fetch: async () =>
      new Response(null, { status: 200, headers: { 'X-ClickHouse-Exception-Code': '27' } }),
  });
  await expect(write(record)).rejects.toThrow('ClickHouse insert was not acknowledged');
});

it.each([
  { database: 'signaltrail;DROP DATABASE system' },
  { table: 'events FORMAT Values' },
  { endpoint: 'file:///tmp/events' },
  { endpoint: 'http://writer:secret@clickhouse:8123' },
  { endpoint: 'http://clickhouse:8123?query=SELECT+1' },
  { username: 'writer\r\nInjected: value' },
])('rejects unsafe connection or identifier configuration: %j', (invalid) => {
  expect(() =>
    createClickHouseWriter({
      endpoint: 'http://clickhouse:8123',
      username: 'writer',
      password: 'test-password',
      ...invalid,
    }),
  ).toThrow();
});

it('covers a stalled response body with the same deadline and cancels it', async () => {
  vi.useFakeTimers();
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
    },
  });
  try {
    const write = createClickHouseWriter({
      endpoint: 'http://clickhouse:8123',
      username: 'writer',
      password: 'test-password',
      timeoutMs: 25,
      fetch: async () => new Response(body),
    });
    const outcome = expect(write(record)).rejects.toThrow('ClickHouse insert was not acknowledged');
    await vi.advanceTimersByTimeAsync(26);
    await outcome;
    expect(cancelled).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

it('keeps SQL-like event names in row data rather than interpolating them into the query', async () => {
  let target = '';
  let row;
  const eventName = "'); DROP TABLE analytics_events; --";
  const write = createClickHouseWriter({
    endpoint: 'http://clickhouse:8123',
    username: 'writer',
    password: 'test-password',
    fetch: async (url, init) => {
      target = String(url);
      row = JSON.parse(init!.body as string);
      return new Response(null);
    },
  });
  await write({ ...record, event: { ...record.event, eventName } });
  expect(new URL(target).searchParams.get('query')).not.toContain(eventName);
  expect(row).toHaveProperty('event_name', eventName);
  expect(new URL(target).searchParams.get('wait_end_of_query')).toBe('1');
  expect(new URL(target).searchParams.get('async_insert')).toBe('0');
});

it.each([202, 204])('does not infer a durable ClickHouse insert from HTTP %i', async (status) => {
  const write = createClickHouseWriter({
    endpoint: 'http://clickhouse:8123',
    username: 'writer',
    password: 'test-password',
    fetch: async () => new Response(null, { status }),
  });
  await expect(write(record)).rejects.toThrow('ClickHouse insert was not acknowledged');
});

it('preserves credential whitespace through HTTP authentication without putting it in the URL', async () => {
  let authorization: string | null = null;
  let target = '';
  const password = ' password-with-spaces ';
  const write = createClickHouseWriter({
    endpoint: 'http://clickhouse:8123',
    username: 'writer',
    password,
    fetch: async (url, init) => {
      target = String(url);
      authorization = new Headers(init?.headers).get('Authorization');
      return new Response(null);
    },
  });
  await write(record);
  expect(authorization).toBe('Basic ' + Buffer.from('writer:' + password).toString('base64'));
  expect(target).not.toContain('password-with-spaces');
});
