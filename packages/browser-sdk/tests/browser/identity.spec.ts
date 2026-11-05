import type { Page } from '@playwright/test';
import { test, expect, open } from './fixtures.ts';

async function allocate(page: Page, scenario: string, time?: number) {
  return page.evaluate(
    async ({ scenario, time }) => {
      const store = await window.openIdentityStore(
        {
          projectKey: `identity-${scenario}`,
          ingestionUrl: `${location.origin}/ingest/${scenario}`,
        },
        time === undefined ? {} : { now: () => time },
      );
      try {
        return await store.allocate();
      } finally {
        store.close();
      }
    },
    { scenario, time },
  );
}
test('native IndexedDB shares identity, reset and inactivity sessions across tabs and reopen', async ({
  page,
  context,
  scenario,
}) => {
  await open(page, scenario);
  const second = await context.newPage();
  await open(second, scenario);
  const [a, b] = await Promise.all([allocate(page, scenario), allocate(second, scenario)]);
  expect(a.anonymousId).toBe(b.anonymousId);
  expect(a.sessionId).toBe(b.sessionId);
  expect([a.sequence, b.sequence].sort()).toEqual([0, 1]);
  const expired = await allocate(
    page,
    scenario,
    Math.max(a.capturedAt, b.capturedAt) + 30 * 60 * 1000,
  );
  expect(expired.anonymousId).toBe(a.anonymousId);
  expect(expired.sessionId).not.toBe(a.sessionId);
  expect(expired.sequence).toBe(0);
  await second.evaluate(async (scenario) => {
    const store = await window.openIdentityStore({
      projectKey: `identity-${scenario}`,
      ingestionUrl: `${location.origin}/ingest/${scenario}`,
    });
    try {
      await store.reset();
    } finally {
      store.close();
    }
  }, scenario);
  const reset = await allocate(page, scenario);
  expect(reset.anonymousId).not.toBe(a.anonymousId);
  expect(reset.sessionId).not.toBe(expired.sessionId);
  expect(reset.sequence).toBe(0);
  await page.close();
  const reopened = await context.newPage();
  await open(reopened, scenario);
  expect(await allocate(reopened, scenario)).toMatchObject({
    anonymousId: reset.anonymousId,
    sessionId: reset.sessionId,
    sequence: 1,
  });
  expect((await allocate(second, `${scenario}-other`)).anonymousId).not.toBe(reset.anonymousId);
});

test('public page-context helper strips private URL fields and extracts campaign in Chromium', async ({
  page,
  scenario,
}) => {
  await open(page, scenario);
  expect(
    await page.evaluate(() =>
      window.capturePageContext(
        'https://name:secret@example.com/products?email=private%40example.com&utm_source=email&utm_campaign=launch#reset-token',
      ),
    ),
  ).toEqual({
    url: 'https://example.com/products',
    campaign: { utm_source: 'email', utm_campaign: 'launch' },
  });
  expect(
    await page.evaluate(() =>
      window.capturePageContext('https://example.com/?utm_source=a&utm_source=b&utm_content=%FF'),
    ),
  ).toEqual({ url: 'https://example.com/', campaign: {} });
});
