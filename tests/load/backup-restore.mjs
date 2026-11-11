import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createAnalyticsReader } from '../../packages/analytics/dist/index.js';
import {
  createControlPlaneMigrationStatement,
  createIngestionKey,
  createInitialProjectStatement,
} from '../../packages/project-access/dist/index.js';
import { createClickHouseBatchWriter } from '../../workers/event-processor/dist/index.js';
import { assessBackupDrill } from './backup-drill.mjs';
import {
  ANALYTICS_RETENTION,
  ANALYTICS_SCHEMA,
  applyClickHouseSchema,
} from './clickhouse-schema.mjs';

const { Client } = createRequire(
  new URL('../../packages/project-access/package.json', import.meta.url),
)('pg');
const admin = { username: 'signaltrail', password: 'signaltrail_local' };
const primary = { endpoint: 'http://127.0.0.1:38123', ...admin };
const replacement = { endpoint: 'http://127.0.0.1:38125', ...admin };
const BULK_ROWS = 200000;

function clickhouse(connection) {
  return async (sql, user = connection) => {
    const response = await fetch(`${connection.endpoint}/?wait_end_of_query=1`, {
      method: 'POST',
      headers: { 'X-ClickHouse-User': user.username, 'X-ClickHouse-Key': user.password },
      body: sql,
      signal: AbortSignal.timeout(120000),
    });
    const body = await response.text();
    assert.equal(response.status, 200, body.slice(0, 500));
    return body;
  };
}
const rows = (body) =>
  body
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));

async function analyticsState(query) {
  const fingerprint = (table) =>
    query(
      `SELECT project_id AS project, toString(count()) AS rows, toString(sum(cityHash64(*))) AS hash FROM signaltrail.${table} FINAL GROUP BY project_id ORDER BY project_id FORMAT JSONEachRow`,
    ).then(rows);
  const definition = async (name) =>
    (await query(`SHOW CREATE TABLE signaltrail.${name} FORMAT TSVRaw`)).trim();
  return {
    events: await fingerprint('analytics_events'),
    links: await fingerprint('analytics_identity_links'),
    eventsTable: await definition('analytics_events'),
    linksTable: await definition('analytics_identity_links'),
    linksView: await definition('analytics_identity_links_mv'),
  };
}

async function metadataState(client) {
  const tables = (
    await client.query(
      `SELECT table_schema || '.' || table_name AS name FROM information_schema.tables WHERE table_schema IN ('signaltrail_control','signaltrail_migrations') AND table_type = 'BASE TABLE' ORDER BY 1`,
    )
  ).rows.map((row) => row.name);
  const state = {};
  for (const name of tables) {
    const {
      rows: [row],
    } = await client.query(
      `SELECT count(*)::int AS rows, md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) AS md5 FROM ${name} t`,
    );
    state[name] = row;
  }
  state.readerPrivilege = (
    await client.query(
      `SELECT has_table_privilege('backup_drill_reader', 'signaltrail_control.projects', 'SELECT') AS granted`,
    )
  ).rows[0].granted;
  return state;
}

const linkEvent = (projectId, eventId, anonymousId, userId, receivedAt) => ({
  projectId,
  receivedAt,
  event: {
    schemaVersion: 1,
    eventId,
    eventName: '$identify',
    distinctId: userId,
    sessionId: 'backup-session',
    sequence: 0,
    clientTimestamp: receivedAt,
    url: 'https://probe.invalid/',
    properties: {},
    context: { sdkVersion: 'backup-probe', identity: { kind: 'link', anonymousId, userId } },
  },
});
const viewEvent = (projectId, eventId, distinctId, receivedAt) => ({
  projectId,
  receivedAt,
  event: {
    schemaVersion: 1,
    eventId,
    eventName: 'viewed',
    distinctId,
    sessionId: 'backup-session',
    sequence: 1,
    clientTimestamp: receivedAt,
    url: 'https://probe.invalid/',
    properties: { product: 'p-1' },
    context: { sdkVersion: 'backup-probe' },
  },
});
const bulkInsert = (projectId, count) => `INSERT INTO signaltrail.analytics_events
  SELECT '${projectId}',
    concat(substring(h, 1, 8), '-', substring(h, 9, 4), '-7', substring(r, 1, 3), '-8', substring(r, 4, 3), '-', substring(r, 7, 12)),
    t, concat(replaceOne(toString(t), ' ', 'T'), 'Z'), 'viewed',
    concat('visitor-', toString(number % 5000)), concat('session-', toString(number % 20000)),
    number, 'https://probe.invalid/', '{}',
    if(number % 50 = 0, concat('{"identity":{"kind":"link","anonymousId":"anon-', toString(number % 5000), '","userId":"visitor-', toString(number % 5000), '"}}'), '{}')
  FROM (
    SELECT number, now64(3) - toIntervalSecond(number * 10) AS t,
      leftPad(lower(hex(toUnixTimestamp64Milli(t))), 12, '0') AS h,
      leftPad(lower(hex(sipHash64('${projectId}', number))), 18, '0') AS r
    FROM numbers(${count})
  )`;

/** Uses only the owned backup-restore fixture's disposable primary and replacement containers. */
export async function exerciseBackupRestore({ docker, runId, directory }) {
  const now = () => new Date().toISOString();
  const tag = runId.replace(/[^a-zA-Z0-9]/g, '').slice(-16) + randomBytes(3).toString('hex');
  const full = `File('/backups/${tag}-full')`;
  const incremental = `File('/backups/${tag}-incremental')`;
  const timings = {};
  const timed = async (name, run) => {
    const started = performance.now();
    const value = await run();
    timings[name] = (performance.now() - started) / 1000;
    return value;
  };

  // Primary analytics: full schema, bulk history and pipeline-written identity links.
  const source = clickhouse(primary);
  await applyClickHouseSchema(source, [...ANALYTICS_SCHEMA, ...ANALYTICS_RETENTION]);
  await source(bulkInsert('backup-bulk', BULK_ROWS));
  const write = createClickHouseBatchWriter(primary);
  const firstBatch = [
    linkEvent('backup', 'link-1', 'anon-1', 'user-1', now()),
    viewEvent('backup', 'view-1', 'anon-1', now()),
  ];
  await write(firstBatch);
  await write(firstBatch); // Replay before backup: restore must keep it one logical row.

  // Primary metadata: tracked migrations, a bootstrapped owner/project/key, a scoped role.
  const metadata = new Client({
    connectionString: 'postgres://signaltrail:signaltrail_local@127.0.0.1:35433/signaltrail',
  });
  await metadata.connect();
  try {
    await metadata.query(
      createControlPlaneMigrationStatement([
        {
          version: 1,
          source: await readFile(
            new URL('../../infra/postgres/001-project-access.sql', import.meta.url),
            'utf8',
          ),
        },
        {
          version: 2,
          source: await readFile(
            new URL('../../infra/postgres/002-ingestion-keys.sql', import.meta.url),
            'utf8',
          ),
        },
      ]),
    );
    const id = (n) => '00000000-0000-0000-0000-' + String(n).padStart(12, '0');
    await metadata.query(
      createInitialProjectStatement({
        principalId: id(1),
        issuer: 'https://backup.fixture.invalid',
        subject: 'backup-owner',
        organizationId: id(2),
        organizationName: 'Backup drill',
        projectId: id(3),
        projectName: 'Backup drill project',
        keyId: id(4),
        keyName: 'Backup drill key',
        publicKey: createIngestionKey(),
      }),
    );
    // Roles are cluster-wide: provisioning recreates them on a replacement host; pg_dump keeps grants.
    await metadata.query('CREATE ROLE backup_drill_reader NOLOGIN');
    await metadata.query('GRANT USAGE ON SCHEMA signaltrail_control TO backup_drill_reader');
    await metadata.query('GRANT SELECT ON signaltrail_control.projects TO backup_drill_reader');

    // Full backup, then an hour's worth of changes, then the incremental (latest restore point).
    await timed('clickhouseFullBackupSeconds', () =>
      source(`BACKUP DATABASE signaltrail TO ${full}`),
    );
    await source(bulkInsert('backup-incremental', BULK_ROWS / 4));
    const secondBatch = [
      linkEvent('backup', 'link-2', 'anon-2', 'user-1', now()),
      viewEvent('backup', 'view-2', 'anon-2', now()),
    ];
    await write(secondBatch);
    await timed('clickhouseIncrementalBackupSeconds', () =>
      source(`BACKUP DATABASE signaltrail TO ${incremental} SETTINGS base_backup = ${full}`),
    );
    await timed('postgresDumpSeconds', () =>
      docker([
        'exec',
        '-T',
        'postgres',
        'pg_dump',
        '-U',
        'signaltrail',
        '-d',
        'signaltrail',
        '-Fc',
        '-f',
        '/tmp/signaltrail.dump',
      ]),
    );
    const expected = {
      ...(await analyticsState(source)),
      metadata: await metadataState(metadata),
    };
    // RPO window: writes after the last backup are lost on restore, completely.
    await write([viewEvent('backup-after', 'after-1', 'anon-3', now())]);
    await metadata.query(
      `INSERT INTO signaltrail_control.organizations(id,name) VALUES ('00000000-0000-0000-0000-000000000099','After backup')`,
    );
    const sizes = Object.fromEntries(
      (
        await docker(
          [
            'exec',
            '-T',
            'clickhouse',
            'du',
            '-sb',
            `/backups/${tag}-full`,
            `/backups/${tag}-incremental`,
          ],
          true,
        )
      )
        .trim()
        .split('\n')
        .map((line) => line.split('\t'))
        .map(([bytes, path]) => [
          path.endsWith('-full') ? 'fullBytes' : 'incrementalBytes',
          Number(bytes),
        ]),
    );

    // Replacement host: start empty services, provision identities, restore, verify.
    const restoreStarted = performance.now();
    await docker([
      'up',
      '-d',
      '--wait',
      '--wait-timeout',
      '120',
      'clickhouse-restore',
      'postgres-restore',
    ]);
    const target = clickhouse(replacement);
    // The image creates an empty database from CLICKHOUSE_DB; RESTORE recreates it.
    assert.equal(
      (await target("SELECT count() FROM system.tables WHERE database = 'signaltrail'")).trim(),
      '0',
    );
    await target('DROP DATABASE IF EXISTS signaltrail');
    await timed('clickhouseRestoreSeconds', () =>
      target(`RESTORE DATABASE signaltrail FROM ${incremental}`),
    );
    const restoredMetadata = new Client({
      connectionString: 'postgres://signaltrail:signaltrail_local@127.0.0.1:35434/signaltrail',
    });
    await restoredMetadata.connect();
    try {
      // Provisioning recreates cluster-wide roles before the dump's grants are restored.
      await restoredMetadata.query('CREATE ROLE backup_drill_reader NOLOGIN');
      await timed('postgresRestoreSeconds', async () => {
        await docker(['cp', 'postgres:/tmp/signaltrail.dump', `${directory}/signaltrail.dump`]);
        await docker([
          'cp',
          `${directory}/signaltrail.dump`,
          'postgres-restore:/tmp/signaltrail.dump',
        ]);
        await docker([
          'exec',
          '-T',
          'postgres-restore',
          'pg_restore',
          '-U',
          'signaltrail',
          '-d',
          'signaltrail',
          '--exit-on-error',
          '/tmp/signaltrail.dump',
        ]);
      });
      const restoreSeconds = (performance.now() - restoreStarted) / 1000;
      const restored = {
        ...(await analyticsState(target)),
        metadata: await metadataState(restoredMetadata),
      };
      const afterBackupRestored =
        Number(
          (
            await target(
              "SELECT count() FROM signaltrail.analytics_events WHERE project_id = 'backup-after'",
            )
          ).trim(),
        ) +
        (
          await restoredMetadata.query(
            `SELECT count(*)::int AS n FROM signaltrail_control.organizations WHERE name = 'After backup'`,
          )
        ).rows[0].n;
      const reasons = assessBackupDrill({
        expected,
        restored,
        afterBackupRestored,
        restoreSeconds,
      });

      // The restored host must keep working: insert-only processor feeds links; reader counts.
      const suffix = randomBytes(4).toString('hex');
      const processor = {
        username: `drill_processor_${suffix}`,
        password: randomBytes(16).toString('hex'),
      };
      const reader = {
        username: `drill_reader_${suffix}`,
        password: randomBytes(16).toString('hex'),
      };
      await target(
        `CREATE USER ${processor.username} IDENTIFIED WITH sha256_password BY '${processor.password}'`,
      );
      await target(`GRANT INSERT ON signaltrail.analytics_events TO ${processor.username}`);
      await target(
        `CREATE USER ${reader.username} IDENTIFIED WITH sha256_password BY '${reader.password}'`,
      );
      await target(
        `GRANT SELECT ON signaltrail.analytics_events, SELECT ON signaltrail.analytics_identity_links TO ${reader.username}`,
      );
      await createClickHouseBatchWriter({ ...replacement, ...processor })([
        linkEvent('backup', 'link-3', 'anon-3', 'user-1', now()),
        viewEvent('backup', 'view-3', 'anon-3', now()),
      ]);
      const hour = Date.now();
      const visitors = await createAnalyticsReader({
        ...replacement,
        ...reader,
      }).countReceivedVisitors({
        projectId: 'backup',
        from: new Date(hour - 3600000).toISOString(),
        to: new Date(hour + 60000).toISOString(),
      });
      // anon-1/2/3 all link to user-1 through restored and newly captured links.
      if (visitors.count !== '1')
        reasons.push(`Restored visitor resolution returned ${visitors.count}`);
      return {
        passed: reasons.length === 0,
        reasons,
        timings: { ...timings, restoreSeconds },
        sizes,
        restoredRows: Object.fromEntries(restored.events.map((row) => [row.project, row.rows])),
        restoredLinks: Object.fromEntries(restored.links.map((row) => [row.project, row.rows])),
        metadataTables: Object.keys(restored.metadata).length - 1,
        restoredHostAcceptsWrites: true,
        visitorsAfterRestore: visitors.count,
      };
    } finally {
      await restoredMetadata.end();
    }
  } finally {
    await metadata.end();
  }
}
