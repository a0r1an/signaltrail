import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import {
  createProjectAccessResolver,
  createInitialMigrationStatement,
  createPostgresMembershipDatabase,
} from '../../packages/project-access/dist/index.js';
import {
  createAnalyticsQueryHandler,
  createAnalyticsHttpServer,
  createAnalyticsReader,
} from '../../packages/analytics/dist/index.js';
import { createClickHouseBatchWriter } from '../../workers/event-processor/dist/index.js';
import { readQueryReferenceResponse } from '../../packages/analytics/tests/query-reference.ts';
import { exercisePostgresAdapter } from './postgres-adapter.mjs';

export async function exerciseProjectAccess({ docker, realAnalytics = false }) {
  const sql = (text, signal = AbortSignal.timeout(10000), capture = true) =>
    docker(
      [
        'exec',
        '-T',
        'postgres',
        'psql',
        '--no-psqlrc',
        '-qAt',
        '-v',
        'ON_ERROR_STOP=1',
        '-U',
        'signaltrail',
        '-d',
        'signaltrail',
        '-c',
        text,
      ],
      capture,
      false,
      signal,
    );
  const migrationSource = await readFile(
    new URL('../../infra/postgres/001-project-access.sql', import.meta.url),
    'utf8',
  );
  const migrationStatement = createInitialMigrationStatement(migrationSource);
  const migrate = (statement) => sql(statement, AbortSignal.timeout(15000), 'combined');
  const failsWith = (message) => (error) =>
    error instanceof Error && error.cause instanceof Error && error.cause.message.includes(message);
  const brokenSource = migrationSource.replace('COMMIT;', 'SELECT 1 / 0;\nCOMMIT;');
  await assert.rejects(
    migrate(createInitialMigrationStatement(brokenSource)),
    failsWith('division by zero'),
  );
  assert.equal(
    (
      await sql(
        "SELECT to_regnamespace('signaltrail_control') IS NULL AND to_regnamespace('signaltrail_migrations') IS NULL",
      )
    ).trim(),
    't',
  );
  await sql('CREATE SCHEMA signaltrail_control');
  await assert.rejects(
    migrate(migrationStatement),
    failsWith('schema "signaltrail_control" already exists'),
  );
  assert.equal((await sql("SELECT to_regnamespace('signaltrail_migrations') IS NULL")).trim(), 't');
  await sql('DROP SCHEMA signaltrail_control');
  await Promise.all([migrate(migrationStatement), migrate(migrationStatement)]);
  await migrate(migrationStatement);
  const checksum = createHash('sha256').update(migrationSource).digest('hex');
  assert.equal(
    (
      await sql("SELECT version::text || ':' || checksum FROM signaltrail_migrations.applied")
    ).trim(),
    '1:' + checksum,
  );
  await assert.rejects(
    migrate(createInitialMigrationStatement('BEGIN; SELECT 1; COMMIT;')),
    failsWith('Migration checksum differs'),
  );
  assert.equal((await sql('SELECT count(*) FROM signaltrail_migrations.applied')).trim(), '1');
  await sql(
    "INSERT INTO signaltrail_migrations.applied(version,checksum) VALUES (2,repeat('0',64))",
  );
  await assert.rejects(
    migrate(migrationStatement),
    failsWith('Unsupported control-plane migration version'),
  );
  await sql('DELETE FROM signaltrail_migrations.applied WHERE version=2');
  const id = (n) => '00000000-0000-0000-0000-' + n.toString(16).padStart(12, '0');
  const [userA, userB, orgA, orgB, projectA, projectB] = [1, 2, 3, 4, 11, 12].map(id);
  await sql(`INSERT INTO signaltrail_control.principals(id,issuer,subject) VALUES ('${userA}','issuer-a','same-subject'),('${userB}','issuer-b','same-subject');
    INSERT INTO signaltrail_control.organizations(id,name) VALUES ('${orgA}','A'),('${orgB}','B');
    INSERT INTO signaltrail_control.projects(id,organization_id,name) VALUES ('${projectA}','${orgA}','A'),('${projectB}','${orgB}','B');
    INSERT INTO signaltrail_control.organization_memberships(organization_id,principal_id,role) VALUES ('${orgA}','${userA}','owner'),('${orgB}','${userB}','member');`);
  const identities = new Map([
    ['Bearer fixture-a', { issuer: 'issuer-a', subject: 'same-subject' }],
    ['Bearer fixture-b', { issuer: 'issuer-b', subject: 'same-subject' }],
    ['Bearer fixture-injection', { issuer: 'issuer-a', subject: "same-subject' OR true --" }],
  ]);
  let poolErrorCount = 0;
  const database = createPostgresMembershipDatabase({
    connectionString: 'postgres://signaltrail:signaltrail_local@127.0.0.1:35433/signaltrail',
    tls: false,
    maxConnections: 1,
    maxInFlight: 2,
    timeoutMs: 2000,
    onPoolError: () => {
      poolErrorCount++;
      throw new Error('Fixture diagnostic failure');
    },
  });
  try {
    let lookups = 0;
    const resolve = createProjectAccessResolver({
      resolveIdentity: async (request) =>
        identities.get(request.headers.get('Authorization')) ?? null,
      query: async (input) => {
        lookups++;
        return database.query(input);
      },
    });
    const request = (key) =>
      new Request('https://fixture.invalid', { headers: { Authorization: key } });
    const signal = new AbortController().signal;
    assert.deepEqual(await resolve(request('Bearer fixture-ingestion-key'), projectA, signal), {
      status: 'unauthenticated',
    });
    assert.equal(lookups, 0);
    assert.deepEqual(await resolve(request('Bearer fixture-a'), projectA.toUpperCase(), signal), {
      status: 'authorized',
      projectId: projectA,
    });
    assert.deepEqual(await resolve(request('Bearer fixture-a'), projectB, signal), {
      status: 'forbidden',
    });
    assert.deepEqual(await resolve(request('Bearer fixture-b'), projectA, signal), {
      status: 'forbidden',
    });
    assert.deepEqual(await resolve(request('Bearer fixture-b'), projectB, signal), {
      status: 'authorized',
      projectId: projectB,
    });
    assert.deepEqual(await resolve(request('Bearer fixture-injection'), projectA, signal), {
      status: 'forbidden',
    });
    let reads = 0;
    let reader;
    if (realAnalytics) {
      const connection = {
        endpoint: 'http://127.0.0.1:38123',
        username: 'signaltrail',
        password: 'signaltrail_local',
      };
      const migration = await fetch(connection.endpoint, {
        method: 'POST',
        headers: {
          'X-ClickHouse-User': connection.username,
          'X-ClickHouse-Key': connection.password,
        },
        body: await readFile(
          new URL('../../infra/clickhouse/001-analytics-events.sql', import.meta.url),
          'utf8',
        ),
        signal: AbortSignal.timeout(10000),
      });
      assert.equal(migration.status, 200);
      assert.equal((await migration.text()).trim(), '');
      const event = {
        schemaVersion: 1,
        eventId: 'event-a',
        eventName: 'viewed',
        distinctId: 'fixture-visitor',
        sessionId: 'shared-session',
        sequence: 0,
        clientTimestamp: '2026-11-01T12:00:00.000Z',
        url: 'https://fixture.invalid',
        properties: {},
        context: { sdkVersion: 'fixture' },
      };
      await createClickHouseBatchWriter(connection)([
        { projectId: projectA, receivedAt: event.clientTimestamp, event },
        { projectId: projectB, receivedAt: event.clientTimestamp, event },
        {
          projectId: projectB,
          receivedAt: event.clientTimestamp,
          event: { ...event, eventId: 'event-z', sequence: 1 },
        },
      ]);
      await createClickHouseBatchWriter(connection)(
        ['z', 'a', '0'].map((prefix) => ({
          projectId: projectB,
          receivedAt: '2026-11-02T12:00:00.000Z',
          event: {
            ...event,
            eventId: prefix + '\u0000'.repeat(4095),
            eventName: 'n' + '\u0000'.repeat(4095),
            sessionId: 's' + '\u0000'.repeat(4095),
          },
        })),
      );
      reader = createAnalyticsReader(connection);
    }
    const queryOptions = {
      resolveProjectAccess: resolve,
      countReceivedEvents: async (window, signal) => {
        reads++;
        if (reader) return reader.countReceivedEvents(window, signal);
        assert.equal(window.projectId, projectA);
        return { count: '1' };
      },
      ...(reader
        ? {
            listReceivedEvents: async (window, signal) => {
              reads++;
              return reader.listReceivedEvents(window, signal);
            },
          }
        : {}),
    };
    const handler = createAnalyticsQueryHandler(queryOptions);
    const target = new URL('https://fixture.invalid/v1/analytics/count');
    for (const [key, value] of Object.entries({
      projectId: projectA,
      from: '2026-11-01T00:00:00Z',
      to: '2026-11-02T00:00:00Z',
    }))
      target.searchParams.set(key, value);
    if (realAnalytics) {
      const http = createAnalyticsHttpServer({
        origin: 'https://fixture.invalid',
        query: queryOptions,
      });
      try {
        await new Promise((resolve) => http.server.listen(0, '127.0.0.1', resolve));
        const address = http.server.address();
        assert.ok(address && typeof address !== 'string');
        const wireTarget = new URL(
          target.pathname + target.search,
          `http://127.0.0.1:${address.port}`,
        );
        const denied = await fetch(wireTarget, {
          headers: { Authorization: 'Bearer fixture-b' },
          signal: AbortSignal.timeout(5000),
        });
        assert.equal(denied.status, 403);
        assert.deepEqual(await readQueryReferenceResponse('count', denied), { error: 'FORBIDDEN' });
        assert.equal(reads, 0);
        const allowed = await fetch(wireTarget, {
          headers: { Authorization: 'Bearer fixture-a' },
          signal: AbortSignal.timeout(5000),
        });
        assert.equal(allowed.status, 200);
        assert.equal(allowed.headers.get('cache-control'), 'no-store');
        assert.deepEqual(await readQueryReferenceResponse('count', allowed), { count: '1' });
        wireTarget.pathname = '/v1/analytics/events';
        const listing = await fetch(wireTarget, {
          headers: { Authorization: 'Bearer fixture-a' },
          signal: AbortSignal.timeout(5000),
        });
        assert.equal(listing.status, 200);
        const page = await readQueryReferenceResponse('events', listing);
        assert.deepEqual(
          page.events.map((event) => event.eventId),
          ['event-a'],
        );
        assert.equal(page.hasMore, false);
        wireTarget.searchParams.set('projectId', projectB);
        wireTarget.searchParams.set('from', '2026-11-02T00:00:00Z');
        wireTarget.searchParams.set('to', '2026-11-03T00:00:00Z');
        wireTarget.searchParams.set('limit', '50');
        const getControlPage = async () => {
          const response = await fetch(wireTarget, {
            headers: { Authorization: 'Bearer fixture-b' },
            signal: AbortSignal.timeout(5000),
          });
          assert.equal(response.status, 200);
          return readQueryReferenceResponse('events', response);
        };
        const controlFirst = await getControlPage();
        assert.equal(controlFirst.events[0].eventId, 'z' + '\u0000'.repeat(4095));
        assert.equal(controlFirst.hasMore, true);
        assert.ok(controlFirst.nextCursor.length <= 8192);
        wireTarget.searchParams.set('cursor', controlFirst.nextCursor);
        const controlNext = await getControlPage();
        assert.deepEqual(
          controlNext.events.map((event) => event.eventId),
          ['a', '0'].map((prefix) => prefix + '\u0000'.repeat(4095)),
        );
        assert.equal(controlNext.hasMore, false);
      } finally {
        await http.close();
      }
      reads = 0;
    }

    assert.equal(
      (await handler(new Request(target, { headers: { Authorization: 'Bearer fixture-b' } })))
        .status,
      403,
    );
    assert.equal(reads, 0);
    assert.equal(
      (await handler(new Request(target, { headers: { Authorization: 'Bearer fixture-a' } })))
        .status,
      200,
    );
    assert.equal(reads, 1);
    if (realAnalytics) {
      target.searchParams.set('projectId', projectB);
      const response = await handler(
        new Request(target, { headers: { Authorization: 'Bearer fixture-b' } }),
      );
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { count: '2' });
      target.pathname = '/v1/analytics/events';
      target.searchParams.set('limit', '1');
      target.searchParams.set('sessionId', 'shared-session');
      const firstResponse = await handler(
        new Request(target, { headers: { Authorization: 'Bearer fixture-b' } }),
      );
      assert.equal(firstResponse.status, 200);
      const first = await firstResponse.json();
      assert.deepEqual(
        first.events.map((event) => event.eventId),
        ['event-z'],
      );
      assert.equal(first.hasMore, true);
      target.searchParams.set('cursor', first.nextCursor);
      const nextResponse = await handler(
        new Request(target, { headers: { Authorization: 'Bearer fixture-b' } }),
      );
      assert.equal(nextResponse.status, 200);
      const next = await nextResponse.json();
      assert.deepEqual(
        next.events.map((event) => event.eventId),
        ['event-a'],
      );
      assert.equal(next.hasMore, false);
      target.searchParams.set('sessionId', 'changed-filter');
      assert.equal(
        (await handler(new Request(target, { headers: { Authorization: 'Bearer fixture-b' } })))
          .status,
        400,
      );
      target.searchParams.set('sessionId', 'shared-session');
      target.searchParams.set('projectId', projectA);
      assert.equal(
        (await handler(new Request(target, { headers: { Authorization: 'Bearer fixture-a' } })))
          .status,
        400,
      );
      target.pathname = '/v1/analytics/count';
      for (const key of ['limit', 'sessionId', 'cursor']) target.searchParams.delete(key);
      target.searchParams.set('projectId', projectA);
    }

    await sql(
      `DELETE FROM signaltrail_control.organization_memberships WHERE organization_id='${orgA}' AND principal_id='${userA}'`,
    );
    assert.deepEqual(await resolve(request('Bearer fixture-a'), projectA, signal), {
      status: 'forbidden',
    });
    const readsBeforeRevokedRequest = reads;
    assert.equal(
      (await handler(new Request(target, { headers: { Authorization: 'Bearer fixture-a' } })))
        .status,
      403,
    );
    assert.equal(reads, readsBeforeRevokedRequest);
    await sql(`DO $body$ BEGIN
    BEGIN INSERT INTO signaltrail_control.organization_memberships(organization_id,principal_id,role) VALUES ('${orgA}','${userB}','viewer');
    EXCEPTION WHEN check_violation THEN RETURN; END;
    RAISE EXCEPTION 'Invalid membership role was accepted';
    END $body$;`);
    const adapter = await exercisePostgresAdapter({
      database,
      sql,
      poolErrors: () => poolErrorCount,
    });
    return {
      passed: true,
      issuerIsolation: true,
      crossOrganizationDenied: true,
      membershipRemovalImmediate: true,
      invalidRoleRejected: true,
      queryBoundaryVerified: true,
      migrationReplayVerified: true,
      migrationRollbackVerified: true,
      migrationChecksumVerified: true,
      untrackedSchemaRejected: true,
      unsupportedMigrationVersionRejected: true,
      realClickHouseCountsAndPaging: realAnalytics,
      realHttpAuthorizedReads: realAnalytics,
      maximumIdentifierCursorPaging: realAnalytics,
      adaptiveLargePages: realAnalytics,
      queryReferenceConformance: realAnalytics,
      cursorScopeVerified: realAnalytics,
      adapter,
      limitations: [
        'Fixture identity resolver and credentials only; real pg adapter verified locally, with no production session provider or route deployed.',
      ],
    };
  } finally {
    await database.close();
  }
}
