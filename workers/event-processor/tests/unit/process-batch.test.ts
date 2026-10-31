import { expect, it, vi } from 'vitest';
import { createBatchProcessor } from '../../src/process-batch.ts';
import type { PublishedAnalyticsEvent } from '@signaltrail/contracts';
import { record } from '../fixtures.ts';

it('waits for the entire storage batch before committing its next source offset', async () => {
  let acknowledge!: () => void;
  const commit = vi.fn(async () => {});
  const writeEvents = vi.fn<(records: readonly PublishedAnalyticsEvent[]) => Promise<void>>(
    async () =>
      new Promise<void>((resolve) => {
        acknowledge = resolve;
      }),
  );
  const process = createBatchProcessor({ writeEvents, commit, writeDeadLetter: async () => {} });
  const messages = [0, 1].map((index) => ({
    topic: 'events',
    partition: 0,
    offset: String(index),
    value: Buffer.from(
      JSON.stringify({ ...record, event: { ...record.event, eventId: `event-${index}` } }),
    ),
  }));
  const pending = process(messages);
  await vi.waitFor(() => expect(writeEvents).toHaveBeenCalledTimes(1));
  expect(writeEvents.mock.calls[0]).toHaveLength(1);
  expect(writeEvents.mock.calls[0]![0]).toHaveLength(2);
  expect(commit).not.toHaveBeenCalled();
  acknowledge();
  await expect(pending).resolves.toEqual(['stored', 'stored']);
  expect(commit.mock.calls).toEqual([[{ topic: 'events', partition: 0, offset: '2' }]]);
});

it('rejects mixed partitions, descending offsets and excessive chunks before any side effects', async () => {
  const writeEvents = vi.fn(async () => {});
  const writeDeadLetter = vi.fn(async () => {});
  const commit = vi.fn(async () => {});
  const process = createBatchProcessor({ writeEvents, writeDeadLetter, commit });
  const first = {
    topic: 'events',
    partition: 0,
    offset: '0',
    value: Buffer.from(JSON.stringify(record)),
  };
  for (const messages of [
    [first, { ...first, partition: 1, offset: '1' }],
    [{ ...first, offset: '2' }, first],
    Array.from({ length: 101 }, (_, index) => ({ ...first, offset: String(index) })),
  ])
    await expect(process(messages)).rejects.toThrow();
  expect(writeEvents).not.toHaveBeenCalled();
  expect(writeDeadLetter).not.toHaveBeenCalled();
  expect(commit).not.toHaveBeenCalled();
});

it.each(['storage', 'dead-letter', 'commit'] as const)(
  'replays the same IDs after a %s failure without prematurely advancing',
  async (failure) => {
    let fail = true;
    const commit = vi.fn(async () => {
      if (fail && failure === 'commit') throw new Error('unconfirmed');
    });
    const writeEvents = vi.fn<(records: readonly PublishedAnalyticsEvent[]) => Promise<void>>(
      async () => {
        if (fail && failure === 'storage') throw new Error('unconfirmed');
      },
    );
    const writeDeadLetter = vi.fn(async () => {
      if (fail && failure === 'dead-letter') throw new Error('unconfirmed');
    });
    const process = createBatchProcessor({ writeEvents, writeDeadLetter, commit });
    const messages = [Buffer.from(JSON.stringify(record)), Buffer.from('invalid')].map(
      (value, index) => ({ topic: 'events', partition: 0, offset: String(index), value }),
    );
    await expect(process(messages)).rejects.toThrow('unconfirmed');
    expect(commit).toHaveBeenCalledTimes(failure === 'commit' ? 1 : 0);
    fail = false;
    await expect(process(messages)).resolves.toEqual(['stored', 'dead_lettered']);
    expect(writeEvents.mock.lastCall![0][0]!.event.eventId).toBe('stable-id');
    expect(commit.mock.lastCall).toEqual([{ topic: 'events', partition: 0, offset: '2' }]);
  },
);

it('captures source buffers and cursors before awaiting a dead-letter acknowledgement', async () => {
  let acknowledge!: () => void;
  const writeDeadLetter = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        acknowledge = resolve;
      }),
  );
  const writeEvents = vi.fn<(records: readonly PublishedAnalyticsEvent[]) => Promise<void>>(
    async () => {},
  );
  const commit = vi.fn(async () => {});
  const process = createBatchProcessor({ writeEvents, writeDeadLetter, commit });
  const messages = [
    { topic: 'events', partition: 0, offset: '0', value: Buffer.from('broken') },
    { topic: 'events', partition: 0, offset: '1', value: Buffer.from(JSON.stringify(record)) },
  ];
  const pending = process(messages);
  messages[1]!.offset = '999';
  messages[1]!.value.fill(0);
  acknowledge();
  await expect(pending).resolves.toEqual(['dead_lettered', 'stored']);
  expect(writeEvents.mock.lastCall![0][0]!.event.eventId).toBe('stable-id');
  expect(commit.mock.lastCall).toEqual([{ topic: 'events', partition: 0, offset: '2' }]);
});

it('allows a single oversized poison record into the bounded dead-letter path', async () => {
  const writeEvents = vi.fn(async () => {});
  const letters: { payloadBase64: string | null; reason: string }[] = [];
  const commit = vi.fn(async () => {});
  const process = createBatchProcessor({
    writeEvents,
    commit,
    writeDeadLetter: async (letter) => {
      letters.push(letter);
    },
  });
  await expect(
    process([
      {
        topic: 'events',
        partition: 0,
        offset: '9007199254740993',
        value: new Uint8Array(1024 * 1024 + 1),
      },
    ]),
  ).resolves.toEqual(['dead_lettered']);
  expect(letters).toMatchObject([{ reason: 'MESSAGE_TOO_LARGE', payloadBase64: null }]);
  expect(writeEvents).not.toHaveBeenCalled();
  expect(commit.mock.lastCall).toEqual([
    { topic: 'events', partition: 0, offset: '9007199254740994' },
  ]);
});

it('rejects a multi-record chunk above the source byte cap before writing either sink', async () => {
  const writeEvents = vi.fn(async () => {});
  const writeDeadLetter = vi.fn(async () => {});
  const commit = vi.fn(async () => {});
  const process = createBatchProcessor({ writeEvents, writeDeadLetter, commit });
  await expect(
    process(
      [0, 1].map((index) => ({
        topic: 'events',
        partition: 0,
        offset: String(index),
        value: new Uint8Array(600 * 1024),
      })),
    ),
  ).rejects.toThrow('Processor chunk exceeds 1 MiB');
  expect(writeEvents).not.toHaveBeenCalled();
  expect(writeDeadLetter).not.toHaveBeenCalled();
  expect(commit).not.toHaveBeenCalled();
});

it('stops between sink writes on shutdown without committing a partial chunk', async () => {
  const controller = new AbortController();
  const writeDeadLetter = vi.fn(async () => {
    controller.abort();
  });
  const writeEvents = vi.fn(async () => {});
  const commit = vi.fn(async () => {});
  const process = createBatchProcessor({
    signal: controller.signal,
    writeDeadLetter,
    writeEvents,
    commit,
  });
  await expect(
    process(
      [0, 1].map((index) => ({
        topic: 'events',
        partition: 0,
        offset: String(index),
        value: Buffer.from('broken'),
      })),
    ),
  ).rejects.toThrow();
  expect(writeDeadLetter).toHaveBeenCalledTimes(1);
  expect(writeEvents).not.toHaveBeenCalled();
  expect(commit).not.toHaveBeenCalled();
});
