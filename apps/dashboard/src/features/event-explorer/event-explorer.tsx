'use client';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { createEventExplorerModel, type ExplorerClient, type ExplorerQuery } from './model';
import styles from './event-explorer.module.css';

export interface EventExplorerProps {
  project: { id: string; name: string };
  timeBasis?: 'received' | 'occurred';
  /** Rotate when the verified principal or query-client lifetime changes. */
  scopeKey: string;
  initialQuery: ExplorerQuery;
  client: ExplorerClient;
  onSignIn(): void;
}
export function EventExplorer(props: EventExplorerProps) {
  return (
    <ScopedExplorer
      key={JSON.stringify([props.scopeKey, props.project.id, props.timeBasis ?? 'received'])}
      {...props}
    />
  );
}
function ScopedExplorer({
  project,
  initialQuery,
  client,
  onSignIn,
  timeBasis = 'received',
}: EventExplorerProps) {
  const [initial] = useState(() => ({ ...initialQuery }));
  const [model] = useState(() =>
    createEventExplorerModel({ projectId: project.id, initialQuery: initial, client }),
  );
  const state = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
  const [from, setFrom] = useState(initial.from.slice(0, 19));
  const [to, setTo] = useState(initial.to.slice(0, 19));
  const [eventName, setEventName] = useState(initial.eventName ?? '');
  const [sessionId, setSessionId] = useState(initial.sessionId ?? '');
  useEffect(() => {
    let active = true;
    // Skip requests from an effect discarded by React's development replay.
    queueMicrotask(() => {
      if (active) void model.apply(initial);
    });
    return () => {
      active = false;
      model.cancel();
    };
  }, [model, initial]);
  const error = state.eventsError;
  return (
    <section className={styles.root} aria-busy={state.loading}>
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>
            SIGNALTRAIL / <span>{project.name}</span>
          </p>
          <h1>Event explorer</h1>
          <p>
            {timeBasis === 'occurred'
              ? 'Explore activity captured by your application.'
              : 'Explore activity received from your application.'}
          </p>
        </div>
        <button disabled={state.loading} onClick={() => void model.refresh()}>
          Refresh
        </button>
      </header>
      <form
        className={styles.filters}
        onSubmit={(event) => {
          event.preventDefault();
          const utc = (value: string) => `${value.length === 16 ? `${value}:00` : value}Z`;
          void model.apply({
            from: utc(from),
            to: utc(to),
            ...(eventName === '' ? {} : { eventName }),
            ...(sessionId === '' ? {} : { sessionId }),
          });
        }}
      >
        <label>
          From (UTC)
          <input
            type="datetime-local"
            required
            step="1"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </label>
        <label>
          To (UTC)
          <input
            type="datetime-local"
            required
            step="1"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </label>
        <label>
          Event name
          <input
            value={eventName}
            onChange={(e) => setEventName(e.target.value)}
            placeholder="All events"
          />
        </label>
        <label>
          Session ID
          <input
            value={sessionId}
            onChange={(e) => setSessionId(e.target.value)}
            placeholder="All sessions"
          />
        </label>
        <button className={styles.primary} type="submit">
          Apply filters
        </button>
      </form>
      <div className={styles.summary}>
        <div>
          <p>Unique events</p>
          <strong aria-label="Unique events">
            {state.countError
              ? 'Total unavailable'
              : state.count === undefined
                ? '—'
                : new Intl.NumberFormat('en-US').format(BigInt(state.count))}
          </strong>
        </div>
        {client.countVisitors && (
          <div>
            <p>Unique visitors</p>
            <strong aria-label="Unique visitors">
              {state.visitorError
                ? 'Total unavailable'
                : state.visitors === undefined
                  ? '—'
                  : new Intl.NumberFormat('en-US').format(BigInt(state.visitors))}
            </strong>
          </div>
        )}
        <p>
          {timeBasis === 'occurred' ? 'Event time' : 'Received time'} · UTC
          <br />
          Exact event and session filters
        </p>
      </div>
      {error && (
        <div role="alert" className={styles.error}>
          {error === 'sign_in' ? (
            <>
              Your session has expired. <button onClick={onSignIn}>Sign in again</button>
            </>
          ) : error === 'forbidden' ? (
            'You no longer have access to this project.'
          ) : error === 'invalid_query' ? (
            'Check your filters. Choose a valid UTC range of up to 31 days.'
          ) : (
            'Events are temporarily unavailable. Try refreshing.'
          )}
        </div>
      )}
      <div className={styles.results}>
        <div className={styles.tableWrap} role="region" aria-label="Event results" tabIndex={0}>
          <table>
            <thead>
              <tr>
                <th>Event</th>
                <th>Event ID</th>
                <th>Session</th>
                <th>Sequence</th>
                {timeBasis === 'occurred' && <th>Event time (UTC)</th>}
                <th>Received at (UTC)</th>
              </tr>
            </thead>
            <tbody>
              {state.page?.events.map((event) => (
                <tr key={event.eventId}>
                  <td>{event.eventName}</td>
                  <td>{event.eventId}</td>
                  <td>{event.sessionId}</td>
                  <td>{event.sequence}</td>
                  {timeBasis === 'occurred' && (
                    <td>
                      {'occurredAt' in event && typeof event.occurredAt === 'string'
                        ? event.occurredAt
                        : '—'}
                    </td>
                  )}
                  <td>{event.receivedAt}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!error && state.page?.events.length === 0 && (
          <p className={styles.empty}>No events match these filters.</p>
        )}
        <footer className={styles.pagination}>
          <span role="status">{state.loading ? 'Loading events…' : `Page ${state.pageIndex}`}</span>
          <div>
            <button
              disabled={state.loading || state.pageIndex === 1}
              onClick={() => void model.first()}
            >
              First page
            </button>
            <button
              disabled={state.loading || !state.page?.hasMore}
              onClick={() => void model.next()}
            >
              Next page
            </button>
          </div>
        </footer>
      </div>
      <p className={styles.note}>
        {timeBasis === 'occurred'
          ? 'Newest captured events first. Late arrivals may update totals and pages.'
          : 'Newest received events first. Totals and pages may change as events arrive or are retried.'}
      </p>
    </section>
  );
}
