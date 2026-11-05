import type { Metadata } from 'next';
import { ClerkProvider } from '@clerk/nextjs';
import { getAuthConfig } from '../features/auth/config';
import './globals.css';

export const metadata: Metadata = {
  title: 'SignalTrail',
  description: 'Private product analytics and session replay',
};

export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en">
      <body>
        {getAuthConfig(process.env) ? (
          <ClerkProvider signInUrl="/sign-in">{children}</ClerkProvider>
        ) : (
          children
        )}
      </body>
    </html>
  );
}
