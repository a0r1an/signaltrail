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
  await open(page, scenario);
  const captured = await page.evaluate(() => window.harness.capture({ immediate: true }));
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
