// Production host stack on local Docker: build, secrets, migrate, ingest, restart,
// revoke, restricted identities, teardown. Isolated compose project and temporary
// directories under test-results/host; never touches the development stack.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const files = ['-f', 'infra/host/compose.production.yaml', '-f', 'tests/host/compose.local.yaml'];
const runId = new Date().toISOString().replaceAll(':', '-');
const directory = resolve(root, 'test-results/host', runId);
const release = 'smoke-' + randomBytes(4).toString('hex');
const env = {
  ...process.env,
  SIGNALTRAIL_ETC: resolve(directory, 'etc'),
  SIGNALTRAIL_DATA: resolve(directory, 'data'),
  SIGNALTRAIL_RELEASE: release,
  SIGNALTRAIL_INGESTION_PUBLISH: '127.0.0.1:34190',
  SIGNALTRAIL_CLICKHOUSE_PUBLISH: '127.0.0.1:38290',
  SIGNALTRAIL_COMPOSE_OVERLAY: resolve(root, 'tests/host/compose.local.yaml'),
};
const run = (command, args, input) => {
  const result = spawnSync(command, args, { cwd: root, env, input, encoding: 'utf8' });
  if (result.status !== 0)
    throw new Error(
      `${command} ${args.slice(0, 6).join(' ')} failed:\n${result.stderr.slice(-3000)}`,
    );
  return result.stdout;
};
const compose = (...args) => run('docker', ['compose', ...files, ...args]);
const psql = (sql) =>
  compose(
    'exec',
    '-T',
    'postgres',
    'psql',
    '-qAt',
    '-v',
    'ON_ERROR_STOP=1',
    '-U',
    'signaltrail',
    '-d',
    'signaltrail',
    '-c',
    sql,
  );
const clickhouse = (user, password, sql) => {
  const result = spawnSync(
    'docker',
    [
      'compose',
      ...files,
      'exec',
      '-T',
      'clickhouse',
      'clickhouse-client',
      '--user',
      user,
      '--password',
      password,
      '--query',
      sql,
    ],
    { cwd: root, env, encoding: 'utf8' },
  );
  return { ok: result.status === 0, out: result.stdout.trim(), err: result.stderr };
};
const envValue = (file, name) =>
  run('sed', ['-n', `s/^${name}=//p`, resolve(env.SIGNALTRAIL_ETC, file)]).trim();

const evidence = { runId, release, steps: {} };
const started = performance.now();
try {
  await mkdir(env.SIGNALTRAIL_DATA, { recursive: true });
  for (const app of ['ingestion', 'event-processor'])
    run('docker', [
      'build',
      '-q',
      '-f',
      'infra/host/Dockerfile',
      '--build-arg',
      `APP=${app}`,
      '-t',
      `signaltrail-${app}:${release}`,
      '.',
    ]);
  run('sh', ['infra/host/secrets.sh']);
  run('sh', ['infra/host/secrets.sh']); // Idempotent: keeps the same secrets.
  const migrateStarted = performance.now();
  run('sh', ['infra/host/migrate.sh']);
  run('sh', ['infra/host/migrate.sh']); // Idempotent: migrations and identities reapply.
  evidence.steps.migrateTwiceSeconds = (performance.now() - migrateStarted) / 1000;

  // Owner, project and ingestion key, as the bootstrap operation would create them.
  const key = 'st_pub_' + randomBytes(32).toString('base64url');
  const hash = createHash('sha256').update(key).digest('hex');
  const [principal, organization, project, keyId] = [1, 2, 3, 4].map(() => randomUUID());
  psql(`INSERT INTO signaltrail_control.principals(id,issuer,subject) VALUES ('${principal}','https://smoke.invalid','owner');
    INSERT INTO signaltrail_control.organizations(id,name) VALUES ('${organization}','Smoke');
    INSERT INTO signaltrail_control.projects(id,organization_id,name) VALUES ('${project}','${organization}','Smoke');
    INSERT INTO signaltrail_control.organization_memberships(organization_id,principal_id,role) VALUES ('${organization}','${principal}','owner');
    INSERT INTO signaltrail_control.ingestion_keys(id,project_id,name,key_hash) VALUES ('${keyId}','${project}','Smoke',decode('${hash}','hex'))`);

  const send = async (eventId) => {
    const response = await fetch('http://127.0.0.1:34190/v1/events', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        events: [
          {
            schemaVersion: 1,
            eventId,
            eventName: 'smoke',
            distinctId: 'visitor',
            sessionId: 'session',
            sequence: 0,
            clientTimestamp: new Date().toISOString(),
            url: 'https://smoke.invalid/',
            properties: {},
            context: { sdkVersion: 'host-smoke' },
          },
        ],
      }),
      signal: AbortSignal.timeout(10000),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  const reader = [
    envValue('dashboard.env', 'SIGNALTRAIL_CLICKHOUSE_READER'),
    envValue('dashboard.env', 'SIGNALTRAIL_CLICKHOUSE_READER_PASSWORD'),
  ];
  const stored = async (eventId) => {
    for (let attempt = 0; attempt < 60; attempt++) {
      const result = clickhouse(
        ...reader,
        `SELECT count() FROM signaltrail.analytics_events FINAL WHERE project_id = '${project}' AND event_id = '${eventId}'`,
      );
      assert.ok(result.ok, result.err);
      if (result.out === '1') return true;
      await delay(500);
    }
    return false;
  };

  const first = randomUUID();
  const accepted = await send(first);
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.results[0].status, 'accepted');
  assert.ok(await stored(first), 'Accepted event not stored');
  evidence.steps.ingestToStorage = true;

  // Reboot equivalent: stop everything, start again with restart policies and data intact.
  compose('stop');
  compose('up', '-d', '--wait');
  assert.ok(await stored(first), 'Event lost across restart');
  const second = randomUUID();
  assert.equal((await send(second)).body.results[0].status, 'accepted');
  assert.ok(await stored(second), 'Event after restart not stored');
  evidence.steps.restartKeepsDataAndService = true;

  // Revocation reaches ingestion's cache via NOTIFY over the TLS connection.
  psql(`UPDATE signaltrail_control.ingestion_keys SET revoked_at = now() WHERE id = '${keyId}'`);
  let revoked = false;
  for (let attempt = 0; attempt < 20 && !revoked; attempt++) {
    revoked = (await send(randomUUID())).status === 401;
    if (!revoked) await delay(100);
  }
  assert.ok(revoked, 'Revoked key still accepted');
  evidence.steps.revocationApplied = true;

  // Restricted identities.
  const processor = [
    'signaltrail_processor',
    envValue('processor.env', 'SIGNALTRAIL_CLICKHOUSE_PASSWORD'),
  ];
  assert.equal(
    clickhouse(...processor, 'SELECT count() FROM signaltrail.analytics_events').ok,
    false,
  );
  assert.equal(
    clickhouse(...reader, "INSERT INTO signaltrail.analytics_events (project_id) VALUES ('x')").ok,
    false,
  );
  const tls = psql(
    `SELECT count(*) FILTER (WHERE ssl) || '/' || count(*) FROM pg_stat_ssl s JOIN pg_stat_activity a USING (pid) WHERE a.usename = 'signaltrail_ingestion'`,
  ).trim();
  assert.match(tls, /^([1-9]\d*)\/\1$/, `ingestion connections not all TLS: ${tls}`);
  assert.equal(
    psql("SELECT rolconfig::text FROM pg_roles WHERE rolname = 'signaltrail_ingestion'").trim(),
    '{default_transaction_read_only=on}',
  );
  evidence.steps.restrictedIdentities = true;
  evidence.ingestionTlsConnections = tls;
  evidence.passed = true;
} catch (error) {
  evidence.passed = false;
  evidence.error = error.message;
  evidence.logs = spawnSync('docker', ['compose', ...files, 'logs', '--no-color', '--tail', '40'], {
    cwd: root,
    env,
    encoding: 'utf8',
  }).stdout.slice(-8000);
} finally {
  evidence.seconds = (performance.now() - started) / 1000;
  spawnSync('docker', ['compose', ...files, 'down', '--volumes', '--remove-orphans'], {
    cwd: root,
    env,
    stdio: 'ignore',
  });
  for (const app of ['ingestion', 'event-processor'])
    spawnSync('docker', ['image', 'rm', `signaltrail-${app}:${release}`], { stdio: 'ignore' });
  // Keep the evidence; remove generated secrets and data.
  await rm(resolve(directory, 'etc'), { recursive: true, force: true });
  await rm(resolve(directory, 'data'), { recursive: true, force: true });
  await writeFile(resolve(directory, 'smoke.json'), JSON.stringify(evidence, null, 2));
  execFileSync('true');
}
console.log(JSON.stringify(evidence, null, 2));
if (!evidence.passed) process.exit(1);
