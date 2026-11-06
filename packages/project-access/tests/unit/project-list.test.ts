import { expect, it, vi } from 'vitest';
import { createProjectListReader } from '../../src/project-list.ts';
const principal = { issuer: 'https://owner.example', subject: 'user_owner' };
const id = (value: number) => `00000000-0000-0000-0000-${String(value).padStart(12, '0')}`;
it('lists only membership-scoped projects with bounded continuation', async () => {
  const query = vi.fn<Parameters<typeof createProjectListReader>[0]>(async () => ({
    rows: [
      { project_id: id(1), project_name: 'A' },
      { project_id: id(2), project_name: 'B' },
    ],
  }));
  const read = createProjectListReader(query);
  const first = await read(principal, { limit: 1 }, new AbortController().signal);
  expect(first.projects).toEqual([{ id: id(1), name: 'A' }]);
  expect(first.hasMore).toBe(true);
  expect(first.nextCursor).toBeTruthy();
  expect(query).toHaveBeenCalledWith(
    expect.objectContaining({ values: [principal.issuer, principal.subject, '', '2'] }),
  );
});
it('binds continuation to the verified principal and never interpolates identity values', async () => {
  const query = vi.fn<Parameters<typeof createProjectListReader>[0]>(async () => ({
    rows: [
      { project_id: id(1), project_name: 'A' },
      { project_id: id(2), project_name: 'B' },
    ],
  }));
  const read = createProjectListReader(query);
  const first = await read(principal, { limit: 1 }, new AbortController().signal);
  if (!first.nextCursor) throw new Error('Missing fixture cursor');
  await expect(
    read(
      { ...principal, subject: 'different' },
      { cursor: first.nextCursor },
      new AbortController().signal,
    ),
  ).rejects.toThrow('Invalid project cursor');
  expect(query).toHaveBeenCalledTimes(1);
  query.mockResolvedValueOnce({ rows: [{ project_id: id(2), project_name: 'B' }] });
  expect(
    await read(principal, { limit: 1, cursor: first.nextCursor }, new AbortController().signal),
  ).toEqual({ projects: [{ id: id(2), name: 'B' }], hasMore: false });
  expect(query.mock.calls[1]![0].values).toEqual([principal.issuer, principal.subject, id(1), '2']);
  expect(query.mock.calls[0]![0].text).not.toContain(principal.subject);
});
it.each([0, 101, 1.5, NaN])('rejects invalid limits before storage: %s', async (limit) => {
  const query = vi.fn<Parameters<typeof createProjectListReader>[0]>(async () => ({ rows: [] }));
  await expect(
    createProjectListReader(query)(principal, { limit }, new AbortController().signal),
  ).rejects.toThrow('Invalid project limit');
  expect(query).not.toHaveBeenCalled();
});
it.each(
  [
    [
      { project_id: id(1), project_name: 'A' },
      { project_id: id(1), project_name: 'duplicate' },
    ],
    [
      { project_id: id(2), project_name: 'B' },
      { project_id: id(1), project_name: 'A' },
    ],
    [{ project_id: 'bad', project_name: 'A' }],
    [{ project_id: id(1), project_name: 'A', private: 'unexpected' }],
  ].map((rows) => ({ rows })),
)('rejects inconsistent storage rows without returning a partial page', async ({ rows }) => {
  const query = vi.fn<Parameters<typeof createProjectListReader>[0]>(async () => ({ rows }));
  await expect(
    createProjectListReader(query)(principal, {}, new AbortController().signal),
  ).rejects.toThrow('Projects were not confirmed');
});
it('does not query after cancellation or expose raw database errors', async () => {
  const query = vi.fn<Parameters<typeof createProjectListReader>[0]>(async () => {
    throw new Error('private postgres://credentials');
  });
  const read = createProjectListReader(query),
    controller = new AbortController();
  controller.abort();
  await expect(read(principal, {}, controller.signal)).rejects.toThrow(
    'Projects were not confirmed',
  );
  expect(query).not.toHaveBeenCalled();
  await expect(read(principal, {}, new AbortController().signal)).rejects.toThrow(
    /^Projects were not confirmed$/,
  );
});
it('preserves full-length Unicode project names', async () => {
  const name = '😀'.repeat(200);
  const query = vi.fn<Parameters<typeof createProjectListReader>[0]>(async () => ({
    rows: [{ project_id: id(1), project_name: name }],
  }));
  expect(
    (await createProjectListReader(query)(principal, {}, new AbortController().signal)).projects[0]!
      .name,
  ).toBe(name);
});
