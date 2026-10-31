import { expect, it } from 'vitest';
import { createEventProcessor } from '../../src/process-message.ts';

const record = {
  projectId: 'trusted-project',
  receivedAt: '2026-10-30T23:00:00.000Z',
  event: {
    schemaVersion: 1,
    eventId: 'stable-id',
    eventName: 'view',
    distinctId: 'visitor',
    sessionId: 'session',
    sequence: 0,
    clientTimestamp: '2026-10-30T22:59:59.000Z',
    url: 'https://example.com',
    properties: {},
    context: { sdkVersion: '0.1.0' },
  },
};
const message = {
  topic: 'analytics',
  partition: 0,
  offset: '9007199254740993',
  value: Buffer.from(JSON.stringify(record)),
};

it('stores a valid event before committing the exact next broker offset', async () => {
  const operations: unknown[] = [];
  const processMessage = createEventProcessor({
    writeEvent: async (event) => {
      operations.push(event);
    },
    writeDeadLetter: async () => {
      throw new Error('Unexpected dead letter');
    },
    commit: async (cursor) => {
      operations.push(cursor);
    },
  });
  await processMessage(message);
  expect(operations).toEqual([
    record,
    { topic: 'analytics', partition: 0, offset: '9007199254740994' },
  ]);
});

it('commits the captured source cursor even if the caller changes the message while storage is pending', async () => {
  let finishWrite!: () => void;
  const committed: unknown[] = [];
  const processMessage = createEventProcessor({
    writeEvent: () =>
      new Promise<void>((resolve) => {
        finishWrite = resolve;
      }),
    writeDeadLetter: async () => {},
    commit: async (cursor) => {
      committed.push(cursor);
    },
  });
  const mutable = { ...message };
  const processing = processMessage(mutable);
  mutable.topic = 'other-project';
  mutable.partition = 2;
  mutable.offset = '1';
  expect(committed).toEqual([]);
  finishWrite();
  await processing;
  expect(committed).toEqual([{ topic: 'analytics', partition: 0, offset: '9007199254740994' }]);
});

it('acknowledges a malformed message in the dead-letter sink before advancing its source offset', async () => {
  const operations: unknown[] = [];
  const invalid = Buffer.from('{broken-json');
  const processMessage = createEventProcessor({
    writeEvent: async () => {
      throw new Error('Invalid message reached analytical storage');
    },
    writeDeadLetter: async (letter) => {
      operations.push(letter);
    },
    commit: async (cursor) => {
      operations.push(cursor);
    },
  });
  expect(await processMessage({ ...message, value: invalid })).toEqual({ status: 'dead_lettered' });
  expect(operations).toHaveLength(2);
  expect(operations[0]).toMatchObject({
    schemaVersion: 1,
    reason: 'INVALID_JSON',
    source: { topic: 'analytics', partition: 0, offset: message.offset },
    payloadBytes: invalid.byteLength,
    payloadBase64: invalid.toString('base64'),
  });
  expect(operations[1]).toEqual({ topic: 'analytics', partition: 0, offset: '9007199254740994' });
});

it('dead-letters syntactically valid JSON that violates the broker contract', async () => {
  const letters: unknown[] = [];
  const committed: unknown[] = [];
  const processMessage = createEventProcessor({
    writeEvent: async () => {
      throw new Error('Invalid record stored');
    },
    writeDeadLetter: async (letter) => {
      letters.push(letter);
    },
    commit: async (cursor) => {
      committed.push(cursor);
    },
  });
  await processMessage({
    ...message,
    value: Buffer.from(JSON.stringify({ ...record, projectId: '' })),
  });
  expect(letters).toHaveLength(1);
  expect(letters[0]).toMatchObject({ reason: 'INVALID_RECORD' });
  expect(committed).toHaveLength(1);
});

it('preserves invalid UTF-8 bytes in dead letters instead of silently changing an event ID', async () => {
  const encoded = JSON.stringify(record).split('stable-id');
  const invalid = Buffer.concat([
    Buffer.from(encoded[0]!),
    Buffer.from([0xff]),
    Buffer.from(encoded[1]!),
  ]);
  const stored: unknown[] = [];
  const letters: unknown[] = [];
  const processMessage = createEventProcessor({
    writeEvent: async (event) => {
      stored.push(event);
    },
    writeDeadLetter: async (letter) => {
      letters.push(letter);
    },
    commit: async () => {},
  });
  await processMessage({ ...message, value: invalid });
  expect(stored).toEqual([]);
  expect(letters[0]).toMatchObject({
    reason: 'INVALID_JSON',
    payloadBase64: invalid.toString('base64'),
  });
});

it('does not commit or dead-letter an event when analytical storage fails', async () => {
  const committed: unknown[] = [];
  const letters: unknown[] = [];
  const failure = new Error('Storage unavailable');
  const processMessage = createEventProcessor({
    writeEvent: async () => {
      throw failure;
    },
    writeDeadLetter: async (letter) => {
      letters.push(letter);
    },
    commit: async (cursor) => {
      committed.push(cursor);
    },
  });
  await expect(processMessage(message)).rejects.toBe(failure);
  expect(committed).toEqual([]);
  expect(letters).toEqual([]);
});

it('does not commit a poison message when the dead-letter sink cannot acknowledge it', async () => {
  const committed: unknown[] = [];
  const failure = new Error('Dead-letter broker unavailable');
  const processMessage = createEventProcessor({
    writeEvent: async () => {},
    writeDeadLetter: async () => {
      throw failure;
    },
    commit: async (cursor) => {
      committed.push(cursor);
    },
  });
  await expect(processMessage({ ...message, value: Buffer.from('broken') })).rejects.toBe(failure);
  expect(committed).toEqual([]);
});

it('returns a failed commit to the caller so acknowledged storage can safely be retried', async () => {
  let writes = 0;
  const failure = new Error('Commit lost');
  const processMessage = createEventProcessor({
    writeEvent: async () => {
      writes++;
    },
    writeDeadLetter: async () => {},
    commit: async () => {
      throw failure;
    },
  });
  await expect(processMessage(message)).rejects.toBe(failure);
  expect(writes).toBe(1);
});

it.each([
  { offset: '-1' },
  { offset: '1.5' },
  { offset: '9223372036854775807' },
  { partition: -1 },
  { partition: 1.5 },
  { topic: '' },
])('rejects invalid source coordinates before side effects: %j', async (invalid) => {
  const effects: string[] = [];
  const processMessage = createEventProcessor({
    writeEvent: async () => {
      effects.push('storage');
    },
    writeDeadLetter: async () => {
      effects.push('dlq');
    },
    commit: async () => {
      effects.push('commit');
    },
  });
  await expect(processMessage({ ...message, ...invalid })).rejects.toThrow();
  expect(effects).toEqual([]);
});

it('dead-letters oversized input with a fingerprint without amplifying the raw payload', async () => {
  const letters: unknown[] = [];
  const value = Buffer.from(
    JSON.stringify({
      ...record,
      event: { ...record.event, properties: { padding: 'x'.repeat(1000) } },
    }),
  );
  const processMessage = createEventProcessor({
    maxMessageBytes: 128,
    writeEvent: async () => {
      throw new Error('Oversized event reached storage');
    },
    writeDeadLetter: async (letter) => {
      letters.push(letter);
    },
    commit: async () => {},
  });
  expect(await processMessage({ ...message, value })).toEqual({ status: 'dead_lettered' });
  expect(letters[0]).toMatchObject({
    reason: 'MESSAGE_TOO_LARGE',
    payloadBytes: value.byteLength,
    payloadBase64: null,
  });
  expect(letters[0]).toHaveProperty('payloadSha256', expect.stringMatching(/^[a-f0-9]{64}$/));
});

it('fingerprints the original bytes with SHA-256 for stable dead-letter diagnostics', async () => {
  let letter;
  const processMessage = createEventProcessor({
    writeEvent: async () => {},
    writeDeadLetter: async (value) => {
      letter = value;
    },
    commit: async () => {},
  });
  await processMessage({ ...message, value: Buffer.from('abc') });
  expect(letter).toHaveProperty(
    'payloadSha256',
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
});

it.each([0, -1, 1.5, NaN, 524289])(
  'rejects an invalid message-size limit: %j',
  (maxMessageBytes) => {
    expect(() =>
      createEventProcessor({
        maxMessageBytes,
        writeEvent: async () => {},
        writeDeadLetter: async () => {},
        commit: async () => {},
      }),
    ).toThrow(RangeError);
  },
);
