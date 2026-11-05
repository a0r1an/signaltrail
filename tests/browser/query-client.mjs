import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAnalyticsQueryHandler } from '../../packages/analytics/dist/index.js';
import { cleanupResources } from '../load/cleanup.mjs';
import { finishRun } from '../load/run-result.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const { chromium } = createRequire(
  new URL('../../packages/browser-sdk/package.json', import.meta.url),
)('@playwright/test');
const directory = resolve(
  root,
  'test-results/query-client-browser',
  new Date().toISOString().replaceAll(':', '-'),
);
await mkdir(directory, { recursive: true });
const bundle = await readFile(
  new URL('../../packages/analytics/dist/query-client.js', import.meta.url),
);
const html = `<!doctype html><title>SignalTrail query client browser probe</title><p>Owned query fixture</p>
<script type="module">
import {createQueryClient} from '/query-client.js';
window.makeClient=(prefix='',timeoutMs=1000)=>createQueryClient({endpoint:location.origin+prefix,fetch:(input,options)=>fetch(input,{...options,credentials:'same-origin'}),timeoutMs});
window.createQueryClient=createQueryClient;window.client=window.makeClient();window.ready=true;
</script>`;
const result = {
  passed: false,
  node: process.version,
  commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  workingTreeDirty:
    execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim().length >
    0,
  clientAssetBytes: bundle.byteLength,
  clientAssetSha256: createHash('sha256').update(bundle).digest('hex'),
  cases: {},
};
let origin,
  browser,
  context,
  anonymous,
  page,
  runError,
  tracing = false;
const errors = [];
let reads = 0;
let bodyClosed;
const closedBody = new Promise((resolve) => {
  bodyClosed = resolve;
});
const event = {
  eventId: 'event-z',
  eventName: 'viewed',
  sessionId: 'session-a',
  sequence: '18446744073709551615',
  receivedAt: '2026-11-01T12:00:00.000Z',
};
const queryHandler = createAnalyticsQueryHandler({
  resolveProjectAccess: async (request, projectId) => {
    if (!/(?:^|;\s*)fixture-session=a(?:;|$)/.test(request.headers.get('cookie') ?? ''))
      return { status: 'unauthenticated' };
    return projectId === 'project-a'
      ? { status: 'authorized', projectId }
      : { status: 'forbidden' };
  },
  countOccurredEvents: async () => {
    reads++;
    return { count: '2' };
  },
  countOccurredVisitors: async () => {
    reads++;
    return { count: '1' };
  },
  listOccurredEvents: async () => {
    reads++;
    return { events: [{ ...event, occurredAt: '2026-11-01T10:00:00.000Z' }], hasMore: false };
  },
  countReceivedEvents: async () => {
    reads++;
    return { count: '18446744073709551615' };
  },
  listReceivedEvents: async (query) => {
    reads++;
    return query.cursor
      ? { events: [{ ...event, eventId: 'event-a' }], hasMore: false }
      : { events: [event], hasMore: true, nextCursor: 'fixture-position' };
  },
});
const server = createServer((incoming, outgoing) => {
  void (async () => {
    const url = new URL(incoming.url ?? '/', origin);
    if (incoming.method !== 'GET') {
      outgoing.writeHead(405).end();
      return;
    }
    if (url.pathname === '/' || url.pathname === '/query-client.js') {
      outgoing
        .writeHead(200, {
          'content-type': url.pathname === '/' ? 'text/html' : 'text/javascript',
          'cache-control': 'no-store',
        })
        .end(url.pathname === '/' ? html : bundle);
      return;
    }
    if (url.pathname.startsWith('/slow/')) {
      outgoing.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      outgoing.flushHeaders();
      outgoing.write('{"count":"');
      outgoing.once('close', () => {
        if (!outgoing.writableEnded) bodyClosed();
      });
      return;
    }
    if (url.pathname.startsWith('/invalid/')) {
      outgoing
        .writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        .end('{"count":7}');
      return;
    }
    const response = await queryHandler(new Request(url, { headers: incoming.headers }));
    const body = new Uint8Array(await response.arrayBuffer());
    response.headers.forEach((value, key) => outgoing.setHeader(key, value));
    outgoing.writeHead(response.status).end(body);
  })().catch(() => {
    errors.push('Fixture request failed');
    if (!outgoing.headersSent) outgoing.writeHead(500);
    outgoing.end();
  });
});
async function bounded(promise, milliseconds) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Browser query probe exceeded its deadline')),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
try {
  await new Promise((done, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', done);
  });
  origin = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({ headless: true });
  result.browser = browser.version();
  context = await browser.newContext();
  anonymous = await browser.newContext();
  await context.addCookies([
    { name: 'fixture-session', value: 'a', httpOnly: true, sameSite: 'Strict', url: origin },
  ]);
  await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
  tracing = true;
  await bounded(
    (async () => {
      page = await context.newPage();
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(origin, { timeout: 5000 });
      await page.waitForFunction(() => window.ready === true, undefined, { timeout: 5000 });
      const query = {
        projectId: 'project-a',
        from: '2026-11-01T00:00:00Z',
        to: '2026-11-02T00:00:00Z',
      };
      const initial = await bounded(
        page.evaluate(async (query) => {
          const count = await window.client.countReceivedEvents(query);
          const first = await window.client.listReceivedEvents(query);
          const next = await window.client.listReceivedEvents({
            ...query,
            cursor: first.nextCursor,
          });
          return {
            count,
            first,
            next,
            cookie: document.cookie,
            buffer: typeof Buffer,
            snapshot: window.client.snapshot(),
          };
        }, query),
        10000,
      );
      assert.equal(initial.count.count, '18446744073709551615');
      assert.equal(initial.first.events[0].sequence, '18446744073709551615');
      assert.equal(initial.first.hasMore, true);
      assert.equal(initial.next.events[0].eventId, 'event-a');
      assert.equal(initial.next.hasMore, false);
      assert.equal(initial.cookie.includes('fixture-session'), false);
      assert.equal(initial.buffer, 'undefined');
      assert.equal(initial.snapshot.inFlight, 0);
      result.cases.nativeSessionAndExactValues = true;
      result.cases.reducedPageCursor = true;
      const beforeDenied = reads;
      const denied = await page.evaluate(async (query) => {
        try {
          await window.client.countReceivedEvents({ ...query, projectId: 'project-b' });
        } catch (error) {
          return { code: error.code, status: error.status };
        }
      }, query);
      assert.deepEqual(denied, { code: 'HTTP_ERROR', status: 403 });
      const anonymousPage = await anonymous.newPage();
      anonymousPage.on('pageerror', (error) => errors.push(error.message));
      await anonymousPage.goto(origin, { timeout: 5000 });
      await anonymousPage.waitForFunction(() => window.ready === true, undefined, {
        timeout: 5000,
      });
      const unauthenticated = await anonymousPage.evaluate(async (query) => {
        const client = window.createQueryClient({
          endpoint: location.origin,
          fetch: (input, options) => {
            const headers = new Headers(options.headers);
            headers.set('Authorization', 'Bearer fixture-ingestion-key');
            return fetch(input, { ...options, headers, credentials: 'same-origin' });
          },
        });
        try {
          await client.countReceivedEvents(query);
        } catch (error) {
          return { code: error.code, status: error.status };
        } finally {
          client.close();
        }
      }, query);
      assert.deepEqual(unauthenticated, { code: 'HTTP_ERROR', status: 401 });
      assert.equal(reads, beforeDenied);
      result.cases.authorizationBeforeReads = true;
      await context.setOffline(true);
      const offline = await page.evaluate(async (query) => {
        try {
          await window.client.countReceivedEvents(query);
        } catch (error) {
          return { code: error.code, retryable: error.retryable };
        }
      }, query);
      assert.deepEqual(offline, { code: 'NETWORK', retryable: true });
      await context.setOffline(false);
      assert.equal(
        (await page.evaluate((query) => window.client.countReceivedEvents(query), query)).count,
        '18446744073709551615',
      );
      result.cases.offlineRecovery = true;
      const invalid = await page.evaluate(async (query) => {
        const client = window.makeClient('/invalid/');
        try {
          await client.countReceivedEvents(query);
        } catch (error) {
          return error.code;
        } finally {
          client.close();
        }
      }, query);
      assert.equal(invalid, 'INVALID_RESPONSE');
      result.cases.runtimeResponseValidation = true;
      const timeout = await page.evaluate(async (query) => {
        const client = window.makeClient('/slow/', 100);
        try {
          await client.countReceivedEvents(query);
        } catch (error) {
          return error.code;
        } finally {
          client.close();
        }
      }, query);
      assert.equal(timeout, 'TIMEOUT');
      await bounded(closedBody, 2000);
      result.cases.stalledBodyCancellation = true;
      const disposed = await page.evaluate(async (query) => {
        window.disposed = window.makeClient('/slow/');
        const pending = window.disposed.countReceivedEvents(query).catch((error) => error.code);
        window.disposed.close();
        return pending;
      }, query);
      assert.equal(disposed, 'CLOSED');
      await page.waitForFunction(() => window.disposed.snapshot().inFlight === 0, undefined, {
        timeout: 5000,
      });
      result.cases.disposal = true;
      const occurrence = await page.evaluate(
        async (query) => ({
          events: await window.client.countOccurredEvents(query),
          visitors: await window.client.countOccurredVisitors(query),
          page: await window.client.listOccurredEvents(query),
        }),
        query,
      );
      assert.deepEqual(occurrence.events, { count: '2' });
      assert.deepEqual(occurrence.visitors, { count: '1' });
      assert.equal(occurrence.page.events[0].occurredAt, '2026-11-01T10:00:00.000Z');
      assert.equal(occurrence.page.events[0].receivedAt, event.receivedAt);
      result.cases.occurrenceTimeCountsAndPaging = true;
      assert.deepEqual(errors, []);
      result.passed = true;
    })(),
    30000,
  );
} catch (error) {
  runError = error;
} finally {
  const completed = await finishRun({
    result,
    runError,
    cleanup: () =>
      cleanupResources([
        {
          name: 'record query failure trace',
          run: async () => {
            if (tracing)
              await context.tracing.stop(
                runError ? { path: resolve(directory, 'trace.zip') } : undefined,
              );
          },
        },
        { name: 'close query browser context', run: () => context?.close() },
        { name: 'close anonymous context', run: () => anonymous?.close() },
        { name: 'close owned Chromium', run: () => browser?.close() },
        {
          name: 'close query fixture',
          run: () =>
            new Promise((done, reject) => {
              server.closeAllConnections();
              server.close((error) =>
                error && error.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : done(),
              );
            }),
        },
      ]),
    writeResult: (report) =>
      writeFile(resolve(directory, 'report.json'), JSON.stringify(report, null, 2)),
  });
  console.log(JSON.stringify({ directory, ...completed }, null, 2));
}
