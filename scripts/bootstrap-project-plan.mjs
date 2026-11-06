import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createIngestionKey,
  createInitialProjectStatement,
} from '../packages/project-access/dist/index.js';
const fields = [
  'principalId',
  'issuer',
  'subject',
  'organizationId',
  'organizationName',
  'projectId',
  'projectName',
  'keyId',
  'keyName',
];
export async function writeInitialProjectPlan(root, input) {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).length !== fields.length ||
    fields.some((field) => !Object.hasOwn(input, field))
  )
    throw new TypeError('Invalid bootstrap plan input fields');
  const publicKey = createIngestionKey();
  const statement = createInitialProjectStatement({ ...input, publicKey });
  const bytes = JSON.stringify(statement, null, 2) + '\n';
  const manifest = {
    formatVersion: 1,
    applied: false,
    generatedAt: new Date().toISOString(),
    statementSha256: createHash('sha256').update(bytes).digest('hex'),
  };
  const parent = join(root, 'test-results/bootstrap');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, 'plan-'));
  const options = { flag: 'wx', mode: 0o600 };
  // Write the completion manifest last. A failed write never reports a complete plan.
  await writeFile(join(directory, 'statement.json'), bytes, options);
  await writeFile(join(directory, 'sdk-key.txt'), publicKey + '\n', options);
  await writeFile(
    join(directory, 'manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n',
    options,
  );
  return { directory, ...manifest };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 2) throw new Error();
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const bytes = await readFile(join(root, '.local-data/bootstrap-input.json'));
    if (bytes.length > 16384) throw new Error();
    const input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    console.log(JSON.stringify(await writeInitialProjectPlan(root, input), null, 2));
  } catch {
    console.error(
      'Initial project planning failed; check .local-data/bootstrap-input.json. No database was contacted.',
    );
    process.exitCode = 1;
  }
}
