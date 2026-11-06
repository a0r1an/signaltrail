import { expect, it, vi } from 'vitest';
import { createProjectRuntime } from '../../src/project-runtime.ts';
const env = {
  NODE_ENV: 'production',
  SIGNALTRAIL_INGESTION_DATABASE_URL: 'postgres://reader:fixture@localhost:5433/signaltrail',
  SIGNALTRAIL_INGESTION_DATABASE_TLS: 'false',
};
it('uses only the configured stored resolver in production and verifies schema access before readiness', async () => {
  const project = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const database = {
    query: vi.fn(async ({ text }: { text: string }) => ({
      rows: text.includes('LIMIT 0') ? [] : [{ project_id: project }],
    })),
    close: vi.fn(async () => {}),
  };
  const createDatabase = vi.fn(() => database);
  const runtime = createProjectRuntime(env, { createDatabase });
  expect(runtime.mode).toBe('stored');
  await runtime.verify();
  expect(
    await runtime.resolveProjectKey('st_pub_' + Buffer.alloc(32, 1).toString('base64url')),
  ).toBe(project);
  expect(createDatabase).toHaveBeenCalledWith(
    expect.objectContaining({
      connectionString: env.SIGNALTRAIL_INGESTION_DATABASE_URL,
      tls: false,
    }),
  );
  await runtime.close();
  expect(database.close).toHaveBeenCalledOnce();
});
it.each([
  { NODE_ENV: 'production' },
  { ...env, SIGNALTRAIL_DEV_PROJECTS: '[]' },
  {
    ...env,
    SIGNALTRAIL_INGESTION_DATABASE_URL: 'postgres://reader:fixture@remote.invalid/signaltrail',
  },
  {
    ...env,
    SIGNALTRAIL_INGESTION_DATABASE_URL: 'postgres://reader:fixture@localhost:0/signaltrail',
  },
  { ...env, SIGNALTRAIL_INGESTION_DATABASE_TLS: 'no' },
  { ...env, SIGNALTRAIL_INGESTION_DATABASE_CA: 'certificate' },
  { ...env, SIGNALTRAIL_INGESTION_DATABASE_URL: 'https://metadata.invalid' },
  {
    ...env,
    SIGNALTRAIL_INGESTION_DATABASE_URL:
      'postgres://reader:fixture@localhost/signaltrail?sslmode=disable',
  },
  { NODE_ENV: 'Production' },
])(
  'rejects unsafe production/mode configuration before constructing a database',
  (configuration) => {
    const createDatabase = vi.fn();
    expect(() => createProjectRuntime(configuration, { createDatabase })).toThrow();
    expect(createDatabase).not.toHaveBeenCalled();
  },
);
it('retains explicit development mapping without opening a database', async () => {
  const createDatabase = vi.fn();
  const runtime = createProjectRuntime(
    {
      NODE_ENV: 'development',
      SIGNALTRAIL_DEV_PROJECTS: JSON.stringify([
        { key: 'fixture-key', projectId: 'fixture-project' },
      ]),
    },
    { createDatabase },
  );
  expect(runtime.mode).toBe('development');
  expect(await runtime.resolveProjectKey('fixture-key')).toBe('fixture-project');
  await runtime.verify();
  await runtime.close();
  expect(createDatabase).not.toHaveBeenCalled();
});
it('fails readiness without exposing database diagnostics', async () => {
  const database = {
    query: vi.fn(async () => {
      throw new Error('postgres://private');
    }),
    close: vi.fn(async () => {}),
  };
  const runtime = createProjectRuntime(env, { createDatabase: () => database });
  await expect(runtime.verify()).rejects.toThrow(
    /^Ingestion project database readiness was not confirmed$/,
  );
  await runtime.close();
  expect(database.close).toHaveBeenCalledOnce();
});
