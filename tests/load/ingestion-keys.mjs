import assert from 'node:assert/strict';
import { exerciseInitialProject } from './bootstrap-project.mjs';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createProjectRuntime, createIngestionHandler } from '../../apps/ingestion/dist/index.js';
import {
  createControlPlaneMigrationStatement,
  createStoredProjectResolver,
  createIngestionKey,
  hashIngestionKey,
} from '../../packages/project-access/dist/index.js';

export async function exerciseIngestionKeys({
  initialSource,
  migrate,
  sql,
  database,
  projectA,
  projectB,
  orgA,
  failsWith,
}) {
  const source = await readFile(
    new URL('../../infra/postgres/002-ingestion-keys.sql', import.meta.url),
    'utf8',
  );
  const sources = [
    { version: 1, source: initialSource },
    { version: 2, source },
  ];
  const statement = createControlPlaneMigrationStatement(sources);
  const broken = createControlPlaneMigrationStatement([
    sources[0],
    { version: 2, source: source.replace('COMMIT;', 'SELECT 1 / 0;\nCOMMIT;') },
  ]);
  await assert.rejects(migrate(broken), failsWith('division by zero'));
  assert.equal(
    (await sql("SELECT to_regclass('signaltrail_control.ingestion_keys') IS NULL")).trim(),
    't',
  );
  assert.equal((await sql('SELECT count(*) FROM signaltrail_migrations.applied')).trim(), '1');
  await Promise.all([migrate(statement), migrate(statement)]);
  await migrate(statement);
  assert.equal((await sql('SELECT count(*) FROM signaltrail_migrations.applied')).trim(), '2');
  await assert.rejects(
    migrate(
      createControlPlaneMigrationStatement([sources[0], { version: 2, source: source + '\n' }]),
    ),
    failsWith('Migration checksum differs'),
  );
  await sql('DELETE FROM signaltrail_migrations.applied WHERE version=1');
  await assert.rejects(migrate(statement), failsWith('Migration history is incomplete'));
  await sql(
    `INSERT INTO signaltrail_migrations.applied(version,checksum) VALUES (1,'${createHash('sha256').update(initialSource).digest('hex')}')`,
  );
  // Version 3: key-change notifications that let ingestion cache lookups safely.
  const notifications = await readFile(
    new URL('../../infra/postgres/003-ingestion-key-notifications.sql', import.meta.url),
    'utf8',
  );
  await migrate(
    createControlPlaneMigrationStatement([...sources, { version: 3, source: notifications }]),
  );
  assert.equal((await sql('SELECT count(*) FROM signaltrail_migrations.applied')).trim(), '3');
  const id = (n) => '00000000-0000-0000-0000-' + String(n).padStart(12, '0');
  const a = createIngestionKey(),
    b = createIngestionKey();
  await sql(
    `INSERT INTO signaltrail_control.ingestion_keys(id,project_id,name,key_hash) VALUES ('${id(31)}','${projectA}','Fixture A',decode('${hashIngestionKey(a)}','hex')),('${id(32)}','${projectB}','Fixture B',decode('${hashIngestionKey(b)}','hex'))`,
  );
  const resolve = createStoredProjectResolver(database.query);
  assert.equal(await resolve(a), projectA);
  assert.equal(await resolve(b), projectB);
  assert.equal(await resolve(createIngestionKey()), undefined);
  await assert.rejects(
    sql(
      `INSERT INTO signaltrail_control.ingestion_keys(id,project_id,name,key_hash) VALUES ('${id(33)}','${projectA}','Duplicate hash',decode('${hashIngestionKey(a)}','hex'))`,
      AbortSignal.timeout(10000),
      'combined',
    ),
    failsWith('duplicate key value'),
  );
  await sql(
    `UPDATE signaltrail_control.ingestion_keys SET revoked_at=CURRENT_TIMESTAMP WHERE id='${id(31)}'`,
  );
  assert.equal(await resolve(a), undefined);
  const c = createIngestionKey();
  await sql(
    `INSERT INTO signaltrail_control.projects(id,organization_id,name) VALUES ('${id(41)}','${orgA}','Cascade fixture'); INSERT INTO signaltrail_control.ingestion_keys(id,project_id,name,key_hash) VALUES ('${id(42)}','${id(41)}','Cascade',decode('${hashIngestionKey(c)}','hex'))`,
  );
  assert.equal(await resolve(c), id(41));
  await sql(`DELETE FROM signaltrail_control.projects WHERE id='${id(41)}'`);
  assert.equal(await resolve(c), undefined);
  // This role belongs only to the disposable fixture database.
  await sql(`CREATE ROLE ingestion_fixture_reader LOGIN PASSWORD 'fixture_reader_only';
    GRANT CONNECT ON DATABASE signaltrail TO ingestion_fixture_reader;
    GRANT USAGE ON SCHEMA signaltrail_control TO ingestion_fixture_reader;
    GRANT SELECT(project_id,key_hash,revoked_at) ON signaltrail_control.ingestion_keys TO ingestion_fixture_reader;`);
  for (const forbidden of [
    'SELECT * FROM signaltrail_control.organization_memberships',
    'UPDATE signaltrail_control.ingestion_keys SET revoked_at=CURRENT_TIMESTAMP',
    'CREATE TABLE signaltrail_control.forbidden_fixture(id integer)',
  ]) {
    await assert.rejects(
      sql(
        `SET ROLE ingestion_fixture_reader; ${forbidden}`,
        AbortSignal.timeout(10000),
        'combined',
      ),
      failsWith('permission denied'),
    );
  }
  const runtime = createProjectRuntime({
    NODE_ENV: 'production',
    SIGNALTRAIL_INGESTION_DATABASE_URL:
      'postgres://ingestion_fixture_reader:fixture_reader_only@127.0.0.1:35433/signaltrail',
    SIGNALTRAIL_INGESTION_DATABASE_TLS: 'false',
  });
  const published = [];
  let revocationMs;
  try {
    await runtime.verify();
    const handle = createIngestionHandler({
      resolveProjectKey: runtime.resolveProjectKey,
      publish: async (record) => {
        published.push(record);
      },
    });
    const request = (key) =>
      new Request('http://localhost/v1/events', {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          events: [
            {
              schemaVersion: 1,
              eventId: 'stored-key-runtime',
              eventName: 'view',
              distinctId: 'visitor',
              sessionId: 'session',
              sequence: 0,
              clientTimestamp: '2026-11-05T00:00:00.000Z',
              url: 'https://example.com',
              context: { sdkVersion: '0.1.0' },
              properties: {},
              projectId: projectA,
            },
          ],
        }),
      });
    assert.equal((await handle(request(b))).status, 200);
    assert.equal(published.length, 1);
    assert.equal(published[0].projectId, projectB);
    for (const denied of [a, createIngestionKey(), 'malformed']) {
      assert.equal((await handle(request(denied))).status, 401);
    }
    assert.equal(published.length, 1);
    // Cached key: revocation reaches the cache by NOTIFY, not by waiting for the TTL.
    const cachedKey = createIngestionKey();
    await sql(
      `INSERT INTO signaltrail_control.ingestion_keys(id,project_id,name,key_hash) VALUES ('${id(35)}','${projectB}','Cached',decode('${hashIngestionKey(cachedKey)}','hex'))`,
    );
    const listening = Date.now() + 10000;
    while ((await handle(request(cachedKey))).status !== 200) {
      assert.ok(Date.now() < listening, 'New key was not accepted');
      await delay(100);
    }
    const published0 = published.length;
    assert.equal((await handle(request(cachedKey))).status, 200);
    // Without a notification the cached result stands, proving lookups are served from memory.
    await sql(
      `ALTER TABLE signaltrail_control.ingestion_keys DISABLE TRIGGER ingestion_keys_notify; UPDATE signaltrail_control.ingestion_keys SET revoked_at=CURRENT_TIMESTAMP WHERE id='${id(35)}'; ALTER TABLE signaltrail_control.ingestion_keys ENABLE TRIGGER ingestion_keys_notify`,
    );
    assert.equal((await handle(request(cachedKey))).status, 200);
    // Any change to the key row notifies; the revoked key is then refused.
    await sql(`UPDATE signaltrail_control.ingestion_keys SET name='Revoked' WHERE id='${id(35)}'`);
    const revokedAt = performance.now();
    while (revocationMs === undefined) {
      if ((await handle(request(cachedKey))).status === 401)
        revocationMs = performance.now() - revokedAt;
      else {
        assert.ok(performance.now() - revokedAt < 5000, 'Cached key revocation was not applied');
        await delay(20);
      }
    }
    assert.equal(published.length, published0 + 2);
    await sql(
      'REVOKE SELECT(project_id,key_hash,revoked_at) ON signaltrail_control.ingestion_keys FROM ingestion_fixture_reader',
    );
    await assert.rejects(
      runtime.verify(),
      /^Error: Ingestion project database readiness was not confirmed$/,
    );
    // Lost privileges are not key changes: keys never cached fail closed; cached results
    // remain until notification or the TTL backstop, and readiness already reports failure.
    const published1 = published.length;
    assert.equal((await handle(request(createIngestionKey()))).status, 503);
    assert.equal(published.length, published1);
  } finally {
    await runtime.close();
  }
  return {
    passed: true,
    initialProject: await exerciseInitialProject(database, sql),
    trackedVersionTwoUpgrade: true,
    failedUpgradeRollback: true,
    concurrentReplay: true,
    checksumChangeRejected: true,
    incompleteHistoryRejected: true,
    hashOnlyLookup: true,
    revokedKeyDeniedOnNextLookup: true,
    cachedLookupServedWithoutNotification: true,
    cachedKeyRevocationMsAfterCommit: revocationMs,
    deletedProjectKeyInvalidated: true,
    productionRuntimeReadiness: true,
    storedKeyHandlerProjectIsolation: true,
    revokedAndUnknownKeysDeniedBeforePublication: true,
    restrictedReaderPrivileges: true,
    lostReadPermissionFailsClosed: true,
    limitation:
      'Isolated production resolver/handler with simulated publication; operator provisioning, live broker startup and production database roles remain separate.',
  };
}
