import { expect, it } from 'vitest';
import { createControlPlaneMigrationStatement } from '../../src/tracked-migrations.ts';
it('tracks ordered migrations in one locked transaction without losing prior checksums', () => {
  const sql = createControlPlaneMigrationStatement([
    { version: 1, source: 'BEGIN; CREATE SCHEMA fixture_control; COMMIT;' },
    { version: 2, source: 'BEGIN; CREATE TABLE fixture_control.keys(id integer); COMMIT;' },
  ]);
  expect(sql).toContain('CREATE TABLE fixture_control.keys');
  expect(sql).toContain('version > 2');
  expect(sql).toContain('pg_advisory_xact_lock');
  expect(sql).toContain("VALUES (2, '");
});
it.each(
  [
    [],
    [{ version: 2, source: 'BEGIN; SELECT 1; COMMIT;' }],
    [{ version: 1, source: 'BEGIN; COMMIT;' }],
    [{ version: 1, source: 'SELECT 1;' }],
    [
      { version: 1, source: 'BEGIN; SELECT 1; COMMIT;' },
      { version: 3, source: 'BEGIN; SELECT 1; COMMIT;' },
    ],
  ].map((sources) => ({ sources })),
)('rejects incomplete or unordered migration sources', ({ sources }) => {
  expect(() => createControlPlaneMigrationStatement(sources)).toThrow();
});
