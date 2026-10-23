import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
const paths: string[] = [];
afterEach(() => {
  for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});
const topic = 'signaltrail.analytics.v1';
const description = `SUMMARY\nNAME ${topic}\nPARTITIONS 3\nREPLICAS 1\nCONFIGS\nKEY VALUE SOURCE\ncleanup.policy delete DYNAMIC_TOPIC_CONFIG\nretention.ms 604800000 DYNAMIC_TOPIC_CONFIG\nretention.bytes -1 DYNAMIC_TOPIC_CONFIG\nwrite.caching false DYNAMIC_TOPIC_CONFIG\n`;
function run(text = description, exists = true) {
  const dir = mkdtempSync(join(tmpdir(), 'signaltrail-topic-init-'));
  paths.push(dir);
  writeFileSync(join(dir, 'description'), text);
  writeFileSync(join(dir, 'calls'), '');
  writeFileSync(
    join(dir, 'rpk'),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> "$TEST_CALLS"\ncase "$1 $2" in\n  'topic list') printf '%s\\n' "$TEST_TOPICS" ;;\n  'topic create') exit 0 ;;\n  'topic describe') cat "$TEST_DESCRIPTION" ;;\n  *) exit 9 ;;\nesac\n`,
    { mode: 0o755 },
  );
  const result = spawnSync(
    '/bin/sh',
    [new URL('../../../../infra/redpanda/init-topics.sh', import.meta.url).pathname],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        REDPANDA_BROKERS: 'test-broker:9092',
        SIGNALTRAIL_REDPANDA_TOPIC: topic,
        SIGNALTRAIL_TOPIC_PARTITIONS: '3',
        SIGNALTRAIL_TOPIC_REPLICAS: '1',
        SIGNALTRAIL_TOPIC_RETENTION_MS: '604800000',
        SIGNALTRAIL_TOPIC_RETENTION_BYTES: '-1',
        PATH: `${dir}:${process.env.PATH}`,
        TEST_CALLS: join(dir, 'calls'),
        TEST_TOPICS: exists ? `NAME PARTITIONS REPLICAS\n${topic} 3 1` : 'NAME PARTITIONS REPLICAS',
        TEST_DESCRIPTION: join(dir, 'description'),
      },
    },
  );
  return { ...result, calls: readFileSync(join(dir, 'calls'), 'utf8') };
}
it('fails on existing topic drift without altering or deleting the topic', () => {
  const result = run(description.replace('retention.ms 604800000', 'retention.ms 1000'));
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('retention.ms');
  expect(result.calls).not.toMatch(/topic (create|alter|delete)/);
});
it('creates an absent topic with explicit durability and retention settings, then verifies it', () => {
  const result = run(description, false);
  expect(result.status).toBe(0);
  expect(result.calls).toContain('topic create signaltrail.analytics.v1');
  expect(result.calls).toContain('write.caching=false');
  expect(result.calls).toContain('retention.ms=604800000');
  expect(result.calls).not.toMatch(/topic (alter|delete)/);
});
it('verifies a matching existing topic without issuing mutations', () => {
  const result = run();
  expect(result.status).toBe(0);
  expect(result.stdout).toContain(`Verified topic ${topic}`);
  expect(result.calls).not.toMatch(/topic (create|alter|delete)/);
});
it.each([
  ['PARTITIONS 3', 'PARTITIONS 4'],
  ['REPLICAS 1', 'REPLICAS 3'],
  ['cleanup.policy delete', 'cleanup.policy compact'],
  ['retention.bytes -1', 'retention.bytes 1000'],
  ['write.caching false', 'write.caching true'],
])('refuses topic setting drift: %s', (original, changed) => {
  const result = run(description.replace(original, changed));
  expect(result.status).toBe(1);
  expect(result.calls).not.toMatch(/topic (create|alter|delete)/);
});
it('ignores section headings when verifying rpk summary fields', () => {
  const result = run(
    description + '\nPARTITIONS\n==========\nPARTITION LEADER EPOCH REPLICAS\n0 0 1 [0]\n',
  );
  expect(result.status).toBe(0);
});
