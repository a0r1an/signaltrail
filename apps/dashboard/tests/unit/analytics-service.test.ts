import { afterEach, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
vi.mock('@signaltrail/analytics', () => ({ createAnalyticsReader: vi.fn() }));
vi.mock('@signaltrail/project-access', () => ({ createPostgresMembershipDatabase: vi.fn() }));
vi.mock('../../src/features/auth/owner-session', () => ({ readOwnerAccess: vi.fn() }));
import { createAnalyticsReader } from '@signaltrail/analytics';
import { createPostgresMembershipDatabase } from '@signaltrail/project-access';
import { handleAnalyticsRequest } from '../../src/features/analytics/service';
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});
it('returns unavailable without constructing service connections when configuration is absent', async () => {
  vi.stubEnv('SIGNALTRAIL_MEMBERSHIP_DATABASE_URL', '');
  const response = await handleAnalyticsRequest(
    new Request('http://localhost/api/analytics/occurred/count'),
  );
  expect(response.status).toBe(503);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toEqual({ error: 'SERVICE_UNAVAILABLE' });
  expect(createAnalyticsReader).not.toHaveBeenCalled();
  expect(createPostgresMembershipDatabase).not.toHaveBeenCalled();
});
