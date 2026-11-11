import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { INGESTION_KEY_CHANNEL, startIngestionKeyListener } from '../../src/index.ts';

class FakeClient extends EventEmitter {
  queries: string[] = [];
  ended = false;
  async query(text: string) {
    this.queries.push(text);
    return { rows: [] };
  }
  async end() {
    this.ended = true;
  }
}
afterEach(() => vi.useRealTimers());
const hash = 'ab'.repeat(32);

function setup(connect?: () => Promise<FakeClient>) {
  const clients: FakeClient[] = [];
  const events: unknown[] = [];
  const listener = startIngestionKeyListener({
    connect:
      connect ??
      (async () => {
        const client = new FakeClient();
        clients.push(client);
        return client;
      }),
    retryMs: 1000,
    onTrusted: (trusted) => events.push(['trusted', trusted]),
    onInvalidate: (keyHash) => events.push(['invalidate', keyHash]),
    onClear: () => events.push(['clear']),
  });
  return { listener, clients, events };
}

it('listens on the key channel and reports trust only once LISTEN succeeded', async () => {
  const { listener, clients, events } = setup();
  await vi.waitFor(() => expect(events).toEqual([['trusted', true]]));
  expect(clients[0]!.queries).toEqual([`LISTEN ${INGESTION_KEY_CHANNEL}`]);
  await listener.stop();
});

it('invalidates hashed keys and clears for anything else', async () => {
  const { listener, clients, events } = setup();
  await vi.waitFor(() => expect(clients).toHaveLength(1));
  await vi.waitFor(() => expect(events).toHaveLength(1));
  const notify = (payload: string, channel = INGESTION_KEY_CHANNEL) =>
    clients[0]!.emit('notification', { channel, payload });
  notify(hash);
  notify('all');
  notify('not-a-hash');
  notify(hash, 'other_channel');
  expect(events.slice(1)).toEqual([['invalidate', hash], ['clear'], ['clear']]);
  await listener.stop();
});

it('distrusts on connection loss and reconnects after the retry delay', async () => {
  vi.useFakeTimers();
  const { listener, clients, events } = setup();
  await vi.waitFor(() => expect(events).toEqual([['trusted', true]]));
  clients[0]!.emit('error', new Error('connection reset'));
  expect(events.at(-1)).toEqual(['trusted', false]);
  expect(clients[0]!.ended).toBe(true);
  await vi.advanceTimersByTimeAsync(999);
  expect(clients).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);
  await vi.waitFor(() => expect(events.at(-1)).toEqual(['trusted', true]));
  expect(clients).toHaveLength(2);
  clients[1]!.emit('end');
  expect(events.at(-1)).toEqual(['trusted', false]);
  await listener.stop();
});

it('retries failed connections and stops cleanly without reconnecting', async () => {
  vi.useFakeTimers();
  let attempts = 0;
  const { listener, events } = setup(async () => {
    attempts++;
    throw new Error('refused');
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(attempts).toBe(1);
  await vi.advanceTimersByTimeAsync(1000);
  expect(attempts).toBe(2);
  expect(events).toEqual([]);
  await listener.stop();
  await vi.advanceTimersByTimeAsync(5000);
  expect(attempts).toBe(2);
});
