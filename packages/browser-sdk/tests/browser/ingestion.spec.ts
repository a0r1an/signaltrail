import { test, expect, state, configure } from './fixtures.ts';

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
