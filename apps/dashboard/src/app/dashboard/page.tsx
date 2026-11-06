import Link from 'next/link';
import { ProjectPicker } from '../../features/event-explorer/project-picker';
import { readDashboardProjects } from '../../features/analytics/service';
import { selectedProject } from '../../features/analytics/project-selection';
import { createHash } from 'node:crypto';
import { ConnectedExplorer } from '../../features/event-explorer/connected-explorer';
import { SignOutButton } from '@clerk/nextjs';
import { notFound, redirect } from 'next/navigation';
import { readOwnerAccess } from '../../features/auth/owner-session';
export const dynamic = 'force-dynamic';
export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ projectId?: string | string[]; projectCursor?: string | string[] }>;
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
  const parameters = await searchParams;
  const cursor = parameters.projectCursor;
  const selection = Array.isArray(cursor)
    ? { status: 'invalid_query' as const }
    : await readDashboardProjects(cursor === undefined ? {} : { cursor });
  if (selection.status === 'unauthenticated') redirect('/sign-in');
  if (selection.status === 'forbidden') notFound();
  const project =
    selection.status === 'available'
      ? selectedProject(selection.page, parameters.projectId)
      : undefined;
  const scopeKey = createHash('sha256')
    .update(JSON.stringify([access.principal, access.sessionId]))
    .digest('hex');
  // eslint-disable-next-line react-hooks/purity -- Dynamic server route snapshots request time for the initial UTC window.
  const now = Date.now();
  return (
    <main>
      <h1>SignalTrail</h1>
      {selection.status === 'available' ? (
        <ProjectPicker
          page={selection.page}
          {...(project ? { selectedId: project.id } : {})}
          {...(typeof cursor === 'string' ? { cursor } : {})}
        />
      ) : (
        <p role="alert">
          {selection.status === 'invalid_query' ? (
            <>
              This project page is invalid. <Link href="/dashboard">Start again</Link>.
            </>
          ) : (
            'Projects are temporarily unavailable. Try again later.'
          )}
        </p>
      )}
      {project ? (
        <ConnectedExplorer
          project={project}
          scopeKey={scopeKey}
          initialQuery={{
            from: new Date(now - 86400000).toISOString(),
            to: new Date(now).toISOString(),
          }}
        />
      ) : (
        <p>Choose an available project to explore its activity.</p>
      )}
      <SignOutButton redirectUrl="/sign-in">
        <button>Sign out</button>
      </SignOutButton>
    </main>
  );
}
