import { expect, it } from 'vitest';
import { createDevelopmentProjectResolver } from '../../src/index.ts';
it('maps development ingestion keys to trusted project IDs using a configuration snapshot', () => {
  const definitions = [
    { key: 'key-one', projectId: 'project-one' },
    { key: 'key-two', projectId: 'project-two' },
  ];
  const resolve = createDevelopmentProjectResolver(definitions);
  definitions[0]!.projectId = 'changed';
  expect(resolve('key-one')).toBe('project-one');
  expect(resolve('key-two')).toBe('project-two');
  expect(resolve('unknown')).toBeUndefined();
});
it.each([
  null,
  {},
  [{ key: '', projectId: 'project' }],
  [{ key: 'has space', projectId: 'project' }],
  [{ key: 'key', projectId: '' }],
  [
    { key: 'key', projectId: 'one' },
    { key: 'key', projectId: 'two' },
  ],
])('rejects invalid or ambiguous development identities: %s', (definitions) => {
  expect(() => createDevelopmentProjectResolver(definitions)).toThrow(TypeError);
});
