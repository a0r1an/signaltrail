import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readControlPlanePlan } from './control-plane-plan.mjs';

export async function readMetadataStatus(query, expected) {
  const state = JSON.parse(
    await query(`SELECT json_build_object(
    'ledgerPresent', to_regclass('signaltrail_migrations.applied') IS NOT NULL,
    'projectsPresent', to_regclass('signaltrail_control.projects') IS NOT NULL,
    'keysPresent', to_regclass('signaltrail_control.ingestion_keys') IS NOT NULL)`),
  );
  const applied = state.ledgerPresent
    ? JSON.parse(
        await query(
          "SELECT coalesce(json_agg(json_build_object('version',version,'checksum',checksum) ORDER BY version),'[]'::json) FROM signaltrail_migrations.applied",
        ),
      )
    : [];
  const historyMatches = applied.every(
    (row, i) => row.version === i + 1 && row.checksum === expected[i]?.sha256,
  );
  return {
    target: 'local-compose',
    ...state,
    appliedVersions: applied.map((row) => row.version),
    historyMatches,
    ready:
      historyMatches &&
      applied.length === expected.length &&
      state.projectsPresent &&
      state.keysPresent,
  };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 2) throw new Error();
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const { migrations } = await readControlPlanePlan(root);
    const query = async (sql) =>
      execFileSync(
        'docker',
        [
          'compose',
          'exec',
          '-T',
          'postgres',
          'psql',
          '--no-psqlrc',
          '-U',
          'signaltrail',
          '-d',
          'signaltrail',
          '-qAt',
          '-v',
          'ON_ERROR_STOP=1',
          '-c',
          `BEGIN READ ONLY; SET LOCAL statement_timeout='5s'; ${sql}; COMMIT;`,
        ],
        { cwd: root, encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] },
      ).trim();
    console.log(JSON.stringify(await readMetadataStatus(query, migrations), null, 2));
  } catch {
    console.error(
      'Local metadata status unavailable; no changes were made. Check the local Compose PostgreSQL service.',
    );
    process.exitCode = 1;
  }
}
