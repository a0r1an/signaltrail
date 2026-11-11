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
  // Links come from the dedicated table, limited to visitors active in the window.
  expect(sql).toContain('FROM signaltrail.analytics_identity_links FINAL');
  expect(sql).toContain('anonymous_id IN (');
  expect(sql).not.toContain("IN ('identified', 'link')");
  // One distinct target <=> min = max; avoids a per-visitor exact-set state.
  expect(sql).toContain('min(user_id) AS linked_user, max(user_id) AS other_user');
  expect(sql).toContain("l.linked_user != '' AND l.linked_user = l.other_user");
  expect(sql).not.toContain('uniqExact(user_id)');
  expect(sql).toContain("'user', 'anonymous'");
  expect(sql.match(/project_id = unhex\(\{project_hex:String\}\)/g)).toHaveLength(3);
  expect(sql).toContain("event_name != '$identify'");
  expect(target.searchParams.get('max_memory_usage')).toBe('67108864');
});
it('validates the identity-link table identifier', () => {
  expect(() =>
    createAnalyticsReader({
      endpoint: 'http://clickhouse:8123',
      username: 'reader',
      password: 'fixture',
      linksTable: 'links; DROP',
    }),
  ).toThrow('Invalid analytics identifier');
});
