'use client';
import { useEffect, useState } from 'react';
import { createQueryClient } from '@signaltrail/analytics/client';
import { EventExplorer } from './event-explorer';
import type { ExplorerClient, ExplorerQuery } from './model';

export interface ConnectedExplorerProps {
  project: { id: string; name: string };
  scopeKey: string;
  initialQuery: ExplorerQuery;
}
export function ConnectedExplorer(props: ConnectedExplorerProps) {
  return <ScopedConnected key={JSON.stringify([props.scopeKey, props.project.id])} {...props} />;
}
function ScopedConnected(props: ConnectedExplorerProps) {
  const [client, setClient] = useState<ExplorerClient | null>(null);
  useEffect(() => {
    let active = true;
    const query = createQueryClient({
      endpoint: location.origin,
      pathPrefix: 'api/analytics/',
      fetch: (input, options) => fetch(input, { ...options, credentials: 'same-origin' }),
    });
    queueMicrotask(() => {
      if (active)
        setClient({ countEvents: query.countOccurredEvents, listEvents: query.listOccurredEvents });
    });
    return () => {
      active = false;
      query.close();
    };
  }, []);
  if (!client) return <p role="status">Loading analytics…</p>;
  return (
    <EventExplorer
      {...props}
      timeBasis="occurred"
      client={client}
      onSignIn={() => location.assign(new URL('/sign-in', location.origin).href)}
    />
  );
}
