import { expect, it } from 'vitest';
import { createPublicationCapacity } from '../../src/publication-capacity.ts';

it('holds capacity after caller cancellation until the underlying publication settles', async () => {
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const capacity = createPublicationCapacity({ maxEvents: 1, maxBytes: 8 });
  const controller = new AbortController();
  const sending = capacity.run('hello', controller.signal, () => pending);
  const cancelled = expect(sending).rejects.toThrow();
  controller.abort();
  await cancelled;
  await expect(capacity.run('x', new AbortController().signal, async () => {})).rejects.toThrow(
    'capacity',
  );
  finish();
  await expect.poll(() => capacity.snapshot().outstandingEvents).toBe(0);
  await expect(
    capacity.run('x', new AbortController().signal, async () => {}),
  ).resolves.toBeUndefined();
});

it('counts UTF-8 bytes and atomically bounds concurrent callers', async () => {
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const capacity = createPublicationCapacity({ maxEvents: 10, maxBytes: 4 });
  let sends = 0;
  const signal = new AbortController().signal;
  const first = capacity.run('éé', signal, () => {
    sends++;
    return pending;
  });
  await expect(
    capacity.run('a', signal, async () => {
      sends++;
    }),
  ).rejects.toThrow('capacity');
  expect(capacity.snapshot()).toMatchObject({
    outstandingEvents: 1,
    outstandingBytes: 4,
    refused: 1,
  });
  expect(sends).toBe(1);
  finish();
  await first;
  expect(capacity.snapshot()).toMatchObject({
    outstandingEvents: 0,
    outstandingBytes: 0,
    completed: 1,
  });
});

it('releases reservations on synchronous and asynchronous send failure', async () => {
  const capacity = createPublicationCapacity({ maxEvents: 1, maxBytes: 4 });
  const signal = new AbortController().signal;
  await expect(
    capacity.run('a', signal, () => {
      throw new Error('sync');
    }),
  ).rejects.toThrow('sync');
  await expect(capacity.run('a', signal, () => Promise.reject(new Error('async')))).rejects.toThrow(
    'async',
  );
  expect(capacity.snapshot()).toMatchObject({
    outstandingEvents: 0,
    outstandingBytes: 0,
    failed: 2,
  });
});

it('does not admit work cancelled before it starts', async () => {
  const capacity = createPublicationCapacity({ maxEvents: 1, maxBytes: 4 });
  const controller = new AbortController();
  controller.abort();
  let sent = false;
  await expect(
    capacity.run('a', controller.signal, async () => {
      sent = true;
    }),
  ).rejects.toThrow();
  expect(sent).toBe(false);
  expect(capacity.snapshot().outstandingEvents).toBe(0);
});
