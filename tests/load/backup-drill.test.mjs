import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RECOVERY_OBJECTIVES, assessBackupDrill } from './backup-drill.mjs';

const state = () => ({
  events: [{ project: 'a', rows: '3', hash: '1' }],
  links: [{ project: 'a', rows: '1', hash: '2' }],
  metadata: { projects: { rows: 1, md5: 'x' } },
});

test('a faithful restore within the RTO with no post-backup writes passes', () => {
  assert.deepEqual(
    assessBackupDrill({
      expected: state(),
      restored: state(),
      afterBackupRestored: 0,
      restoreSeconds: 120,
    }),
    [],
  );
  assert.deepEqual(RECOVERY_OBJECTIVES, { rtoSeconds: 14400, rpoSeconds: 3600 });
});

test('reports differing or missing state, post-backup writes and a slow restore', () => {
  const restored = state();
  restored.events[0].rows = '2';
  delete restored.links;
  restored.extra = [];
  assert.deepEqual(
    assessBackupDrill({
      expected: state(),
      restored,
      afterBackupRestored: 4,
      restoreSeconds: 20000,
    }),
    [
      'Restored events differs from the backed-up state',
      'Restored links differs from the backed-up state',
      'Restored extra has no backed-up counterpart',
      'Writes after the last backup were restored: 4',
      'Restore took 20000 s; objective is 14400 s',
    ],
  );
});
