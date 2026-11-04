import { createServer } from 'node:http';
import { createAnalyticsQueryHandler, type AnalyticsQueryOptions } from './query-handler.ts';

export interface AnalyticsHttpOptions {
  origin: string;
  query: AnalyticsQueryOptions;
  maxConnections?: number;
  shutdownTimeoutMs?: number;
}

/** Creates an unbound server. Authentication must be supplied by the caller. */
export function createAnalyticsHttpServer(options: AnalyticsHttpOptions) {
  let origin: URL;
  try {
    origin = new URL(options.origin);
  } catch {
    throw new TypeError('Invalid query HTTP configuration');
  }
  const maximum = options.maxConnections ?? 128;
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? 1000;
  if (
    !['http:', 'https:'].includes(origin.protocol) ||
    origin.username ||
    origin.password ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash ||
    !Number.isSafeInteger(maximum) ||
    maximum < 1 ||
    maximum > 1024 ||
    !Number.isSafeInteger(shutdownTimeoutMs) ||
    shutdownTimeoutMs < 100 ||
    shutdownTimeoutMs > 10000
  )
    throw new TypeError('Invalid query HTTP configuration');
  const publicOrigin = origin.origin;
  const handler = createAnalyticsQueryHandler(options.query);
  const active = new Set<AbortController>();
  let closed = false;
  let closing: Promise<void> | undefined;
  const server = createServer(
    {
      maxHeaderSize: 32768,
      headersTimeout: 10000,
      requestTimeout: 15000,
      keepAliveTimeout: 5000,
      connectionsCheckingInterval: 1000,
    },
    (incoming, outgoing) => {
      const controller = new AbortController();
      active.add(controller);
      const abort = () => controller.abort();
      const disconnected = () => {
        if (!outgoing.writableEnded) abort();
      };
      incoming.once('aborted', abort);
      outgoing.once('close', disconnected);
      const sendError = (status: number, error: string) => {
        if (outgoing.destroyed || outgoing.writableEnded) return;
        outgoing.writeHead(status, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          Connection: 'close',
        });
        outgoing.end(JSON.stringify({ error }));
      };
      void (async () => {
        try {
          if (closed) {
            sendError(503, 'SERVICE_UNAVAILABLE');
            return;
          }
          const target = incoming.url ?? '';
          let authorizations = 0;
          for (let i = 0; i < incoming.rawHeaders.length; i += 2)
            if (incoming.rawHeaders[i]?.toLowerCase() === 'authorization') authorizations++;
          if (
            !target.startsWith('/') ||
            target.startsWith('//') ||
            authorizations > 1 ||
            incoming.headers['transfer-encoding'] !== undefined ||
            (incoming.headers['content-length'] !== undefined &&
              incoming.headers['content-length'] !== '0')
          ) {
            sendError(400, 'INVALID_REQUEST');
            return;
          }
          const headers = new Headers();
          for (const [key, value] of Object.entries(incoming.headers)) {
            if (key === 'host' || value === undefined) continue;
            if (Array.isArray(value)) for (const item of value) headers.append(key, item);
            else headers.set(key, value);
          }
          headers.set('host', origin.host);
          const request = new Request(publicOrigin + target, {
            method: incoming.method ?? 'GET',
            headers,
            signal: controller.signal,
          });
          const response = await handler(request);
          const body = new Uint8Array(await response.arrayBuffer());
          if (outgoing.destroyed || outgoing.writableEnded) return;
          response.headers.forEach((value, key) => {
            if (!['connection', 'content-length', 'transfer-encoding'].includes(key))
              outgoing.setHeader(key, value);
          });
          if (closed || incoming.method !== 'GET') outgoing.setHeader('Connection', 'close');
          outgoing.writeHead(response.status);
          outgoing.end(body);
        } catch {
          sendError(503, 'SERVICE_UNAVAILABLE');
        } finally {
          active.delete(controller);
          incoming.removeListener('aborted', abort);
          outgoing.removeListener('close', disconnected);
        }
      })();
    },
  );
  server.maxConnections = maximum;
  server.on('upgrade', (_request, socket) => socket.destroy());
  return {
    server,
    close(): Promise<void> {
      if (closing) return closing;
      closed = true;
      for (const controller of active) controller.abort();
      closing = new Promise<void>((resolve) => {
        const timer = setTimeout(() => server.closeAllConnections(), shutdownTimeoutMs);
        server.close(() => {
          clearTimeout(timer);
          resolve();
        });
        server.closeIdleConnections();
      });
      return closing;
    },
  };
}
