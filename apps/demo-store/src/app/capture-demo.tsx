'use client';
import { useEffect, useRef, useState } from 'react';
import { openAnalyticsClient, type AnalyticsClient } from '@signaltrail/browser-sdk';

export function CaptureDemo() {
  const client = useRef<AnalyticsClient | null>(null);
  const [status, setStatus] = useState('Preparing analytics…');
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const projectKey = process.env.NEXT_PUBLIC_SIGNALTRAIL_PROJECT_KEY;
    const ingestionUrl = process.env.NEXT_PUBLIC_SIGNALTRAIL_INGESTION_URL;
    let active = true;
    let owned: AnalyticsClient | undefined;
    if (!projectKey || !ingestionUrl) {
      queueMicrotask(() => {
        if (active) setStatus('Local analytics is not configured yet.');
      });
      return () => {
        active = false;
      };
    }
    void openAnalyticsClient({ projectKey, ingestionUrl })
      .then((value) => {
        owned = value;
        if (!active) {
          value.close();
          return;
        }
        client.current = value;
        setReady(true);
        setStatus('Ready. Choose a product to capture an event.');
      })
      .catch(() => {
        if (active) setStatus('Analytics could not start. Browser storage may be unavailable.');
      });
    return () => {
      active = false;
      client.current = null;
      owned?.close();
    };
  }, []);
  async function capture(productId: string) {
    if (!client.current || busy) return;
    setBusy(true);
    try {
      const result = await client.current.track('demo_product_viewed', { productId });
      setStatus(
        result.status === 'queued'
          ? 'Event queued. Delivery runs automatically; offline events stay queued for retry.'
          : `Event was not queued (${result.status}).`,
      );
    } catch {
      setStatus('Capture could not be confirmed.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-labelledby="products">
      <h2 id="products">Explore the collection</h2>
      <p>Choose a product to send a demo product-view event to your SignalTrail project.</p>
      <div className="products">
        {(
          [
            ['trail-notebook', 'Trail notebook', '$12'],
            ['field-mug', 'Field mug', '$18'],
          ] as const
        ).map(([id, name, price]) => (
          <article key={id}>
            <h3>{name}</h3>
            <p>{price}</p>
            <button
              disabled={!ready || busy}
              onClick={() => {
                void capture(id);
              }}
            >
              View {name.toLowerCase()}
            </button>
          </article>
        ))}
      </div>
      <p role="status">{status}</p>
      <p>This local demo captures analytics only. Session replay is not enabled.</p>
    </section>
  );
}
