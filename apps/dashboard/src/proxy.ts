import { clerkMiddleware } from '@clerk/nextjs/server';
import { NextResponse, type NextFetchEvent, type NextRequest } from 'next/server';
import { getAuthConfig } from './features/auth/config';

export default function proxy(request: NextRequest, event: NextFetchEvent) {
  const config = getAuthConfig(process.env);
  if (!config) {
    if (request.nextUrl.pathname === '/sign-in' || request.nextUrl.pathname.startsWith('/sign-in/'))
      return NextResponse.next();
    return NextResponse.json(
      { error: 'AUTH_UNAVAILABLE' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  // Resource-level guards enforce owner access, not merely middleware presence.
  return clerkMiddleware({ authorizedParties: [config.appOrigin] })(request, event);
}
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
