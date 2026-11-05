import { SignIn } from '@clerk/nextjs';
import { getAuthConfig } from '../../../features/auth/config';
export const dynamic = 'force-dynamic';
export default function SignInPage() {
  if (!getAuthConfig(process.env))
    return (
      <main>
        <h1>Sign-in unavailable</h1>
        <p>Authentication has not been configured.</p>
      </main>
    );
  return (
    <main>
      <SignIn routing="path" path="/sign-in" forceRedirectUrl="/dashboard" />
    </main>
  );
}
