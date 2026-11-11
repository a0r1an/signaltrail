import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { readControlPlanePlan } from '../../scripts/control-plane-plan.mjs';

test('plans the complete repository migration set with exact source checksums', async () => {
  const root = await mkdtemp(join(tmpdir(), 'signaltrail-plan-'));
  try {
    await mkdir(join(root, 'infra/postgres'), { recursive: true });
    const names = [
      '001-project-access.sql',
      '002-ingestion-keys.sql',
      '003-ingestion-key-notifications.sql',
    ];
    const sources = [
      'BEGIN; SELECT 1; COMMIT;\n',
      'BEGIN; SELECT 2; COMMIT;\n',
      'BEGIN; SELECT 3; COMMIT;\n',
    ];
    for (let i = 0; i < names.length; i++)
      await writeFile(join(root, 'infra/postgres', names[i]), sources[i]);
    const plan = await readControlPlanePlan(root);
    assert.match(plan.statement, /pg_advisory_xact_lock/);
    assert.match(plan.statement, /SELECT 1/);
    assert.match(plan.statement, /SELECT 2/);
    assert.deepEqual(
      plan.migrations,
      names.map((file, i) => ({
        version: i + 1,
        file,
        sha256: createHash('sha256').update(sources[i]).digest('hex'),
      })),
    );
    assert.equal(plan.statementSha256, createHash('sha256').update(plan.statement).digest('hex'));
    await writeFile(join(root, 'infra/postgres/004-unregistered.sql'), 'BEGIN; SELECT 4; COMMIT;');
    await assert.rejects(readControlPlanePlan(root), /Unregistered control-plane migration/);
    await rm(join(root, 'infra/postgres/004-unregistered.sql'));
    await writeFile(join(root, 'infra/postgres', names[1]), Buffer.from([0xff]));
    await assert.rejects(readControlPlanePlan(root));
    await rm(join(root, 'infra/postgres', names[1]));
    await assert.rejects(readControlPlanePlan(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
