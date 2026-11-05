import { createHash } from 'node:crypto';
import { ConnectedExplorer } from '../../features/event-explorer/connected-explorer';
import { SignOutButton } from '@clerk/nextjs';
import { notFound, redirect } from 'next/navigation';
import { readOwnerAccess } from '../../features/auth/owner-session';
export const dynamic = 'force-dynamic';
export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ projectId?: string | string[] }>;
}) {
  const access = await readOwnerAccess();
  if (access.status === 'unauthenticated') redirect('/sign-in');
  if (access.status === 'forbidden') notFound();
  if (access.status !== 'authorized')
    return (
      <main>
        <h1>Dashboard unavailable</h1>
        <p>Authentication could not be confirmed. Try again later.</p>
      </main>
    );
  const requested = (await searchParams).projectId;
  const projectId =
    typeof requested === 'string' &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(requested)
      ? requested.toLowerCase()
      : undefined;
  const scopeKey = createHash('sha256')
    .update(JSON.stringify([access.principal, access.sessionId]))
    .digest('hex');
  // eslint-disable-next-line react-hooks/purity -- Dynamic server route snapshots request time for the initial UTC window.
  const now = Date.now();
  return (
    <main>
      <h1>SignalTrail</h1>
      <form action="/dashboard" method="get">
        <label>
          Project ID{' '}
          <input
            name="projectId"
            required
            defaultValue={projectId ?? ''}
            maxLength={36}
            placeholder="Project UUID"
          />
        </label>
        <button type="submit">Open project</button>
      </form>
      {projectId ? (
        <ConnectedExplorer
          project={{ id: projectId, name: 'Selected project' }}
          scopeKey={scopeKey}
          initialQuery={{
            from: new Date(now - 86400000).toISOString(),
            to: new Date(now).toISOString(),
          }}
        />
      ) : (
        <p>Choose a project you belong to. Project access is checked before analytics reads.</p>
      )}
      <SignOutButton redirectUrl="/sign-in">
        <button>Sign out</button>
      </SignOutButton>
    </main>
  );
}
