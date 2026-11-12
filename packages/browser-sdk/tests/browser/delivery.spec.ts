import { test, expect, open, state, configure } from './fixtures.ts';

test('the built SDK captures and delivers an event through the fixture page', async ({
  page,
  request,
  scenario,
}) => {
  await open(page, scenario);
  await page.getByRole('button', { name: 'Capture event', exact: true }).click();
  await expect
    .poll(
      async () => (await state(request, scenario)).requests.flatMap((item) => item.events).length,
    )
    .toBe(1);
  await expect(page.getByLabel('Queue')).toHaveText('[]');
  await expect(page.getByLabel('Received events')).toContainText('harness_event');
});

test('persists an unacknowledged event across reload and retries with the same ID', async ({
  page,
  request,
  scenario,
}) => {
  await configure(request, scenario, { status: 503 });
  // A long interval keeps timer flushes out of the way of the immediate attempt.
  await open(page, scenario, 60_000);
  // Close once the 503 attempt is recorded: a backoff retry in flight during reload
  // would keep its claim leased for 60 s, longer than this test waits.
  const captured = await page.evaluate(async () => {
    const result = await window.harness.capture({ immediate: true });
    window.harness.delivery.close();
    return result;
  });
  expect(captured.status).toBe('queued');
  await expect(page.getByLabel('Queue')).toContainText(captured.eventId);
  await configure(request, scenario, { status: 200 });
  await page.reload();
  await expect(page.getByRole('button', { name: 'Capture event', exact: true })).toBeEnabled();
  await expect
    .poll(async () =>
      (await state(request, scenario)).requests.some(
        (item) =>
          !item.beacon &&
          item.status === 200 &&
          item.events.some((event) => event.eventId === captured.eventId),
      ),
    )
    .toBe(true);
  await expect(page.getByLabel('Queue')).toHaveText('[]');
});

test('two tabs share IndexedDB and only one uploads an actively leased event', async ({
  page,
  context,
  request,
  scenario,
}) => {
  await configure(request, scenario, { delayMs: 1500 });
  await open(page, scenario, 60_000);
  const second = await context.newPage();
  await open(second, scenario, 60_000);
  const captured = await page.evaluate(() => window.harness.capture());
  await expect(second.getByLabel('Queue')).toContainText(captured.eventId);
  const results = await Promise.all([
    page.evaluate(() => window.harness.delivery.flush()),
    second.evaluate(() => window.harness.delivery.flush()),
  ]);
  expect(results.map((result) => result.status).sort()).toEqual(['applied', 'empty']);
  const received = (await state(request, scenario)).requests;
  expect(received).toHaveLength(1);
  expect(received[0]!.events.map((event) => event.eventId)).toEqual([captured.eventId]);
  await expect(page.getByLabel('Queue')).toHaveText('[]');
  await expect(second.getByLabel('Queue')).toHaveText('[]');
});

test('real navigation sends a beacon and preserves the event for acknowledged retry', async ({
  page,
  request,
  scenario,
}) => {
  await open(page, scenario, 60_000);
  const captured = await page.evaluate(() => window.harness.capture());
  await page.getByRole('link', { name: 'Navigate away' }).click();
  await expect(page).toHaveURL(/\/away$/);
  await expect
    .poll(async () =>
      (await state(request, scenario)).requests.some(
        (item) =>
          item.beacon &&
          item.status === 200 &&
          item.events.some((event) => event.eventId === captured.eventId),
      ),
    )
    .toBe(true);
  const beacons = (await state(request, scenario)).requests.filter((item) => item.beacon);
  expect(beacons).toHaveLength(1);
  expect(beacons[0]!.bytes).toBeLessThanOrEqual(60 * 1024);
  // Pause acknowledged delivery so reopening cannot hide an incorrect beacon deletion.
  await configure(request, scenario, { status: 401 });
  await open(page, scenario, 60_000);
  await expect(page.getByLabel('Queue')).toContainText(captured.eventId);
});

test('the immediate-send control bypasses batching only for its event', async ({
  page,
  request,
  scenario,
}) => {
  await open(page, scenario, 60_000);
  const queued = await page.evaluate(() => window.harness.capture());
  await page.getByRole('button', { name: 'Send immediately', exact: true }).click();
  await expect.poll(async () => (await state(request, scenario)).requests.length).toBe(1);
  const received = (await state(request, scenario)).requests[0]!;
  expect(received.beacon).toBe(false);
  expect(received.events).toHaveLength(1);
  expect(received.events[0]!.eventId).not.toBe(queued.eventId);
  await expect(page.getByLabel('Queue')).toHaveText(JSON.stringify([queued.eventId]));
});

test('the oversized-event control drops before persistence and leaves healthy delivery working', async ({
  page,
  request,
  scenario,
}) => {
  await open(page, scenario, 60_000);
  await page.getByRole('button', { name: 'Capture oversized event', exact: true }).click();
  await expect(page.getByLabel('Delivery log')).toContainText('event_too_large');
  await expect(page.getByLabel('Queue')).toHaveText('[]');
  expect((await state(request, scenario)).requests).toEqual([]);
  await page.getByRole('button', { name: 'Send immediately', exact: true }).click();
  await expect.poll(async () => (await state(request, scenario)).requests.length).toBe(1);
  expect((await state(request, scenario)).requests[0]!.status).toBe(200);
  await expect(page.getByLabel('Queue')).toHaveText('[]');
});

test('retains a browser-offline event and delivers the same ID after connectivity returns', async ({
  page,
  context,
  request,
  scenario,
}) => {
  await open(page, scenario, 60_000);
  await context.setOffline(true);
  try {
    const captured = await page.evaluate(async () => {
      // Bypass the fixture's refresh, which also needs the network.
      const result = await window.harness.delivery.enqueue({
        schemaVersion: 1,
        eventId: 'offline-event',
        eventName: 'offline_view',
        distinctId: 'visitor',
        sessionId: 'session',
        sequence: 0,
        clientTimestamp: new Date().toISOString(),
        url: location.href,
        properties: {},
        context: { sdkVersion: 'browser-test' },
      });
      await window.harness.delivery.flush();
      return {
        result,
        queue: await window.harness.delivery.getAll(),
        health: await window.harness.delivery.getHealth(),
      };
    });
    expect(captured.result.status).toBe('queued');
    expect(captured.queue).toMatchObject({
      status: 'read',
      events: [{ eventId: 'offline-event' }],
    });
    expect(captured.health.counters.networkErrors).toBe(1);
    expect(captured.health.counters.accepted ?? 0).toBe(0);
    expect((await state(request, scenario)).requests).toEqual([]);
    await context.setOffline(false);
    await expect.poll(async () => (await state(request, scenario)).requests.length).toBe(1);
    expect(
      (await state(request, scenario)).requests[0]!.events.map((event) => event.eventId),
    ).toEqual(['offline-event']);
    expect(await page.evaluate(() => window.harness.delivery.getAll())).toEqual({
      status: 'read',
      events: [],
    });
    expect((await page.evaluate(() => window.harness.delivery.getHealth())).counters.accepted).toBe(
      1,
    );
  } finally {
    await context.setOffline(false);
  }
});

test('reports native IndexedDB expiry once without uploading an expired event', async ({
  page,
  request,
  scenario,
}) => {
  const capturedAt = new Date('2026-10-30T12:00:00.000Z');
  await page.clock.install({ time: capturedAt });
  await open(page, scenario, 60_000);
  const captured = await page.evaluate(() => window.harness.capture());
  expect(captured.status).toBe('queued');
  await page.clock.setSystemTime(new Date(capturedAt.getTime() + 25 * 60 * 60 * 1000));
  const result = await page.evaluate(async () => {
    const queue = await window.harness.delivery.getAll();
    const first = await window.harness.delivery.getHealth();
    const second = await window.harness.delivery.getHealth();
    return { queue, first, second };
  });
  expect(result.queue).toEqual({ status: 'read', events: [] });
  expect(result.first.queue.storageMode).toBe('indexeddb');
  expect(result.first.counters.droppedExpired).toBe(1);
  expect(result.second.counters.droppedExpired).toBe(1);
  expect((await state(request, scenario)).requests).toEqual([]);
});

test('a future native IndexedDB upgrade preserves durable events and the older SDK continues in memory', async ({
  page,
  scenario,
}) => {
  await open(page, scenario, 60_000);
  const captured = await page.evaluate(() => window.harness.capture());
  const durableIds = await page.evaluate(async () => {
    const database = (await indexedDB.databases()).find((entry) =>
      entry.name?.startsWith('signaltrail:analytics:'),
    );
    if (!database?.name || database.version === undefined)
      throw new Error('Expected native queue database');
    return new Promise<string[]>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Native queue upgrade stayed blocked')),
        3000,
      );
      const request = indexedDB.open(database.name!, database.version! + 1);
      request.onerror = () => {
        clearTimeout(timer);
        reject(new Error('Native queue upgrade failed'));
      };
      request.onsuccess = () => {
        const upgraded = request.result;
        const read = upgraded.transaction('events').objectStore('events').getAll();
        read.onerror = () => {
          clearTimeout(timer);
          upgraded.close();
          reject(new Error('Native durable read failed'));
        };
        read.onsuccess = () => {
          const ids = (read.result as { eventId: string }[]).map((event) => event.eventId);
          clearTimeout(timer);
          upgraded.close();
          resolve(ids);
        };
      };
    });
  });
  expect(durableIds).toEqual([captured.eventId]);
  const next = await page.evaluate(() => window.harness.capture());
  const remaining = await page.evaluate(async () => ({
    queue: await window.harness.delivery.getAll(),
    health: await window.harness.delivery.getHealth(),
  }));
  expect(remaining.health.queue.storageMode).toBe('memory');
  expect(remaining.queue).toMatchObject({ status: 'read', events: [{ eventId: next.eventId }] });
});
