import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

export async function exerciseStorageReadiness({ docker }) {
  const signal = AbortSignal.timeout(90000);
  let active = false;
  try {
    while (!signal.aborted) {
      const output = await docker(
        [
          'exec',
          '-T',
          'clickhouse',
          'sh',
          '-c',
          'if test -f /tmp/signaltrail-init-active; then printf active; fi',
        ],
        true,
        true,
        signal,
      );
      if (output === 'active') {
        active = true;
        break;
      }
      await delay(250, undefined, { signal });
    }
    assert.equal(active, true, 'Temporary bootstrap server must reach the controlled gate');
    await docker(
      ['exec', '-T', 'clickhouse', 'test', '-f', '/healthcheck.sh'],
      true,
      false,
      signal,
    );
    const state = await docker(
      [
        'exec',
        '-T',
        'clickhouse',
        'sh',
        '-c',
        'if /bin/sh /healthcheck.sh >/dev/null 2>&1; then printf premature; else printf waiting; fi',
      ],
      true,
      false,
      signal,
    );
    assert.equal(state, 'waiting', 'Healthcheck must reject the loopback-only bootstrap server');
  } finally {
    await docker(
      ['exec', '-T', 'clickhouse', 'touch', '/tmp/signaltrail-init-release'],
      true,
      true,
      AbortSignal.timeout(5000),
    );
  }
  await docker(['up', '-d', '--wait', '--wait-timeout', '120', 'redpanda', 'clickhouse']);
  const response = await fetch('http://127.0.0.1:38123/?query=SELECT%201', {
    headers: { 'X-ClickHouse-User': 'signaltrail', 'X-ClickHouse-Key': 'signaltrail_local' },
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.text()).trim(), '1');
  return { passed: true, bootstrapRejected: true, finalServerReachable: true };
}
