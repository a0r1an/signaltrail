import { expect, it, vi } from 'vitest';
import { createProjectAccessResolver } from '../../src/index.ts';

const projectId = '01234567-89ab-cdef-0123-456789abcdef';
const request = new Request('https://dashboard.invalid');
const signal = new AbortController().signal;

it('rejects an unauthenticated caller before consulting membership storage', async () => {
  const query = vi.fn(async () => ({ rows: [] }));
  const resolve = createProjectAccessResolver({ resolveIdentity: async () => null, query });
  expect(await resolve(request, projectId, signal)).toEqual({ status: 'unauthenticated' });
  expect(query).not.toHaveBeenCalled();
});

it('authorizes only a database-confirmed project for the verified issuer and subject', async () => {
  const query = vi.fn(async () => ({ rows: [{ project_id: projectId }] }));
  const resolve = createProjectAccessResolver({
    resolveIdentity: async () => ({ issuer: 'issuer-a', subject: "subject' OR 1=1 --" }),
    query,
  });
  expect(await resolve(request, projectId.toUpperCase(), signal)).toEqual({
    status: 'authorized',
    projectId,
  });
  expect(query).toHaveBeenCalledWith({
    text: expect.stringContaining('$1::uuid'),
    values: [projectId, 'issuer-a', "subject' OR 1=1 --"],
    signal,
  });
});

it.each([
  { rows: [{ project_id: 'foreign' }] },
  { rows: [{ project_id: projectId }, { project_id: projectId }] },
  { rows: [{}] },
])('fails closed on an inconsistent membership result', async (result) => {
  const resolve = createProjectAccessResolver({
    resolveIdentity: async () => ({ issuer: 'issuer', subject: 'subject' }),
    query: async () => result,
  });
  await expect(resolve(request, projectId, signal)).rejects.toThrow(
    'Project access was not confirmed',
  );
});

it.each(['before', 'identity', 'database'])(
  'never authorizes cancelled work: %s',
  async (phase) => {
    const controller = new AbortController();
    const identity = vi.fn(async () => {
      if (phase === 'identity') controller.abort();
      return { issuer: 'issuer', subject: 'subject' };
    });
    const query = vi.fn(async () => {
      controller.abort();
      return { rows: [{ project_id: projectId }] };
    });
    const resolve = createProjectAccessResolver({ resolveIdentity: identity, query });
    if (phase === 'before') controller.abort();
    await expect(resolve(request, projectId, controller.signal)).rejects.toThrow(
      'Project access was not confirmed',
    );
    if (phase === 'before') expect(identity).not.toHaveBeenCalled();
    if (phase !== 'database') expect(query).not.toHaveBeenCalled();
  },
);

it.each([
  { issuer: '', subject: 'subject' },
  { issuer: 'issuer', subject: '  ' },
  { issuer: 'issuer', subject: 'x'.repeat(1025) },
  { issuer: 'issuer', subject: '\ud800' },
])('rejects malformed verified-principal fields before querying', async (principal) => {
  const query = vi.fn(async () => ({ rows: [{ project_id: projectId }] }));
  const resolve = createProjectAccessResolver({ resolveIdentity: async () => principal, query });
  await expect(resolve(request, projectId, signal)).rejects.toThrow(
    'Project access was not confirmed',
  );
  expect(query).not.toHaveBeenCalled();
});

it('does not cache membership grants across requests', async () => {
  const query = vi
    .fn()
    .mockResolvedValueOnce({ rows: [{ project_id: projectId }] })
    .mockResolvedValueOnce({ rows: [] });
  const resolve = createProjectAccessResolver({
    resolveIdentity: async () => ({ issuer: 'issuer', subject: 'subject' }),
    query,
  });
  expect(await resolve(request, projectId, signal)).toEqual({ status: 'authorized', projectId });
  expect(await resolve(request, projectId, signal)).toEqual({ status: 'forbidden' });
  expect(query).toHaveBeenCalledTimes(2);
});

it('denies malformed project identifiers without querying', async () => {
  const query = vi.fn(async () => ({ rows: [] }));
  const resolve = createProjectAccessResolver({
    resolveIdentity: async () => ({ issuer: 'issuer', subject: 'subject' }),
    query,
  });
  expect(await resolve(request, 'public-ingestion-key', signal)).toEqual({ status: 'forbidden' });
  expect(query).not.toHaveBeenCalled();
});

it.each(['identity', 'database'])('does not leak private %s errors', async (phase) => {
  const resolve = createProjectAccessResolver({
    resolveIdentity: async () => {
      if (phase === 'identity') throw new Error('private session token');
      return { issuer: 'issuer', subject: 'subject' };
    },
    query: async () => {
      throw new Error('private database credentials');
    },
  });
  await expect(resolve(request, projectId, signal)).rejects.toThrow(
    /^Project access was not confirmed$/,
  );
});
