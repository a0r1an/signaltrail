import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { createIngestionHandler, type IngestionOptions } from './handler.ts';

export function createIngestionServer(options: IngestionOptions) {
  const handle = createIngestionHandler(options);
  return createServer(
    { requestTimeout: 10_000, headersTimeout: 10_000, maxHeaderSize: 8192 },
    (incoming, outgoing) => {
      void (async () => {
        const headers = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (value !== undefined)
            headers.set(name, Array.isArray(value) ? value.join(',') : value);
        }
        const init: RequestInit & { duplex?: 'half' } = {
          method: incoming.method ?? 'GET',
          headers,
        };
        if (!['GET', 'HEAD'].includes(init.method!)) {
          init.body = Readable.toWeb(incoming) as ReadableStream<Uint8Array>;
          init.duplex = 'half';
        }
        const request = new Request(
          new URL(incoming.url ?? '/', `http://${headers.get('host') ?? 'localhost'}`),
          init,
        );
        const response = await handle(request);
        outgoing.statusCode = response.status;
        response.headers.forEach((value, name) => outgoing.setHeader(name, value));
        outgoing.end(Buffer.from(await response.arrayBuffer()));
        incoming.resume();
      })().catch(() => {
        if (!outgoing.headersSent) {
          outgoing.writeHead(503, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
          });
          outgoing.end(JSON.stringify({ error: 'SERVICE_UNAVAILABLE' }));
        } else outgoing.end();
        incoming.resume();
      });
    },
  );
}
