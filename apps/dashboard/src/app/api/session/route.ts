import { readOwnerAccess } from '../../../features/auth/owner-session';
export const dynamic = 'force-dynamic';
export async function GET() {
  const access = await readOwnerAccess();
  const status =
    access.status === 'authorized'
      ? 200
      : access.status === 'unauthenticated'
        ? 401
        : access.status === 'forbidden'
          ? 403
          : 503;
  return Response.json(
    { status: access.status },
    { status, headers: { 'Cache-Control': 'no-store' } },
  );
}
