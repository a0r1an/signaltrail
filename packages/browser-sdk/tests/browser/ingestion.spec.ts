import { test, expect, state, configure, open } from './fixtures.ts';

test('the SDK crosses origins to the real ingestion handler and receives publication acknowledgment', async ({
  page,
  request,
  scenario,
}) => {
  await page.goto(`/?scenario=${scenario}&real=1`);
  await expect(page.getByRole('button', { name: 'Send immediately', exact: true })).toBeEnabled();
  const captured = await page.evaluate(() => window.harness.capture({ immediate: true }));
  await expect.poll(async () => (await state(request, scenario)).publications?.length ?? 0).toBe(1);
  const publication = (await state(request, scenario)).publications![0]!;
  expect(publication.projectId).toBe(`project-${scenario}`);
  expect(publication.event.eventId).toBe(captured.eventId);
  expect(publication.receivedAt).toBeTruthy();
  await expect(page.getByLabel('Queue')).toHaveText('[]');
});

test('a real publication failure retains the SDK event until a later confirmed retry', async ({
  page,
  request,
  scenario,
}) => {
  await configure(request, scenario, { status: 503 });
  await page.goto(`/?scenario=${scenario}&real=1`);
  await expect(page.getByRole('button', { name: 'Send immediately', exact: true })).toBeEnabled();
  const captured = await page.evaluate(() => window.harness.capture({ immediate: true }));
  await expect(page.getByLabel('Queue')).toContainText(captured.eventId);
  expect((await state(request, scenario)).publications).toEqual([]);
  await configure(request, scenario, { status: 200 });
  await expect.poll(async () => (await state(request, scenario)).publications?.length ?? 0).toBe(1);
  expect((await state(request, scenario)).publications![0]!.event.eventId).toBe(captured.eventId);
  await expect(page.getByLabel('Queue')).toHaveText('[]');
});

test('a navigation beacon authenticates through the real ingestion endpoint', async ({
  page,
  request,
  scenario,
}) => {
  await page.goto(`/?scenario=${scenario}&real=1&interval=60000`);
  await expect(page.getByRole('button', { name: 'Capture event', exact: true })).toBeEnabled();
  const captured = await page.evaluate(() => window.harness.capture());
  expect((await state(request, scenario)).publications).toEqual([]);
  await page.getByRole('link', { name: 'Navigate away' }).click();
  await expect(page).toHaveURL(/\/away$/);
  await expect.poll(async () => (await state(request, scenario)).publications?.length ?? 0).toBe(1);
  expect((await state(request, scenario)).publications![0]!.event.eventId).toBe(captured.eventId);
});

test('opt-in SDK health reports cross origins without becoming analytics events', async ({
  page,
  request,
  scenario,
}) => {
  await page.clock.install();
  await page.goto(`/?scenario=${scenario}&real=1&telemetry=1`);
  await expect(page.getByRole('button', { name: 'Send immediately', exact: true })).toBeEnabled();
  await page.evaluate(() => window.harness.capture({ immediate: true }));
  await page.clock.fastForward(60000);
  await expect.poll(async () => (await state(request, scenario)).healthReports.length).toBe(1);
  const result = await state(request, scenario);
  expect(result.healthReports[0]!.counters).toMatchObject({
    queued: 1,
    uploadAttempts: 1,
    accepted: 1,
  });
  expect(result.publications).toHaveLength(1);
  expect(JSON.stringify(result.healthReports)).not.toContain('harness-visitor');
});

test('public anonymous capture reaches ingestion with generated identity and private campaign context', async ({
  page,
  request,
  scenario,
}) => {
  await open(page, scenario);
  const captured = await page.evaluate(async (scenario) => {
    history.replaceState(null, '', '/?utm_source=email&utm_campaign=launch&secret=private#token');
    const client = await window.openAnalyticsClient(
      { projectKey: `harness-real-${scenario}`, ingestionUrl: 'http://127.0.0.1:4178/v1/events' },
      { flushIntervalMs: 60000 },
    );
    try {
      return await client.track('public_capture', { productId: '123' }, { sendImmediately: true });
    } finally {
      client.close();
    }
  }, scenario);
  expect(captured.status).toBe('queued');
  expect(captured).toHaveProperty('eventId');
  const observed = await state(request, scenario);
  expect(observed.publications).toHaveLength(1);
  const record = observed.publications[0]!;
  expect(record.projectId).toBe(`project-${scenario}`);
  expect(record.event).toMatchObject({
    eventName: 'public_capture',
    sequence: 0,
    url: 'http://127.0.0.1:4177/',
    properties: { productId: '123' },
    context: { sdkVersion: '0.1.0', campaign: { utm_source: 'email', utm_campaign: 'launch' } },
  });
  expect(record.event.distinctId).toMatch(/^[a-f0-9-]{36}$/);
  expect(record.event.sessionId).toMatch(/^[a-f0-9-]{36}$/);
  expect(captured).toMatchObject({ eventId: record.event.eventId });
});

declare global {
  interface Window {
    identityClient?: import('../../src/analytics-client.ts').AnalyticsClient;
  }
}
test('public identify automatically delivers a durable link separately from identified activity', async ({
  page,
  request,
  scenario,
}) => {
  await open(page, scenario);
  try {
    await page.evaluate(async (scenario) => {
      window.identityClient = await window.openAnalyticsClient(
        { projectKey: `harness-real-${scenario}`, ingestionUrl: 'http://127.0.0.1:4178/v1/events' },
        { flushIntervalMs: 100 },
      );
      await window.identityClient.track('anonymous_before');
      const result = await window.identityClient.identify('customer-1');
      if (result.status !== 'identified') throw new Error('Identify failed');
      await window.identityClient.track('identified_after');
    }, scenario);
    await expect
      .poll(async () => (await state(request, scenario)).publications?.length ?? 0)
      .toBe(3);
    const events = (await state(request, scenario)).publications!.map((record) => record.event);
    const before = events.find((event) => event.eventName === 'anonymous_before')!;
    const after = events.find((event) => event.eventName === 'identified_after')!;
    const link = events.find((event) => event.eventName === '$identify')!;
    expect(after.distinctId).toBe('customer-1');
    expect(after.context.identity).toEqual({
      kind: 'identified',
      anonymousId: before.distinctId,
      userId: 'customer-1',
    });
    expect(link.context.identity).toEqual({
      kind: 'link',
      anonymousId: before.distinctId,
      userId: 'customer-1',
    });
    expect(link.eventId).not.toBe(after.eventId);
  } finally {
    await page.evaluate(() => {
      window.identityClient?.close();
      delete window.identityClient;
    });
  }
});
