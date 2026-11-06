import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAnalyticsQueryHandler } from '../../packages/analytics/dist/index.js';
import { cleanupResources } from '../load/cleanup.mjs';
import { finishRun } from '../load/run-result.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const { chromium, expect } = createRequire(
  new URL('../../packages/browser-sdk/package.json', import.meta.url),
)('@playwright/test');
const directory = resolve(
  root,
  'test-results/event-explorer-browser',
  new Date().toISOString().replaceAll(':', '-'),
);
await mkdir(directory, { recursive: true });
const [script, css] = await Promise.all([
  readFile(new URL('../../apps/dashboard/.browser-harness/explorer.mjs', import.meta.url)),
  readFile(new URL('../../apps/dashboard/.browser-harness/explorer.css', import.meta.url)),
]);
const html =
  '<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><title>SignalTrail explorer fixture</title><link rel="stylesheet" href="/explorer.css"><div id="root"></div><script type="module" src="/explorer.js"></script>';
const result = {
  passed: false,
  node: process.version,
  commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  workingTreeDirty:
    execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim().length >
    0,
  cases: {},
};
let origin,
  browser,
  context,
  page,
  runError,
  tracing = false;
const errors = [],
  pending = new Set();
let config = {
  countFails: false,
  eventsUnauthorized: false,
  countDelayMs: 0,
  malicious: false,
  status: 'ok',
};
let reads = 0;
const rows = [
  {
    eventId: 'evt_checkout_01',
    eventName: 'checkout_started',
    sessionId: 'session-checkout',
    sequence: '12',
    receivedAt: '2026-11-01T12:03:00.000Z',
  },
  {
    eventId: 'evt_product_01',
    eventName: 'product_viewed',
    sessionId: 'session-products',
    sequence: '11',
    receivedAt: '2026-11-01T12:02:00.000Z',
  },
  {
    eventId: 'evt_page_01',
    eventName: 'page_viewed',
    sessionId: 'session-checkout',
    sequence: '10',
    receivedAt: '2026-11-01T12:01:00.000Z',
  },
];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function data(query, mode) {
  if (query.eventName === 'slow') {
    await delay(700);
    return [{ ...rows[0], eventId: 'stale-project-a', eventName: 'slow' }];
  }
  let source =
    query.projectId === 'project-a'
      ? rows
      : [{ ...rows[0], eventId: 'evt_purchase_b', eventName: 'purchase_completed' }];
  if (mode.malicious) source = [{ ...rows[0], eventName: '<img src=x onerror=alert(1)>' }];
  return source.filter(
    (row) =>
      (!query.eventName || row.eventName === query.eventName) &&
      (!query.sessionId || row.sessionId === query.sessionId) &&
      Date.parse(row.receivedAt) >= Date.parse(query.from) &&
      Date.parse(row.receivedAt) < Date.parse(query.to),
  );
}
const handler = createAnalyticsQueryHandler({
  resolveProjectAccess: async (request, projectId) => {
    if (
      config.status === 'unauthenticated' ||
      (config.eventsUnauthorized && new URL(request.url).pathname.endsWith('/events')) ||
      !/(?:^|;\s*)fixture-session=a(?:;|$)/.test(request.headers.get('cookie') ?? '')
    )
      return { status: 'unauthenticated' };
    if (config.status === 'forbidden') return { status: 'forbidden' };
    return ['project-a', 'project-b'].includes(projectId)
      ? { status: 'authorized', projectId }
      : { status: 'forbidden' };
  },
  countOccurredVisitors: async () => ({ count: '1' }),
  countOccurredEvents: async (query) => ({
    count: String((await data(query, { ...config })).length),
  }),
  listOccurredEvents: async (query) => ({
    events: (await data(query, { ...config })).map((event) => ({
      ...event,
      occurredAt: '2026-11-01T11:00:00.000Z',
    })),
    hasMore: false,
  }),
  countReceivedEvents: async (query) => {
    reads++;
    const mode = { ...config };
    await delay(mode.countDelayMs);
    if (mode.countFails) throw new Error('Owned count failure');
    return { count: String((await data(query, mode)).length) };
  },
  listReceivedEvents: async (query) => {
    reads++;
    const source = await data(query, { ...config });
    const offset = query.cursor ? 2 : 0;
    const events = source.slice(offset, offset + 2);
    return source.length > offset + 2
      ? { events, hasMore: true, nextCursor: 'fixture-position-2' }
      : { events, hasMore: false };
  },
});
const server = createServer((incoming, outgoing) => {
  const work = (async () => {
    const url = new URL(incoming.url ?? '/', origin);
    if (url.pathname === '/control' && incoming.method === 'POST') {
      let body = '';
      for await (const chunk of incoming) {
        body += chunk;
        if (body.length > 4096) throw new Error('Oversized fixture control');
      }
      const update = JSON.parse(body);
      if (Object.keys(update).some((key) => !Object.hasOwn(config, key)))
        throw new Error('Unknown fixture control');
      config = { ...config, ...update };
      outgoing.writeHead(204).end();
      return;
    }
    if (incoming.method !== 'GET') {
      outgoing.writeHead(405).end();
      return;
    }
    if (['/', '/explorer.js', '/explorer.css'].includes(url.pathname)) {
      outgoing
        .writeHead(200, {
          'cache-control': 'no-store',
          'content-type':
            url.pathname === '/'
              ? 'text/html'
              : url.pathname.endsWith('.css')
                ? 'text/css'
                : 'text/javascript',
        })
        .end(url.pathname === '/' ? html : url.pathname.endsWith('.css') ? css : script);
      return;
    }
    const headers = new Headers();
    if (typeof incoming.headers.cookie === 'string') headers.set('cookie', incoming.headers.cookie);
    if (url.pathname.startsWith('/api/analytics/'))
      url.pathname = '/v1/analytics/' + url.pathname.slice('/api/analytics/'.length);
    const response = await handler(new Request(url, { headers }));
    const body = new Uint8Array(await response.arrayBuffer());
    if (outgoing.destroyed) return;
    response.headers.forEach((value, key) => outgoing.setHeader(key, value));
    outgoing.writeHead(response.status).end(body);
  })().catch(() => {
    errors.push('Explorer fixture request failed');
    if (!outgoing.destroyed) {
      if (!outgoing.headersSent) outgoing.writeHead(500);
      outgoing.end();
    }
  });
  pending.add(work);
  void work.then(() => pending.delete(work));
});
async function bounded(promise, ms) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Explorer browser probe exceeded its deadline')),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function configure(update) {
  const response = await fetch(origin + '/control', {
    method: 'POST',
    body: JSON.stringify(update),
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(response.status, 204);
}
try {
  await new Promise((done, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', done);
  });
  origin = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({ headless: true });
  result.browser = browser.version();
  context = await browser.newContext({ viewport: { width: 1280, height: 960 } });
  await context.addCookies([
    { name: 'fixture-session', value: 'a', httpOnly: true, sameSite: 'Strict', url: origin },
  ]);
  await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
  tracing = true;
  page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await bounded(
    (async () => {
      await page.goto(origin, { timeout: 5000 });
      await expect(
        page.getByRole('heading', { name: 'Event explorer', exact: true }),
      ).toBeVisible();
      await expect(page.getByLabel('Event name', { exact: true })).toHaveCount(1);
      await expect(page.getByRole('cell', { name: 'checkout_started', exact: true })).toBeVisible();
      await expect(page.getByLabel('Unique events', { exact: true })).toHaveText('3');
      assert.equal(
        await page.locator('section').evaluate((node) => getComputedStyle(node).paddingTop),
        '40px',
      );
      assert.equal(
        await page.locator('h1').evaluate((node) => getComputedStyle(node).fontSize),
        '32px',
      );
      await page.screenshot({ path: resolve(directory, 'event-explorer.png'), fullPage: true });
      result.cases.initialData = true;
      await page.getByRole('button', { name: 'Next page', exact: true }).click();
      await expect(page.getByRole('cell', { name: 'page_viewed', exact: true })).toBeVisible();
      await expect(page.getByText('Page 2', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'First page', exact: true }).click();
      await expect(page.getByRole('cell', { name: 'checkout_started', exact: true })).toBeVisible();
      result.cases.cursorNavigation = true;
      await page.getByLabel('Event name', { exact: true }).fill('product_viewed');
      await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
      await expect(page.getByLabel('Unique events', { exact: true })).toHaveText('1');
      await expect(page.getByRole('cell', { name: 'product_viewed', exact: true })).toBeVisible();
      await expect(page.getByRole('cell', { name: 'checkout_started', exact: true })).toHaveCount(
        0,
      );
      result.cases.exactFilter = true;
      await configure({ countFails: true });
      await page.getByRole('button', { name: 'Refresh', exact: true }).click();
      await expect(page.getByText('Total unavailable', { exact: true })).toBeVisible();
      await expect(page.getByRole('cell', { name: 'product_viewed', exact: true })).toBeVisible();
      result.cases.partialFailure = true;
      await configure({ countFails: false, malicious: true });
      await page.getByLabel('Event name', { exact: true }).fill('');
      await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
      await expect(
        page.getByRole('cell', { name: '<img src=x onerror=alert(1)>', exact: true }),
      ).toBeVisible();
      assert.equal(await page.locator('img').count(), 0);
      result.cases.safeRendering = true;
      await configure({ malicious: false });
      await page.getByLabel('Event name', { exact: true }).fill('slow');
      await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
      await page.getByRole('button', { name: 'Switch project', exact: true }).click();
      await expect(page.getByText('Second project', { exact: true })).toBeVisible();
      await expect(
        page.getByRole('cell', { name: 'purchase_completed', exact: true }),
      ).toBeVisible();
      await delay(800);
      await expect(page.getByRole('cell', { name: 'slow', exact: true })).toHaveCount(0);
      await expect(page.getByRole('cell', { name: 'product_viewed', exact: true })).toHaveCount(0);
      result.cases.projectSwitch = true;
      await page.getByLabel('Event name', { exact: true }).fill('slow');
      await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
      await page.getByRole('button', { name: 'Replace session', exact: true }).click();
      await expect(page.getByLabel('Event name', { exact: true })).toHaveValue('');
      await expect(
        page.getByRole('cell', { name: 'purchase_completed', exact: true }),
      ).toBeVisible();
      await delay(800);
      await expect(page.getByRole('cell', { name: 'slow', exact: true })).toHaveCount(0);
      result.cases.sessionScopeReset = true;
      await page.getByLabel('Session ID', { exact: true }).fill('missing-session');
      await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
      await expect(page.getByText('No events match these filters.', { exact: true })).toBeVisible();
      await expect(page.getByLabel('Unique events', { exact: true })).toHaveText('0');
      await expect(page.getByRole('button', { name: 'Next page', exact: true })).toBeDisabled();
      result.cases.emptyResults = true;
      await page.getByLabel('Session ID', { exact: true }).fill('');
      await page.getByLabel('From (UTC)', { exact: true }).fill('2026-11-03T00:00');
      await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
      await expect(page.getByRole('alert')).toContainText('Check your filters');
      await expect(page.getByRole('cell', { name: 'purchase_completed', exact: true })).toHaveCount(
        0,
      );
      result.cases.invalidRange = true;
      await page.getByLabel('From (UTC)', { exact: true }).fill('2026-11-01T00:00');
      await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
      await expect(
        page.getByRole('cell', { name: 'purchase_completed', exact: true }),
      ).toBeVisible();
      await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(
        await page.locator('table').evaluate((node) => node.getBoundingClientRect().width >= 900),
        true,
      );
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );
      await page.screenshot({
        path: resolve(directory, 'event-explorer-mobile.png'),
        fullPage: true,
      });
      result.cases.narrowViewport = true;
      const resultsRegion = page.getByRole('region', { name: 'Event results', exact: true });
      await resultsRegion.focus();
      await page.keyboard.press('ArrowRight');
      await expect.poll(() => resultsRegion.evaluate((node) => node.scrollLeft)).toBeGreaterThan(0);
      result.cases.keyboardTableScroll = true;
      await configure({ status: 'forbidden' });
      await page.getByRole('button', { name: 'Refresh', exact: true }).click();
      await expect(page.getByRole('alert')).toHaveText(
        'You no longer have access to this project.',
      );
      await expect(page.getByRole('cell', { name: 'purchase_completed', exact: true })).toHaveCount(
        0,
      );
      result.cases.revokedMembership = true;
      await configure({ status: 'ok' });
      await page.getByRole('button', { name: 'Refresh', exact: true }).click();
      await expect(
        page.getByRole('cell', { name: 'purchase_completed', exact: true }),
      ).toBeVisible();
      await configure({ eventsUnauthorized: true, countDelayMs: 700 });
      await page.getByRole('button', { name: 'Refresh', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Sign in again', exact: true })).toBeVisible();
      await expect(page.getByRole('cell', { name: 'purchase_completed', exact: true })).toHaveCount(
        0,
      );
      await page.getByRole('button', { name: 'Sign in again', exact: true }).click();
      await expect(page.getByText('Sign-in requested', { exact: true })).toBeVisible();
      result.cases.immediateDenialClearing = true;
      await configure({ status: 'ok', eventsUnauthorized: false, countDelayMs: 0 });
      await page.goto(origin + '/?basis=occurred');
      await expect(
        page.getByRole('columnheader', { name: 'Event time (UTC)', exact: true }),
      ).toBeVisible();
      await expect(page.getByText('Event time · UTC', { exact: false })).toBeVisible();
      result.cases.eventTimeView = true;
      const connectedRequest = page.waitForRequest(
        (request) => new URL(request.url()).pathname === '/api/analytics/occurred/events',
      );
      await page.goto(origin + '/?basis=connected');
      await connectedRequest;
      await expect(
        page.getByRole('columnheader', { name: 'Event time (UTC)', exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole('cell', { name: '2026-11-01T11:00:00.000Z', exact: true }),
      ).toHaveCount(3);
      await expect(
        page.getByRole('cell', { name: '2026-11-01T12:03:00.000Z', exact: true }),
      ).toBeVisible();
      await page.screenshot({
        path: resolve(directory, 'event-time-connected.png'),
        fullPage: true,
      });
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.screenshot({
        path: resolve(directory, 'event-time-connected-desktop.png'),
        fullPage: true,
      });
      await expect(page.getByLabel('Unique visitors', { exact: true })).toHaveText('1');
      result.cases.connectedSameOriginOccurrenceView = true;
      await page.route('**/dashboard?**', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: '<!doctype html><p>Project selection submitted</p>',
        }),
      );
      await page.getByLabel('Project', { exact: true }).selectOption('project-b');
      await page.getByRole('button', { name: 'Open project', exact: true }).click();
      await expect(page).toHaveURL(/\/dashboard\?/);
      const projectSelection = new URL(page.url());
      assert.equal(projectSelection.searchParams.get('projectId'), 'project-b');
      assert.equal(projectSelection.searchParams.get('projectCursor'), 'fixture-project-position');
      result.cases.projectPickerPreservesPageOnSelection = true;
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
          name: 'record explorer failure trace',
          run: async () => {
            if (tracing)
              await context.tracing.stop(
                runError ? { path: resolve(directory, 'trace.zip') } : undefined,
              );
          },
        },
        { name: 'close explorer context', run: () => context?.close() },
        { name: 'close owned Chromium', run: () => browser?.close() },
        {
          name: 'close explorer fixture',
          run: () =>
            new Promise((done, reject) => {
              server.closeAllConnections();
              server.close((error) =>
                error && error.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : done(),
              );
            }),
        },
        { name: 'settle owned fixture operations', run: () => Promise.allSettled([...pending]) },
      ]),
    writeResult: (report) =>
      writeFile(resolve(directory, 'report.json'), JSON.stringify(report, null, 2)),
  });
  console.log(JSON.stringify({ directory, ...completed }, null, 2));
}
