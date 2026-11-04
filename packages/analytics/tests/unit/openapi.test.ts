import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { validate } from '@readme/openapi-parser';

it('validates the reference query API against OpenAPI without external resolution', async () => {
  const text = await readFile(
    new URL('../../../../docs/api/analytics.openapi.json', import.meta.url),
    'utf8',
  );
  const document = JSON.parse(text) as Parameters<typeof validate>[0];
  function localReferences(value: unknown): void {
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      if (key === '$ref') expect(item).toMatch(/^#\//);
      else localReferences(item);
    }
  }
  localReferences(document);
  const result = await validate(document, {
    resolve: { external: false, file: false },
    timeoutMs: 2000,
  });
  expect(result.valid, result.valid ? undefined : JSON.stringify(result.errors)).toBe(true);
});
