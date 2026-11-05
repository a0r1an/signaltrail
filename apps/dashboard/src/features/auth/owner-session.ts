import 'server-only';
import { auth } from '@clerk/nextjs/server';
import { getAuthConfig } from './config';
import { createOwnerAccess, type OwnerAccess } from './owner-access';

/** Invoke at every protected resource; never cache sessions across requests. */
export async function readOwnerAccess(): Promise<OwnerAccess> {
  const config = getAuthConfig(process.env);
  if (!config) return { status: 'unavailable' };
  return createOwnerAccess({
    ownerUserId: config.ownerUserId,
    issuer: config.issuer,
    async readSession() {
      const session = await auth({ acceptsToken: 'session_token', treatPendingAsSignedOut: true });
      if (!session.userId || !session.sessionId) return null;
      return {
        userId: session.userId,
        sessionId: session.sessionId,
        issuer: session.sessionClaims?.iss ?? '',
      };
    },
  })();
}
