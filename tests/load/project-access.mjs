import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createProjectAccessResolver } from '../../packages/project-access/dist/index.js';
import {
  createAnalyticsQueryHandler,
  createAnalyticsReader,
} from '../../packages/analytics/dist/index.js';
import { createClickHouseBatchWriter } from '../../workers/event-processor/dist/index.js';

export async function exerciseProjectAccess({ docker, realAnalytics = false }) {
  const sql = (text, signal = AbortSignal.timeout(10000)) =>
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
      true,
      false,
      signal,
    );
  await sql(
    await readFile(new URL('../../infra/postgres/001-project-access.sql', import.meta.url), 'utf8'),
  );
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
  let lookups = 0;
  const resolve = createProjectAccessResolver({
    resolveIdentity: async (request) =>
      identities.get(request.headers.get('Authorization')) ?? null,
    query: async ({ text, values, signal }) => {
      lookups++;
      // Fixture-only psql bridge. Production must use a driver's bound values.
      const quote = (value) => "'" + value.replaceAll("'", "''") + "'";
      const output = await sql(
        `BEGIN; SET LOCAL standard_conforming_strings=on; PREPARE fixture_access(uuid,text,text) AS ${text}; EXECUTE fixture_access(${values.map(quote).join(',')}); ROLLBACK;`,
        signal,
      );
      return {
        rows: output.trim()
          ? output
              .trim()
              .split('\n')
              .map((project_id) => ({ project_id }))
          : [],
      };
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
    reader = createAnalyticsReader(connection);
  }
  const handler = createAnalyticsQueryHandler({
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
  });
  const target = new URL('https://fixture.invalid/v1/analytics/count');
  for (const [key, value] of Object.entries({
    projectId: projectA,
    from: '2026-11-01T00:00:00Z',
    to: '2026-11-02T00:00:00Z',
  }))
    target.searchParams.set(key, value);
  assert.equal(
    (await handler(new Request(target, { headers: { Authorization: 'Bearer fixture-b' } }))).status,
    403,
  );
  assert.equal(reads, 0);
  assert.equal(
    (await handler(new Request(target, { headers: { Authorization: 'Bearer fixture-a' } }))).status,
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
    (await handler(new Request(target, { headers: { Authorization: 'Bearer fixture-a' } }))).status,
    403,
  );
  assert.equal(reads, readsBeforeRevokedRequest);
  await sql(`DO $body$ BEGIN
    BEGIN INSERT INTO signaltrail_control.organization_memberships(organization_id,principal_id,role) VALUES ('${orgA}','${userB}','viewer');
    EXCEPTION WHEN check_violation THEN RETURN; END;
    RAISE EXCEPTION 'Invalid membership role was accepted';
    END $body$;`);
  return {
    passed: true,
    issuerIsolation: true,
    crossOrganizationDenied: true,
    membershipRemovalImmediate: true,
    invalidRoleRejected: true,
    queryBoundaryVerified: true,
    realClickHouseCountsAndPaging: realAnalytics,
    limitations: [
      'Fixture identity resolver and psql bridge only; no production session validation, database adapter, or route deployed.',
    ],
  };
}
