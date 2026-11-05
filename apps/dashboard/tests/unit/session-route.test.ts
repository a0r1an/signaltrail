import { afterEach, expect, it, vi } from 'vitest';
vi.mock('../../src/features/auth/owner-session', () => ({ readOwnerAccess: vi.fn() }));
import { readOwnerAccess } from '../../src/features/auth/owner-session';
import { GET } from '../../src/app/api/session/route';
afterEach(() => vi.resetAllMocks());
it.each([
  ['unauthenticated', 401],
  ['forbidden', 403],
  ['unavailable', 503],
] as const)('denies %s at the API resource with status %s', async (status, code) => {
  vi.mocked(readOwnerAccess).mockResolvedValue({ status });
  const response = await GET();
  expect(response.status).toBe(code);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(await response.json()).toEqual({ status });
});
it('confirms owner access without exposing identity/session details', async () => {
  vi.mocked(readOwnerAccess).mockResolvedValue({
    status: 'authorized',
    principal: { issuer: 'https://owned.example', subject: 'user_owner' },
    sessionId: 'sess_owner',
  });
  const response = await GET();
  expect(response.status).toBe(200);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(await response.json()).toEqual({ status: 'authorized' });
});
