import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { cleanupResources } from './cleanup.mjs';

const { chromium } = createRequire(
  new URL('../../packages/browser-sdk/package.json', import.meta.url),
)('@playwright/test');
const origin = 'http://127.0.0.1:4179';
const html = `<!doctype html><title>SignalTrail native pipeline probe</title><p>Native IndexedDB recovery probe</p>
<script type="module">
import { openAutomaticDelivery } from '/sdk.js';
const params = new URLSearchParams(location.search);
window.delivery = await openAutomaticDelivery({projectKey:'load-test-key', ingestionUrl:params.get('ingestion')}, {flushIntervalMs:Number(params.get('interval')||200)});
window.capture = async () => {
 const eventId = crypto.randomUUID();
 const result = await window.delivery.enqueue({schemaVersion:1,eventId,eventName:'browser_pipeline',distinctId:'browser-probe-visitor',sessionId:'browser-probe-session',sequence:0,clientTimestamp:new Date().toISOString(),url:location.href,properties:{},context:{sdkVersion:'browser-pipeline'}});
 return {eventId,result};
};
window.ready = true;
</script>`;

export async function exerciseBrowserPipeline({ url, docker, query, directory }) {
  const bundle = await readFile(
    new URL('../../packages/browser-sdk/.browser-harness/sdk.js', import.meta.url),
  );
  const server = createServer((request, response) => {
    const route = new URL(request.url, origin).pathname;
    if (request.method !== 'GET' || !['/', '/sdk.js'].includes(route)) {
      response.writeHead(404).end();
      return;
    }
    response
      .writeHead(200, {
        'Content-Type': route === '/sdk.js' ? 'text/javascript' : 'text/html',
        'Cache-Control': 'no-store',
      })
      .end(route === '/sdk.js' ? bundle : html);
  });
  let browser, context;
  let paused = false;
  let failed = true;
  let probeError;
  const errors = [];
  try {
    await new Promise((done, reject) => {
      server.once('error', reject);
      server.listen(4179, '127.0.0.1', done);
    });
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext();
    await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
    context.on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)));
    let page = await context.newPage();
    const target = new URL(origin);
    target.searchParams.set('ingestion', url);
    target.searchParams.set('interval', '60000');
    await page.goto(target.href);
    await page.waitForFunction(() => window.ready === true);
    await context.setOffline(true);
    const captured = await page.evaluate(() => window.capture());
    assert.equal(captured.result.status, 'queued');
    assert.match(captured.eventId, /^[a-f0-9-]{36}$/);
    const initial = await page.evaluate(() => window.delivery.getHealth());
    assert.equal(initial.queue.storageMode, 'indexeddb');
    assert.equal(initial.queue.count, 1);
    await page.close({ runBeforeUnload: false });
    await docker(['pause', 'redpanda']);
    paused = true;
    await context.setOffline(false);
    page = await context.newPage();
    const retryResponse = page.waitForResponse(
      (response) => response.url() === url && response.request().method() === 'POST',
      { timeout: 15000 },
    );
    void retryResponse.catch(() => {});
    target.searchParams.set('interval', '200');
    await page.goto(target.href);
    await page.waitForFunction(() => window.ready === true);
    const response = await retryResponse;
    assert.equal(response.status(), 200);
    const reply = await response.json();
    assert.equal(reply.results[0].eventId, captured.eventId);
    assert.equal(reply.results[0].status, 'retry');
    const retained = await page.evaluate(() => window.delivery.getAll());
    assert.equal(retained.status, 'read');
    assert.deepEqual(
      retained.events.map((event) => event.eventId),
      [captured.eventId],
    );
    await docker(['unpause', 'redpanda']);
    paused = false;
    await page.waitForFunction(
      async () => {
        const result = await window.delivery.getAll();
        return result.status === 'read' && result.events.length === 0;
      },
      undefined,
      { timeout: 30000 },
    );
    const rows = Number(
      await query(
        `SELECT count() FROM signaltrail.analytics_events FINAL WHERE project_id = 'load-project' AND event_id = '${captured.eventId}'`,
      ),
    );
    // Storage can lag the ingestion acknowledgement; poll it independently.
    let stored = rows;
    const deadline = Date.now() + 30000;
    while (stored !== 1 && Date.now() < deadline) {
      await new Promise((done) => setTimeout(done, 100));
      stored = Number(
        await query(
          `SELECT count() FROM signaltrail.analytics_events FINAL WHERE project_id = 'load-project' AND event_id = '${captured.eventId}'`,
        ),
      );
    }
    assert.equal(stored, 1);
    assert.deepEqual(errors, []);
    await page.evaluate(() => window.delivery.close());
    failed = false;
    return {
      storageMode: 'indexeddb',
      eventId: captured.eventId,
      survivedPageClose: true,
      retainedOnPublicationRetry: true,
      uniqueStoredRows: stored,
      limitations: [
        'Native IndexedDB survives page close within one browser context; browser-process restart, eviction, and host loss are not covered.',
      ],
    };
  } catch (error) {
    probeError = error;
    throw error;
  } finally {
    try {
      await cleanupResources([
        {
          name: 'resume browser probe broker',
          run: (signal) =>
            paused ? docker(['unpause', 'redpanda'], false, false, signal) : undefined,
        },
        {
          name: 'save browser failure trace',
          run: () =>
            context?.tracing.stop(
              failed ? { path: resolve(directory, 'browser-pipeline-trace.zip') } : {},
            ),
        },
        { name: 'close browser context', run: () => context?.close() },
        { name: 'close owned Chromium', run: () => browser?.close() },
        {
          name: 'close browser fixture',
          run: () =>
            new Promise((done, reject) => {
              server.closeAllConnections();
              server.close((error) =>
                error && error.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : done(),
              );
            }),
        },
      ]);
    } catch (cleanupError) {
      if (probeError)
        throw new AggregateError([probeError, cleanupError], 'Browser probe and cleanup failed');
      throw cleanupError;
    }
  }
}
