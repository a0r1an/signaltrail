import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { createStoredProjectResolver } from '../../src/ingestion-keys.ts';
const key = 'st_pub_' + Buffer.alloc(32, 1).toString('base64url');
const project = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
it('resolves a public ingestion key through its hash without sending raw key bytes to storage', async () => {
  const query = vi.fn<Parameters<typeof createStoredProjectResolver>[0]>(async () => ({
    rows: [{ project_id: project }],
  }));
  expect(await createStoredProjectResolver(query)(key)).toBe(project);
  expect(query.mock.calls[0]![0].values).toEqual([createHash('sha256').update(key).digest('hex')]);
  expect(query.mock.calls[0]![0].text).toContain('revoked_at IS NULL');
  expect(JSON.stringify(query.mock.calls)).not.toContain(key);
});
it.each(['', 'fixture-key', 'st_pub_' + 'A'.repeat(42), 'st_pub_' + 'z'.repeat(43)])(
  'rejects malformed or noncanonical keys before querying: %s',
  async (value) => {
    const query = vi.fn<Parameters<typeof createStoredProjectResolver>[0]>(async () => ({
      rows: [],
    }));
    expect(await createStoredProjectResolver(query)(value)).toBeUndefined();
    expect(query).not.toHaveBeenCalled();
  },
);
it('does not fabricate an authorization for an unknown or revoked key', async () => {
  const query = vi.fn<Parameters<typeof createStoredProjectResolver>[0]>(async () => ({
    rows: [],
  }));
  expect(await createStoredProjectResolver(query)(key)).toBeUndefined();
});
it.each(
  [
    [{ project_id: project }, { project_id: project }],
    [{ project_id: 'not-a-project' }],
    [{ project_id: project, private: 'extra' }],
  ].map((rows) => ({ rows })),
)('fails closed on inconsistent storage results', async ({ rows }) => {
  const query = vi.fn<Parameters<typeof createStoredProjectResolver>[0]>(async () => ({ rows }));
  await expect(createStoredProjectResolver(query)(key)).rejects.toThrow(
    'Ingestion project was not confirmed',
  );
});
it('honors cancellation before querying and redacts storage failures', async () => {
  const query = vi.fn<Parameters<typeof createStoredProjectResolver>[0]>(async () => {
    throw new Error('postgres://private');
  });
  const read = createStoredProjectResolver(query),
    controller = new AbortController();
  controller.abort();
  await expect(read(key, controller.signal)).rejects.toThrow('Ingestion project was not confirmed');
  expect(query).not.toHaveBeenCalled();
  await expect(read(key)).rejects.toThrow(/^Ingestion project was not confirmed$/);
});
