import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  createInitialProjectStatement,
  createIngestionKey,
  createStoredProjectResolver,
  createProjectListReader,
} from '../../packages/project-access/dist/index.js';
const { Client } = createRequire(
  new URL('../../packages/project-access/package.json', import.meta.url),
)('pg');

export async function exerciseInitialProject(database, sql) {
  const id = (n) => '00000000-0000-0000-0000-' + String(n).padStart(12, '0');
  const input = {
    principalId: id(51),
    issuer: 'https://bootstrap.fixture.invalid',
    subject: 'owner-fixture',
    organizationId: id(52),
    organizationName: "Owner's organization",
    projectId: id(53),
    projectName: 'Initial project',
    keyId: id(54),
    keyName: 'Browser',
    publicKey: createIngestionKey(),
  };
  const client = new Client({
    connectionString: 'postgres://signaltrail:signaltrail_local@127.0.0.1:35433/signaltrail',
    connectionTimeoutMillis: 5000,
    query_timeout: 5000,
    statement_timeout: 4000,
  });
  try {
    await client.connect();
    const query = createInitialProjectStatement(input);
    assert.deepEqual((await client.query(query)).rows, [{ project_id: input.projectId }]);
    assert.equal(
      await createStoredProjectResolver(database.query)(input.publicKey),
      input.projectId,
    );
    const page = await createProjectListReader(database.query)(
      { issuer: input.issuer, subject: input.subject },
      {},
      AbortSignal.timeout(5000),
    );
    assert.deepEqual(page.projects, [{ id: input.projectId, name: input.projectName }]);
    await assert.rejects(client.query(query), (error) => error.code === '23505');
    const conflicting = createInitialProjectStatement({
      ...input,
      principalId: id(61),
      subject: 'rollback-owner',
      organizationId: id(62),
      projectId: id(63),
      keyId: id(64),
    });
    await assert.rejects(client.query(conflicting), (error) => error.code === '23505');
    assert.equal(
      (
        await sql(`SELECT (
      (SELECT count(*) FROM signaltrail_control.principals WHERE id='${id(61)}') +
      (SELECT count(*) FROM signaltrail_control.organizations WHERE id='${id(62)}') +
      (SELECT count(*) FROM signaltrail_control.projects WHERE id='${id(63)}') +
      (SELECT count(*) FROM signaltrail_control.ingestion_keys WHERE id='${id(64)}'))`)
      ).trim(),
      '0',
    );
    return {
      passed: true,
      ownerCanListProject: true,
      storedKeyResolves: true,
      replayRejected: true,
      lateConflictRollsBackAllRows: true,
    };
  } finally {
    await client.end();
  }
}
