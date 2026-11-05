import { expect, it } from 'vitest';
import { getAuthConfig } from '../../src/features/auth/config';
const env = {
  SIGNALTRAIL_OWNER_CLERK_USER_ID: 'user_owner',
  SIGNALTRAIL_CLERK_ISSUER: 'https://owned.clerk.accounts.dev',
  SIGNALTRAIL_DASHBOARD_ORIGIN: 'https://signaltrail.example',
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: 'pk_test_fixture',
  CLERK_SECRET_KEY: 'sk_test_fixture',
};
it('returns only public scope configuration, never keys', () => {
  expect(getAuthConfig(env)).toEqual({
    ownerUserId: 'user_owner',
    issuer: env.SIGNALTRAIL_CLERK_ISSUER,
    appOrigin: env.SIGNALTRAIL_DASHBOARD_ORIGIN,
  });
});
it.each(Object.keys(env))('fails closed without %s', (name) => {
  expect(getAuthConfig({ ...env, [name]: undefined })).toBeNull();
});
it.each([
  'http://external.example',
  'https://example.com/path',
  'https://name:secret@example.com',
  'https://example.com?x=1',
  'https://example.com#fragment',
  'invalid',
])('rejects unsafe app origin %s', (value) => {
  expect(getAuthConfig({ ...env, SIGNALTRAIL_DASHBOARD_ORIGIN: value })).toBeNull();
});
it('allows explicit loopback development origins', () => {
  expect(
    getAuthConfig({ ...env, SIGNALTRAIL_DASHBOARD_ORIGIN: 'http://localhost:3000' }),
  ).not.toBeNull();
});
