export interface AuthConfig {
  ownerUserId: string;
  issuer: string;
  appOrigin: string;
}
type Environment = Record<string, string | undefined>;
/** Never returns keys or supplies a development authentication bypass. */
export function getAuthConfig(env: Environment): AuthConfig | null {
  const ownerUserId = env.SIGNALTRAIL_OWNER_CLERK_USER_ID;
  const issuer = env.SIGNALTRAIL_CLERK_ISSUER;
  const appOrigin = env.SIGNALTRAIL_DASHBOARD_ORIGIN;
  if (
    !ownerUserId ||
    !issuer ||
    !appOrigin ||
    !/^user_[A-Za-z0-9]+$/.test(ownerUserId) ||
    !env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY?.startsWith('pk_') ||
    !env.CLERK_SECRET_KEY?.startsWith('sk_')
  )
    return null;
  try {
    const identity = new URL(issuer),
      app = new URL(appOrigin);
    if (
      identity.protocol !== 'https:' ||
      identity.origin !== issuer ||
      app.origin !== appOrigin ||
      (app.protocol !== 'https:' &&
        !(app.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(app.hostname)))
    )
      return null;
    return { ownerUserId, issuer, appOrigin };
  } catch {
    return null;
  }
}
