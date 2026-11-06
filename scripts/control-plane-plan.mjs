import { readFile, readdir, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createControlPlaneMigrationStatement } from '../packages/project-access/dist/index.js';

const files = ['001-project-access.sql', '002-ingestion-keys.sql'];
const hash = (value) => createHash('sha256').update(value).digest('hex');
export async function readControlPlanePlan(root) {
  const directory = join(root, 'infra/postgres');
  const found = await readdir(directory);
  if (found.some((file) => file.endsWith('.sql') && !files.includes(file)))
    throw new Error('Unregistered control-plane migration');
  const sources = [];
  const migrations = [];
  for (const [index, file] of files.entries()) {
    const bytes = await readFile(join(directory, file));
    if (bytes.length > 65536) throw new Error('Control-plane migration exceeds byte limit');
    const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    // Reject BOM stripping and any other decoding normalization before hashing.
    if (!Buffer.from(source).equals(bytes)) throw new Error('Invalid migration encoding');
    sources.push({ version: index + 1, source });
    migrations.push({ version: index + 1, file, sha256: hash(bytes) });
  }
  const statement = createControlPlaneMigrationStatement(sources);
  return { statement, migrations, statementSha256: hash(statement) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 2) throw new Error('Migration planning accepts no arguments');
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const { statement, ...manifest } = await readControlPlanePlan(root);
    const parent = join(root, 'test-results/migrations');
    await mkdir(parent, { recursive: true });
    const directory = await mkdtemp(join(parent, 'plan-'));
    await writeFile(join(directory, 'plan.sql'), statement, { flag: 'wx', mode: 0o600 });
    await writeFile(
      join(directory, 'manifest.json'),
      JSON.stringify(
        {
          ...manifest,
          applied: false,
          generatedAt: new Date().toISOString(),
        },
        null,
        2,
      ) + '\n',
      { flag: 'wx', mode: 0o600 },
    );
    console.log(JSON.stringify({ directory, ...manifest, applied: false }, null, 2));
  } catch {
    console.error('Control-plane migration planning failed; no database was contacted');
    process.exitCode = 1;
  }
}
