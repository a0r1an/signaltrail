import 'server-only';
import { auth } from '@clerk/nextjs/server';
import { getAuthConfig } from './config';
import { createOwnerAccess, type OwnerAccess } from './owner-access';

// Count real provider work, including calls whose request deadline has elapsed.
const MAX_VERIFICATIONS = 32;
let activeVerifications = 0;
async function readVerifiedSession() {
  if (activeVerifications >= MAX_VERIFICATIONS) throw new Error('Session verification unavailable');
  activeVerifications++;
  try {
    const session = await auth({ acceptsToken: 'session_token', treatPendingAsSignedOut: true });
    if (!session.userId || !session.sessionId) return null;
    return {
      userId: session.userId,
      sessionId: session.sessionId,
      issuer: session.sessionClaims?.iss ?? '',
    };
  } finally {
    activeVerifications--;
  }
}
/** Invoke at every protected resource; never cache sessions across requests. */
export async function readOwnerAccess(): Promise<OwnerAccess> {
  const config = getAuthConfig(process.env);
  if (!config) return { status: 'unavailable' };
  return createOwnerAccess({
    ownerUserId: config.ownerUserId,
    issuer: config.issuer,
    readSession: readVerifiedSession,
  })();
}
