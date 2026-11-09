import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

export async function exercisePostgresAdapter({ database, sql, poolErrors }) {
  const waitFor = async (check) => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (await check()) return;
      await delay(20);
    }
    throw new Error('PostgreSQL adapter probe did not reach its expected state');
  };
  const query = (text, values = [], signal = new AbortController().signal) =>
    database.query({ text, values, signal });
  const activeSleep = () =>
    sql(
      "SELECT count(*) FROM pg_stat_activity WHERE application_name='signaltrail-project-access' AND state='active' AND query LIKE 'SELECT pg_sleep%'",
    ).then((value) => value.trim() === '1');
  const observe = (promise) =>
    promise.then(
      () => true,
      () => false,
    );
  const firstController = new AbortController();
  const slow = observe(
    query('SELECT pg_sleep($1::double precision)', ['5'], firstController.signal),
  );
  await waitFor(activeSleep);
  const queuedController = new AbortController();
  const queued = observe(query('SELECT $1::text AS value', ['queued'], queuedController.signal));
  await waitFor(() => database.snapshot().waiting === 1);
  await delay(150); // Keep real pool contention long enough to measure.
  queuedController.abort();
  assert.equal(await queued, false);
  assert.equal(
    database.snapshot().inFlight,
    2,
    'Cancelled acquisition must retain its capacity slot',
  );
  await assert.rejects(query('SELECT 1'), /^Error: PostgreSQL query was not confirmed$/);
  firstController.abort();
  assert.equal(await slow, false);
  await waitFor(() => database.snapshot().inFlight === 0);
  assert.deepEqual(await query('SELECT 1::text AS value'), { rows: [{ value: '1' }] });

  const hold = query('SELECT pg_sleep($1::double precision)', ['0.5']);
  await waitFor(activeSleep);
  const values = ['original'];
  const snapshotted = query('SELECT $1::text AS value', values);
  await waitFor(() => database.snapshot().waiting === 1);
  values[0] = 'changed-after-submit';
  await hold;
  assert.deepEqual(await snapshotted, { rows: [{ value: 'original' }] });
  const diagnostics = database.snapshot();
  assert.ok(diagnostics.connectionWaitMs.max >= 100, 'Must retain connection queue wait');
  assert.ok(diagnostics.queryExecutionMs.max >= 100, 'Must retain slow execution');
  assert.ok(diagnostics.connectionWaitMs.count > 0);
  assert.ok(diagnostics.queryExecutionMs.count > 0);
  assert.ok(diagnostics.peakInFlight >= 2);
  assert.ok(diagnostics.peakExecuting >= 1);
  assert.ok(diagnostics.refused >= 1);
  assert.ok(diagnostics.recentRefusals[0].waiting >= 1);
  assert.equal(diagnostics.executing, 0);
  assert.deepEqual(await query('SHOW default_transaction_read_only'), {
    rows: [{ default_transaction_read_only: 'on' }],
  });
  await assert.rejects(
    query('CREATE TABLE signaltrail_control.unexpected_write(id integer)'),
    /^Error: PostgreSQL query was not confirmed$/,
  );
  assert.equal(
    (await sql("SELECT to_regclass('signaltrail_control.unexpected_write') IS NULL")).trim(),
    't',
  );
  await assert.rejects(query('SELECT 1; SELECT 2'), /^Error: PostgreSQL query was not confirmed$/);
  await assert.rejects(
    query('SELECT pg_sleep($1::double precision)', ['5']),
    /^Error: PostgreSQL query was not confirmed$/,
  );
  await waitFor(() => database.snapshot().inFlight === 0);
  assert.deepEqual(await query('SELECT 1::text AS value'), { rows: [{ value: '1' }] });

  const errorsBeforeIdleFailure = poolErrors();
  await sql(
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name='signaltrail-project-access' AND state='idle'",
  );
  await waitFor(() => poolErrors() > errorsBeforeIdleFailure);
  assert.deepEqual(await query('SELECT 1::text AS value'), { rows: [{ value: '1' }] });
  const terminated = observe(query('SELECT pg_sleep($1::double precision)', ['5']));
  await waitFor(activeSleep);
  await sql(
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name='signaltrail-project-access' AND state='active' AND query LIKE 'SELECT pg_sleep%'",
  );
  assert.equal(await terminated, false);
  await waitFor(() => database.snapshot().inFlight === 0);
  assert.deepEqual(await query('SELECT 1::text AS value'), { rows: [{ value: '1' }] });

  const duringClose = observe(query('SELECT pg_sleep($1::double precision)', ['5']));
  await waitFor(activeSleep);
  const queuedDuringClose = observe(query('SELECT 1'));
  await waitFor(() => database.snapshot().waiting === 1);
  await database.close();
  assert.equal(await duringClose, false);
  assert.equal(await queuedDuringClose, false);
  assert.equal(database.snapshot().inFlight, 0);
  assert.equal(database.snapshot().waiting, 0);
  assert.equal(database.snapshot().closed, true);
  await assert.rejects(query('SELECT 1'), /^Error: PostgreSQL query was not confirmed$/);
  return {
    boundAcquisition: true,
    cancellationRetainsCapacity: true,
    inputSnapshots: true,
    readOnlyDefault: true,
    statementDeadline: true,
    backendFailureRecovery: true,
    shutdownVerified: true,
  };
}
