/** Input must come from a server-side session verifier, never request JSON/headers. */
export interface VerifiedSession {
  userId: string;
  sessionId: string;
  issuer: string;
}
export type OwnerAccess =
  | { status: 'authorized'; principal: { issuer: string; subject: string }; sessionId: string }
  | { status: 'unauthenticated' | 'forbidden' | 'unavailable' };
export function createOwnerAccess(options: {
  ownerUserId: string;
  issuer: string;
  readSession(): Promise<VerifiedSession | null>;
  timeoutMs?: number;
}): () => Promise<OwnerAccess> {
  const { ownerUserId, issuer, readSession } = options;
  const timeoutMs = options.timeoutMs ?? 5000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000)
    throw new RangeError('Invalid session verification deadline');
  if (!/^user_[A-Za-z0-9]+$/.test(ownerUserId)) throw new TypeError('Invalid owner configuration');
  const origin = new URL(issuer);
  if (origin.protocol !== 'https:' || origin.origin !== issuer)
    throw new TypeError('Invalid issuer configuration');
  return async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Session verification unavailable')), timeoutMs);
      });
      const session = await Promise.race([readSession(), deadline]);
      if (session === null) return { status: 'unauthenticated' };
      if (
        !session ||
        session.userId !== ownerUserId ||
        session.issuer !== issuer ||
        typeof session.sessionId !== 'string' ||
        !/^sess_[A-Za-z0-9]+$/.test(session.sessionId)
      )
        return { status: 'forbidden' };
      return {
        status: 'authorized',
        principal: { issuer, subject: ownerUserId },
        sessionId: session.sessionId,
      };
    } catch {
      return { status: 'unavailable' };
    } finally {
      clearTimeout(timer);
    }
  };
}
