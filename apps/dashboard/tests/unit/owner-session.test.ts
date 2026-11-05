import { afterEach, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
vi.mock('@clerk/nextjs/server', () => ({ auth: vi.fn() }));
import { auth } from '@clerk/nextjs/server';
import { readOwnerAccess } from '../../src/features/auth/owner-session';
const verifiedAuth = vi.mocked(auth);
function configure() {
  for (const [key, value] of Object.entries({
    SIGNALTRAIL_OWNER_CLERK_USER_ID: 'user_owner',
    SIGNALTRAIL_CLERK_ISSUER: 'https://owned.clerk.accounts.dev',
    SIGNALTRAIL_DASHBOARD_ORIGIN: 'http://localhost:3000',
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: 'pk_test_fixture',
    CLERK_SECRET_KEY: 'sk_test_fixture',
  }))
    vi.stubEnv(key, value);
}
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});
it('fails closed before session verification if configuration is missing', async () => {
  vi.stubEnv('SIGNALTRAIL_OWNER_CLERK_USER_ID', '');
  expect(await readOwnerAccess()).toEqual({ status: 'unavailable' });
  expect(verifiedAuth).not.toHaveBeenCalled();
});
it('accepts verified session tokens only and passes the owner principal', async () => {
  configure();
  verifiedAuth.mockResolvedValue({
    userId: 'user_owner',
    sessionId: 'sess_owner',
    sessionClaims: { iss: 'https://owned.clerk.accounts.dev' },
  } as Awaited<ReturnType<typeof auth>>);
  expect(await readOwnerAccess()).toEqual({
    status: 'authorized',
    principal: { issuer: 'https://owned.clerk.accounts.dev', subject: 'user_owner' },
    sessionId: 'sess_owner',
  });
  expect(verifiedAuth).toHaveBeenCalledWith({
    acceptsToken: 'session_token',
    treatPendingAsSignedOut: true,
  });
});
it('rejects other verified users and suppresses verifier failures', async () => {
  configure();
  verifiedAuth
    .mockResolvedValueOnce({
      userId: 'user_other',
      sessionId: 'sess_other',
      sessionClaims: { iss: 'https://owned.clerk.accounts.dev' },
    } as Awaited<ReturnType<typeof auth>>)
    .mockRejectedValueOnce(new Error('private detail'));
  expect(await readOwnerAccess()).toEqual({ status: 'forbidden' });
  expect(await readOwnerAccess()).toEqual({ status: 'unavailable' });
});
