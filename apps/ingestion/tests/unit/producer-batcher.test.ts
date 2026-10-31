import { expect, it, vi } from 'vitest';
import { createProducerBatcher } from '../../src/producer-batcher.ts';
const message = (id: string) => ({ key: 'session', value: id, headers: { 'event-id': id } });

it('coalesces same-turn publications into separate records and waits for their shared acknowledgement', async () => {
  let acknowledge!: () => void;
  const send = vi.fn<(messages: unknown[]) => Promise<void>>(
    () =>
      new Promise((resolve) => {
        acknowledge = resolve;
      }),
  );
  const batcher = createProducerBatcher(send);
  let confirmed = 0;
  const pending = ['first', 'second'].map((id) =>
    batcher.enqueue(message(id)).then(() => {
      confirmed++;
    }),
  );
  await vi.waitFor(() => expect(send).toHaveBeenCalled());
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0]![0]).toEqual([message('first'), message('second')]);
  expect(confirmed).toBe(0);
  acknowledge();
  await Promise.all(pending);
  expect(confirmed).toBe(2);
});

it('bounds each producer request to 100 records while preserving enqueue order', async () => {
  const send = vi.fn<(messages: unknown[]) => Promise<void>>(async () => {});
  const batcher = createProducerBatcher(send);
  await Promise.all(
    Array.from({ length: 205 }, (_, index) => batcher.enqueue(message(String(index)))),
  );
  expect(send.mock.calls.map(([messages]) => messages.length)).toEqual([100, 100, 5]);
  expect(send.mock.calls.flatMap(([messages]) => messages)).toEqual(
    Array.from({ length: 205 }, (_, index) => message(String(index))),
  );
});

it('bounds coalesced UTF-8 payload bytes independently from the record-count cap', async () => {
  const send = vi.fn<(messages: unknown[]) => Promise<void>>(async () => {});
  const batcher = createProducerBatcher(send);
  const first = { ...message('first'), value: 'é'.repeat(70000) };
  const second = { ...message('second'), value: 'é'.repeat(70000) };
  await Promise.all([batcher.enqueue(first), batcher.enqueue(second)]);
  expect(send.mock.calls.map(([messages]) => messages.length)).toEqual([1, 1]);
});

it.each(['sync', 'async'] as const)(
  'rejects every unconfirmed record on %s send failure and permits a later batch',
  async (failure) => {
    let calls = 0;
    const failed = new Error('unconfirmed');
    const batcher = createProducerBatcher(() => {
      if (++calls > 1) return Promise.resolve();
      if (failure === 'sync') throw failed;
      return Promise.reject(failed);
    });
    const outcomes = await Promise.allSettled([
      batcher.enqueue(message('first')),
      batcher.enqueue(message('second')),
    ]);
    expect(outcomes).toEqual([
      { status: 'rejected', reason: failed },
      { status: 'rejected', reason: failed },
    ]);
    await expect(batcher.enqueue(message('third'))).resolves.toBeUndefined();
    expect(calls).toBe(2);
  },
);
