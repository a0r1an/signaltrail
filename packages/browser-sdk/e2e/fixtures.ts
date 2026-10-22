import { randomUUID } from 'node:crypto';
import { test as base, expect, type Page, type APIRequestContext } from '@playwright/test';
import type { AutomaticDelivery, EnqueueResult } from '../src/index.ts';
import type { Scenario } from './server.ts';

declare global {
  interface Window {
    harness: {
      delivery: AutomaticDelivery;
      capture(options?: {
        immediate?: boolean;
        oversized?: boolean;
      }): Promise<EnqueueResult & { eventId: string }>;
      lastId: string;
      scenario: string;
    };
  }
}
export const test = base.extend<{ scenario: string; browserErrors: void }>({
  browserErrors: [
    async ({ context }, use) => {
      const errors: string[] = [];
      const watch = (page: Page) => page.on('pageerror', (error) => errors.push(error.message));
      context.pages().forEach(watch);
      context.on('page', watch);
      await use();
      context.off('page', watch);
      expect(errors, 'Unexpected browser JavaScript errors').toEqual([]);
    },
    { auto: true },
  ],
  scenario: async ({ request }, use) => {
    const id = randomUUID();
    await use(id);
    await request.delete(`/control/${id}`);
  },
});
export { expect };
export async function open(page: Page, scenario: string, interval = 2000) {
  await page.goto(`/?scenario=${scenario}&interval=${interval}`);
  await expect(page.getByRole('button', { name: 'Capture event', exact: true })).toBeEnabled();
}
export async function state(request: APIRequestContext, scenario: string): Promise<Scenario> {
  const response = await request.get(`/control/${scenario}`);
  expect(response.ok()).toBe(true);
  return response.json() as Promise<Scenario>;
}
export async function configure(
  request: APIRequestContext,
  scenario: string,
  update: Partial<Pick<Scenario, 'status' | 'delayMs' | 'maxBytes' | 'retryAfter'>>,
) {
  const response = await request.post(`/control/${scenario}`, { data: update });
  expect(response.ok()).toBe(true);
}
