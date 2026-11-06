import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
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
  return {
    passed: true,
    trackedVersionTwoUpgrade: true,
    failedUpgradeRollback: true,
    concurrentReplay: true,
    checksumChangeRejected: true,
    incompleteHistoryRejected: true,
    hashOnlyLookup: true,
    revokedKeyDeniedOnNextLookup: true,
    deletedProjectKeyInvalidated: true,
    limitation:
      'Isolated migration/key-reader proof; ingestion production runtime and operator provisioning remain separate.',
  };
}
