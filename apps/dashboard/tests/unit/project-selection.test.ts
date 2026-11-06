import { expect, it, vi } from 'vitest';
import {
  createOwnerProjectReader,
  selectedProject,
} from '../../src/features/analytics/project-selection';
const project = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'Personal app' };
it('selects only a project returned by the membership-scoped reader', () => {
  const page = { projects: [project], hasMore: false };
  expect(selectedProject(page, undefined)).toEqual(project);
  expect(selectedProject(page, project.id.toUpperCase())).toEqual(project);
  expect(selectedProject(page, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')).toBeUndefined();
  expect(selectedProject(page, [project.id])).toBeUndefined();
  expect(selectedProject({ projects: [], hasMore: false }, undefined)).toBeUndefined();
});
it.each(['unauthenticated', 'forbidden', 'unavailable'] as const)(
  'denies project discovery without confirmed owner access: %s',
  async (status) => {
    const query = vi.fn(async () => ({ rows: [] }));
    const read = createOwnerProjectReader({ readOwnerAccess: async () => ({ status }), query });
    expect(await read({}, new AbortController().signal)).toEqual({ status });
    expect(query).not.toHaveBeenCalled();
  },
);
it('passes only verified owner identity to the parameterized project query', async () => {
  const query = vi.fn(async () => ({
    rows: [{ project_id: project.id, project_name: project.name }],
  }));
  const read = createOwnerProjectReader({
    readOwnerAccess: async () => ({
      status: 'authorized',
      principal: { issuer: 'https://owned.example', subject: 'user_owner' },
      sessionId: 'sess_owner',
    }),
    query,
  });
  expect(await read({}, new AbortController().signal)).toEqual({
    status: 'available',
    page: { projects: [project], hasMore: false },
  });
  expect(query).toHaveBeenCalledWith(
    expect.objectContaining({ values: ['https://owned.example', 'user_owner', '', '51'] }),
  );
});
it('treats verifier failures as unavailable rather than invalid user input', async () => {
  const query = vi.fn(async () => ({ rows: [] }));
  const read = createOwnerProjectReader({
    readOwnerAccess: async () => {
      throw new TypeError('private verifier detail');
    },
    query,
  });
  expect(await read({}, new AbortController().signal)).toEqual({ status: 'unavailable' });
  expect(query).not.toHaveBeenCalled();
});
