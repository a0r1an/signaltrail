import { expect, it } from 'vitest';
import { createInitialProjectStatement } from '../../src/bootstrap-project.ts';
import { createIngestionKey, hashIngestionKey } from '../../src/ingestion-keys.ts';
const input = {
  principalId: '00000000-0000-0000-0000-000000000001',
  issuer: 'https://fixture.clerk.accounts.dev',
  subject: 'user_fixture',
  organizationId: '00000000-0000-0000-0000-000000000002',
  organizationName: "Owner's organization",
  projectId: '00000000-0000-0000-0000-000000000003',
  projectName: 'Personal project',
  keyId: '00000000-0000-0000-0000-000000000004',
  keyName: 'Browser',
  publicKey: createIngestionKey(),
};
it('binds an atomic owner/project/key bootstrap without embedding identity or raw keys in SQL', () => {
  const result = createInitialProjectStatement(input);
  expect(result.text).toContain('WITH');
  expect(result.text).toContain("'owner'");
  expect(result.values).toEqual([
    input.principalId,
    input.issuer,
    input.subject,
    input.organizationId,
    input.organizationName,
    input.projectId,
    input.projectName,
    input.keyId,
    input.keyName,
    hashIngestionKey(input.publicKey),
  ]);
  expect(JSON.stringify(result)).not.toContain(input.publicKey);
  expect(result.text).not.toContain(input.organizationName);
});
it.each([
  { subject: '' },
  { subject: 'x\0y' },
  { issuer: '\ud800' },
  { organizationName: 'x'.repeat(201) },
  { projectName: '   ' },
  { principalId: 'not-a-uuid' },
  { publicKey: 'forged-key' },
])('rejects invalid bootstrap input: %s', (change) => {
  expect(() => createInitialProjectStatement({ ...input, ...change })).toThrow();
});
