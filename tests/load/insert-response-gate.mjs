import { createServer } from 'node:http';

// Test-only proxy: confirm ClickHouse stored the insert, then withhold its response.
// The owned worker must not advance its source offset on this ambiguous outcome.
export async function openInsertResponseGate() {
  let resolveStored;
  let rejectStored;
  let settled = false;
  const stored = new Promise((resolve, reject) => {
    resolveStored = resolve;
    rejectStored = reject;
  });
  void stored.catch(() => {});
  const pending = new Set();
  const controller = new AbortController();
  const server = createServer((request, response) => {
    pending.add(response);
    response.once('close', () => pending.delete(response));
    void (async () => {
      if (request.method !== 'POST') throw new Error('Unexpected insert gate method');
      const chunks = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > 1024 * 1024) throw new Error('Insert gate request exceeded test bound');
        chunks.push(chunk);
      }
      const upstream = new URL('http://127.0.0.1:38123');
      upstream.search = new URL(request.url, 'http://localhost').search;
      const acknowledged = await fetch(upstream, {
        method: 'POST',
        headers: {
          Authorization: request.headers.authorization ?? '',
          'Content-Type': 'application/x-ndjson',
        },
        body: Buffer.concat(chunks),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]),
      });
      if (acknowledged.status !== 200) {
        await acknowledged.body?.cancel();
        throw new Error('Insert gate did not receive storage acknowledgement');
      }
      const body = await acknowledged.text();
      if (
        body.trim() ||
        ![null, '0'].includes(acknowledged.headers.get('X-ClickHouse-Exception-Code'))
      )
        throw new Error('Insert gate did not receive storage acknowledgement');
      settled = true;
      resolveStored();
      // Intentionally do not end response. Killing the child loses this acknowledgement.
    })().catch(() => {
      settled = true;
      rejectStored(new Error('Insert response gate failed'));
      response.destroy();
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Insert response gate did not bind');
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    async waitForStored() {
      let timer;
      try {
        await Promise.race([
          stored,
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new Error('Insert response gate deadline exceeded')),
              15000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
    async close() {
      controller.abort();
      if (!settled) rejectStored(new Error('Insert response gate closed'));
      for (const response of pending) response.destroy();
      server.closeAllConnections();
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
