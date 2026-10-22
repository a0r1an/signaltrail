import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

interface EventRecord {
  eventId: string;
  eventName: string;
}
export interface Scenario {
  status: number;
  delayMs: number;
  maxBytes: number;
  retryAfter: string;
  requests: { events: EventRecord[]; beacon: boolean; status: number; bytes: number; at: number }[];
}
const scenarios = new Map<string, Scenario>();
function scenario(id: string): Scenario {
  if (!scenarios.has(id))
    scenarios.set(id, {
      status: 200,
      delayMs: 0,
      maxBytes: 256 * 1024,
      retryAfter: '1',
      requests: [],
    });
  return scenarios.get(id)!;
}
function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}
async function body(request: IncomingMessage, limit: number) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk as Uint8Array);
    size += bytes.byteLength;
    if (size > limit) throw new Error('Request too large');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}
const assets = new Map<string, readonly [URL, string]>([
  ['/', [new URL('./fixture.html', import.meta.url), 'text/html']],
  ['/client.js', [new URL('./client.js', import.meta.url), 'text/javascript']],
  ['/sdk.js', [new URL('../.browser-harness/sdk.js', import.meta.url), 'text/javascript']],
]);
const server = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1:4177');
    if (url.pathname === '/health') return json(response, 200, { ready: true });
    if (url.pathname === '/away') {
      response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
      response.end('<!doctype html><title>Away</title><p>Navigation completed.</p>');
      return;
    }
    const route = /^\/(control|ingest)\/([a-zA-Z0-9-]+)$/.exec(url.pathname);
    if (route) {
      const state = scenario(route[2]!);
      if (route[1] === 'control') {
        if (request.method === 'DELETE') {
          scenarios.delete(route[2]!);
          return json(response, 200, { deleted: true });
        }
        if (request.method === 'POST') {
          const update = JSON.parse((await body(request, 4096)).toString()) as Partial<Scenario>;
          if (update.status !== undefined) {
            if (![200, 401, 403, 413, 429, 503].includes(update.status))
              return json(response, 400, { error: 'Invalid status' });
            state.status = update.status;
          }
          if (update.delayMs !== undefined) {
            if (!Number.isInteger(update.delayMs) || update.delayMs < 0 || update.delayMs > 20_000)
              return json(response, 400, { error: 'Invalid delay' });
            state.delayMs = update.delayMs;
          }
          if (update.maxBytes !== undefined) {
            if (!Number.isSafeInteger(update.maxBytes) || update.maxBytes < 1)
              return json(response, 400, { error: 'Invalid byte limit' });
            state.maxBytes = update.maxBytes;
          }
          if (update.retryAfter !== undefined) state.retryAfter = String(update.retryAfter);
        } else if (request.method !== 'GET')
          return json(response, 405, { error: 'Method not allowed' });
        return json(response, 200, state);
      }
      if (request.method !== 'POST') return json(response, 405, { error: 'Method not allowed' });
      const raw = await body(request, 2 * 1024 * 1024);
      const payload = JSON.parse(raw.toString()) as { projectKey?: string; events?: EventRecord[] };
      const beacon = request.headers.authorization === undefined;
      const key = beacon
        ? payload.projectKey
        : request.headers.authorization?.replace(/^Bearer /, '');
      if (key !== 'harness-project') return json(response, 401, { error: 'Invalid project key' });
      if (
        !Array.isArray(payload.events) ||
        payload.events.length < 1 ||
        payload.events.length > 100 ||
        payload.events.some((event) => typeof event.eventId !== 'string')
      )
        return json(response, 400, { error: 'Invalid batch' });
      // Snapshot behavior at receipt; later control changes cannot alter this response.
      const status = raw.byteLength > state.maxBytes ? 413 : state.status;
      const delayMs = state.delayMs;
      const retryAfter = state.retryAfter;
      state.requests.push({
        events: payload.events,
        beacon,
        status,
        bytes: raw.byteLength,
        at: Date.now(),
      });
      if (delayMs) await delay(delayMs);
      if (status === 429) response.setHeader('Retry-After', retryAfter);
      return json(
        response,
        status,
        status === 200
          ? {
              results: payload.events.map((event, index) => ({
                index,
                eventId: event.eventId,
                status: 'accepted',
              })),
            }
          : { error: `Controlled ${status}` },
      );
    }
    const asset = assets.get(url.pathname);
    if (!asset) return json(response, 404, { error: 'Not found' });
    const content = await readFile(asset[0]);
    response.writeHead(200, { 'Content-Type': asset[1], 'Cache-Control': 'no-store' });
    response.end(content);
  })().catch(() => {
    if (!response.headersSent) json(response, 400, { error: 'Invalid request' });
    else response.end();
  });
});
server.listen(4177, '127.0.0.1');
process.on('SIGTERM', () => {
  server.close();
  server.closeAllConnections();
});
