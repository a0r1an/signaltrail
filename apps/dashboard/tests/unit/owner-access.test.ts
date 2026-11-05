import { expect, it, vi } from 'vitest';
import { createOwnerAccess } from '../../src/features/auth/owner-access';
const ownerUserId = 'user_owner';
const issuer = 'https://owned.clerk.accounts.dev';
const session = { userId: ownerUserId, issuer, sessionId: 'sess_owner' };
it('authorizes only the configured owner from a verified issuer/session', async () => {
  const readSession = vi.fn().mockResolvedValue(session);
  const access = createOwnerAccess({ ownerUserId, issuer, readSession });
  expect(await access()).toEqual({
    status: 'authorized',
    principal: { issuer, subject: ownerUserId },
    sessionId: session.sessionId,
  });
  expect(readSession).toHaveBeenCalledOnce();
});
it.each([
  ['signed out', null, 'unauthenticated'],
  ['another account', { ...session, userId: 'user_other' }, 'forbidden'],
  ['another issuer', { ...session, issuer: 'https://other.clerk.accounts.dev' }, 'forbidden'],
  ['missing session', { ...session, sessionId: '' }, 'forbidden'],
  ['malformed verified result', undefined, 'forbidden'],
] as const)('denies %s', async (_name, value, expected) => {
  const readSession = vi.fn().mockResolvedValue(value);
  expect(await createOwnerAccess({ ownerUserId, issuer, readSession })()).toEqual({
    status: expected,
  });
});
it('does not cache a prior owner session or reveal verifier errors', async () => {
  const readSession = vi
    .fn()
    .mockResolvedValueOnce(session)
    .mockResolvedValueOnce(null)
    .mockRejectedValueOnce(new Error('sensitive verifier detail'));
  const access = createOwnerAccess({ ownerUserId, issuer, readSession });
  expect((await access()).status).toBe('authorized');
  expect(await access()).toEqual({ status: 'unauthenticated' });
  expect(await access()).toEqual({ status: 'unavailable' });
});
it.each(['', 'owner', ' user_owner', 'user_owner\n'])(
  'rejects invalid owner configuration %j',
  (value) => {
    expect(() =>
      createOwnerAccess({ ownerUserId: value, issuer, readSession: async () => null }),
    ).toThrow();
  },
);
it.each([
  'http://example.com',
  'https://example.com/',
  'https://example.com/path',
  'https://name:password@example.com',
  '',
])('rejects invalid issuer configuration %j', (value) => {
  expect(() =>
    createOwnerAccess({ ownerUserId, issuer: value, readSession: async () => null }),
  ).toThrow();
});
