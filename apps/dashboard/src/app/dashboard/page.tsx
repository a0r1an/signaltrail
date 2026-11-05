import { SignOutButton } from '@clerk/nextjs';
import { notFound, redirect } from 'next/navigation';
import { readOwnerAccess } from '../../features/auth/owner-session';
export const dynamic = 'force-dynamic';
export default async function DashboardPage() {
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
  return (
    <main>
      <h1>SignalTrail</h1>
      <p>Private dashboard access confirmed.</p>
      <p>Analytics connection setup is still pending.</p>
      <SignOutButton redirectUrl="/sign-in">
        <button>Sign out</button>
      </SignOutButton>
    </main>
  );
}
