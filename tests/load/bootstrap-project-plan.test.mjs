import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { writeInitialProjectPlan } from '../../scripts/bootstrap-project-plan.mjs';
import { hashIngestionKey } from '../../packages/project-access/dist/index.js';
const input = {
  principalId: '00000000-0000-0000-0000-000000000001',
  issuer: 'https://bootstrap.fixture.invalid',
  subject: 'owner-fixture',
  organizationId: '00000000-0000-0000-0000-000000000002',
  organizationName: 'Personal',
  projectId: '00000000-0000-0000-0000-000000000003',
  projectName: 'Personal',
  keyId: '00000000-0000-0000-0000-000000000004',
  keyName: 'Browser',
};
test('writes a unique unapplied operator plan and separate SDK key with private file permissions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'signaltrail-bootstrap-'));
  try {
    const result = await writeInitialProjectPlan(root, input);
    const queryBytes = await readFile(join(result.directory, 'statement.json'));
    const query = JSON.parse(queryBytes);
    const key = (await readFile(join(result.directory, 'sdk-key.txt'), 'utf8')).trim();
    const manifest = JSON.parse(await readFile(join(result.directory, 'manifest.json')));
    assert.equal(query.values.at(-1), hashIngestionKey(key));
    assert.equal(manifest.statementSha256, createHash('sha256').update(queryBytes).digest('hex'));
    assert.equal(manifest.applied, false);
    assert.equal(JSON.stringify(result).includes(key), false);
    assert.equal(JSON.stringify(manifest).includes(input.subject), false);
    assert.equal((await stat(join(result.directory, 'sdk-key.txt'))).mode & 0o777, 0o600);
    assert.equal((await stat(result.directory)).mode & 0o777, 0o700);
    const second = await writeInitialProjectPlan(root, input);
    assert.notEqual(second.directory, result.directory);
    assert.notEqual(await readFile(join(second.directory, 'sdk-key.txt'), 'utf8'), key + '\n');
    await assert.rejects(writeInitialProjectPlan(root, { ...input, subject: '' }));
    await assert.rejects(writeInitialProjectPlan(root, { ...input, unexpected: 'value' }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
