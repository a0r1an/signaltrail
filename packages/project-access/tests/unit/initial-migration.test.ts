import { expect, it } from 'vitest';
import { createInitialMigrationStatement } from '../../src/index.ts';

it.each([
  '',
  'SELECT 1;',
  'BEGIN; SELECT 1;',
  'BEGIN; COMMIT;',
  'BEGIN; SELECT 1; COMMIT; SELECT 2;',
  'x'.repeat(65537),
])('rejects an incomplete or oversized initial migration', (source) => {
  expect(() => createInitialMigrationStatement(source)).toThrow('Invalid initial migration source');
});
