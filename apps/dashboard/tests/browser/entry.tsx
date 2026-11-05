import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createQueryClient } from '@signaltrail/analytics/client';
import { EventExplorer } from '../../src/features/event-explorer/event-explorer';

const client = createQueryClient({
  endpoint: location.origin,
  fetch: (input, options) => fetch(input, { ...options, credentials: 'same-origin' }),
});
function Fixture() {
  const [project, setProject] = useState({ id: 'project-a', name: 'Demo store' });
  const [scope, setScope] = useState('fixture-session-a');
  const [message, setMessage] = useState('');
  return (
    <>
      <aside aria-label="Fixture controls">
        <button onClick={() => setProject({ id: 'project-b', name: 'Second project' })}>
          Switch project
        </button>
        <button onClick={() => setScope('fixture-session-b')}>Replace session</button>
      </aside>
      <EventExplorer
        project={project}
        scopeKey={scope}
        initialQuery={{ from: '2026-11-01T00:00:00Z', to: '2026-11-02T00:00:00Z' }}
        client={client}
        onSignIn={() => setMessage('Sign-in requested')}
      />
      {message && <p role="status">{message}</p>}
    </>
  );
}
document.body.style.margin = '0';
document.body.style.background = '#f7f8fa';
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Fixture />
  </StrictMode>,
);
