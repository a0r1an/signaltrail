import { expect, it, vi } from 'vitest';
import { createAnalyticsReader } from '../../src/index.ts';
const window = { projectId: 'trusted', from: '2026-10-01T00:00:00Z', to: '2026-10-02T00:00:00Z' };
it('resolves only unambiguous project-scoped links and keeps the user and anonymous namespaces distinct', async () => {
  const send = vi.fn<typeof fetch>(async () => new Response('{"count":"9007199254740993"}'));
  const reader = createAnalyticsReader({
    endpoint: 'http://clickhouse:8123',
    username: 'reader',
    password: 'fixture',
    fetch: send,
  });
  expect(await reader.countReceivedVisitors(window)).toEqual({ count: '9007199254740993' });
  const target = new URL(String(send.mock.calls[0]![0]));
  const sql = target.searchParams.get('query')!;
  expect(sql).toContain('uniqExact(user_id)');
  expect(sql).toContain('coalesce(l.target_count, 0) = 1');
  expect(sql).toContain("'user', 'anonymous'");
  expect(sql.match(/project_id = unhex\(\{project_hex:String\}\)/g)).toHaveLength(2);
  expect(sql).toContain("event_name != '$identify'");
  expect(target.searchParams.get('max_memory_usage')).toBe('67108864');
});
