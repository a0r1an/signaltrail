import { expect, it } from 'vitest';
import { createPostgresMembershipDatabase } from '../../src/index.ts';

it.each([
  { connectionString: 'not-a-url' },
  { connectionString: 'https://user:password@localhost/database' },
  { connectionString: 'postgres://user:password@localhost/database?options=unsafe' },
  { connectionString: 'postgres://user:password@localhost/' },
  { maxConnections: 0 },
  { maxInFlight: 0 },
  { timeoutMs: 0 },
  { timeoutMs: 10001 },
  { connectionString: 'postgres://reader@localhost/database' },
  { connectionString: 'postgres://reader:fixture@localhost:0/database' },
  { connectionString: 'postgres://reader:fixture@localhost/database#fragment' },
  { maxConnections: 33 },
  { maxInFlight: 129 },
])('rejects invalid database configuration without opening a connection', (invalid) => {
  expect(() =>
    createPostgresMembershipDatabase({
      connectionString: 'postgres://reader:fixture@127.0.0.1:35433/signaltrail',
      ...invalid,
    }),
  ).toThrow('Invalid PostgreSQL adapter configuration');
});

const configuration = {
  connectionString: 'postgres://reader:fixture@127.0.0.1:35433/signaltrail',
  tls: false,
};

it('rejects pre-cancelled work without admission and closes idempotently', async () => {
  const database = createPostgresMembershipDatabase(configuration);
  const controller = new AbortController();
  controller.abort();
  await expect(
    database.query({ text: 'SELECT 1', values: [], signal: controller.signal }),
  ).rejects.toThrow('PostgreSQL query was not confirmed');
  expect(database.snapshot().inFlight).toBe(0);
  const closing = database.close();
  expect(database.close()).toBe(closing);
  await closing;
  expect(database.snapshot().closed).toBe(true);
  await expect(
    database.query({ text: 'SELECT 1', values: [], signal: new AbortController().signal }),
  ).rejects.toThrow('PostgreSQL query was not confirmed');
});

it.each([
  { text: '' },
  { text: 'x'.repeat(16385) },
  { values: ['x'.repeat(4097)] },
  { values: ['\0'] },
  { values: ['\ud800'] },
  { values: Array.from({ length: 17 }, () => 'value') },
])('rejects malformed internal query input before acquiring a connection', async (invalid) => {
  const database = createPostgresMembershipDatabase(configuration);
  try {
    const result = expect(
      database.query({
        text: 'SELECT 1',
        values: [],
        signal: new AbortController().signal,
        ...invalid,
      }),
    ).rejects.toThrow('PostgreSQL query was not confirmed');
    expect(database.snapshot().inFlight).toBe(0);
    await result;
  } finally {
    await database.close();
  }
});
