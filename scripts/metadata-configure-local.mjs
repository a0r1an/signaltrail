import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createIngestionKey,
  createInitialProjectStatement,
  hashIngestionKey,
  createProjectListReader,
  createPostgresMembershipDatabase,
} from '../packages/project-access/dist/index.js';
import { createAnalyticsReader } from '../packages/analytics/dist/index.js';
import { getAuthConfig } from '../apps/dashboard/src/features/auth/config.ts';
import { patchDashboardServices } from './local-dashboard-env.mjs';
const { Client } = createRequire(
  new URL('../packages/project-access/package.json', import.meta.url),
)('pg');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const envPath = join(root, 'apps/dashboard/.env.local');
let client, reader;
try {
  if (process.argv.length !== 2) throw new Error();
  process.loadEnvFile(envPath);
  const auth = getAuthConfig(process.env);
  if (
    !auth ||
    auth.appOrigin !== 'http://localhost:3000' ||
    !process.env.CLERK_SECRET_KEY?.startsWith('sk_test_')
  )
    throw new Error();
  const directory = join(root, '.local-data');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const statePath = join(directory, 'dashboard-local-setup.json');
  let state;
  try {
    state = JSON.parse(await readFile(statePath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    state = {
      version: 1,
      issuer: auth.issuer,
      subject: auth.ownerUserId,
      principalId: randomUUID(),
      organizationId: randomUUID(),
      projectId: randomUUID(),
      keyId: randomUUID(),
      organizationName: 'Personal',
      projectName: 'SignalTrail',
      keyName: 'Local browser',
      publicKey: createIngestionKey(),
      readerName: 'st_dashboard_' + randomBytes(6).toString('hex'),
      pgPassword: randomBytes(32).toString('hex'),
      chPassword: randomBytes(32).toString('hex'),
    };
    await writeFile(statePath, JSON.stringify(state, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  }
  if (
    state.version !== 1 ||
    state.issuer !== auth.issuer ||
    state.subject !== auth.ownerUserId ||
    !/^st_dashboard_[a-f0-9]{12}$/.test(state.readerName) ||
    ![state.pgPassword, state.chPassword].every(
      (v) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v),
    )
  )
    throw new Error();
  const statement = createInitialProjectStatement(state);
  if (!state.ingestionPassword || !state.processorPassword) {
    state.ingestionPassword ??= randomBytes(32).toString('hex');
    state.processorPassword ??= randomBytes(32).toString('hex');
    const temporaryState = statePath + '.pending-' + randomUUID();
    await writeFile(temporaryState, JSON.stringify(state, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
    await rename(temporaryState, statePath);
  }
  if (
    ![state.ingestionPassword, state.processorPassword].every(
      (v) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v),
    )
  )
    throw new Error();
  const suffix = state.readerName.slice('st_dashboard_'.length);
  const ingestionName = 'st_ingestion_' + suffix;
  const processorName = 'st_processor_' + suffix;
  client = new Client({
    connectionString: 'postgres://signaltrail:signaltrail_local@127.0.0.1:5433/signaltrail',
    connectionTimeoutMillis: 5000,
    query_timeout: 12000,
    statement_timeout: 10000,
    lock_timeout: 5000,
  });
  await client.connect();
  await client.query('BEGIN');
  try {
    await client.query('SELECT pg_advisory_xact_lock(74268490801812922)');
    const existing = await client.query(
      `SELECT p.id FROM signaltrail_control.projects p
      JOIN signaltrail_control.organizations o ON o.id=p.organization_id
      JOIN signaltrail_control.organization_memberships m ON m.organization_id=o.id
      JOIN signaltrail_control.principals u ON u.id=m.principal_id
      JOIN signaltrail_control.ingestion_keys k ON k.project_id=p.id
      WHERE p.id=$1::uuid AND o.id=$2::uuid AND u.id=$3::uuid AND u.issuer=$4 AND u.subject=$5
      AND m.role='owner' AND k.id=$6::uuid AND k.key_hash=decode($7,'hex') AND k.revoked_at IS NULL`,
      [
        state.projectId,
        state.organizationId,
        state.principalId,
        state.issuer,
        state.subject,
        state.keyId,
        hashIngestionKey(state.publicKey),
      ],
    );
    if (!existing.rows.length) await client.query(statement);
    else if (existing.rows.length !== 1) throw new Error();
    const role = await client.query(
      'SELECT rolsuper,rolcreatedb,rolcreaterole,rolinherit FROM pg_roles WHERE rolname=$1',
      [state.readerName],
    );
    if (!role.rows.length)
      await client.query(
        `CREATE ROLE ${state.readerName} LOGIN NOINHERIT PASSWORD '${state.pgPassword}'`,
      );
    else if (Object.values(role.rows[0]).some(Boolean)) throw new Error();
    await client.query(`GRANT CONNECT ON DATABASE signaltrail TO ${state.readerName}`);
    await client.query(`GRANT USAGE ON SCHEMA signaltrail_control TO ${state.readerName}`);
    await client.query(
      `GRANT SELECT ON signaltrail_control.principals,signaltrail_control.organization_memberships,signaltrail_control.organizations,signaltrail_control.projects TO ${state.readerName}`,
    );
    await client.query(`ALTER ROLE ${state.readerName} SET default_transaction_read_only = on`);
    const ingestionRole = await client.query(
      'SELECT rolsuper,rolcreatedb,rolcreaterole,rolinherit FROM pg_roles WHERE rolname=$1',
      [ingestionName],
    );
    if (!ingestionRole.rows.length)
      await client.query(
        `CREATE ROLE ${ingestionName} LOGIN NOINHERIT PASSWORD '${state.ingestionPassword}'`,
      );
    else if (Object.values(ingestionRole.rows[0]).some(Boolean)) throw new Error();
    await client.query(`GRANT CONNECT ON DATABASE signaltrail TO ${ingestionName}`);
    await client.query(`GRANT USAGE ON SCHEMA signaltrail_control TO ${ingestionName}`);
    await client.query(
      `GRANT SELECT(project_id,key_hash,revoked_at) ON signaltrail_control.ingestion_keys TO ${ingestionName}`,
    );
    await client.query(`ALTER ROLE ${ingestionName} SET default_transaction_read_only = on`);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
  const schema = await readFile(join(root, 'infra/clickhouse/001-analytics-events.sql'), 'utf8');
  execFileSync(
    'docker',
    [
      'compose',
      'exec',
      '-T',
      'clickhouse',
      'clickhouse-client',
      '--user',
      'signaltrail',
      '--password',
      'signaltrail_local',
      '--multiquery',
    ],
    {
      cwd: root,
      timeout: 15000,
      stdio: ['pipe', 'pipe', 'pipe'],
      input: `${schema}\nCREATE USER IF NOT EXISTS ${state.readerName} IDENTIFIED WITH sha256_password BY '${state.chPassword}';\nGRANT SELECT ON signaltrail.analytics_events TO ${state.readerName};\nCREATE USER IF NOT EXISTS ${processorName} IDENTIFIED WITH sha256_password BY '${state.processorPassword}';\nGRANT INSERT ON signaltrail.analytics_events TO ${processorName};`,
    },
  );
  const connectionString = `postgres://${state.readerName}:${state.pgPassword}@127.0.0.1:5433/signaltrail`;
  reader = createPostgresMembershipDatabase({ connectionString, tls: false });
  const privileges = await reader.query({
    text: `SELECT has_table_privilege(current_user,'signaltrail_control.principals','INSERT') AS can_insert,
      has_table_privilege(current_user,'signaltrail_control.organization_memberships','UPDATE') AS can_change_membership,
      has_table_privilege(current_user,'signaltrail_control.ingestion_keys','SELECT') AS can_read_keys,
      (SELECT rolsuper OR rolcreatedb OR rolcreaterole FROM pg_roles WHERE rolname=current_user) AS privileged`,
    values: [],
    signal: AbortSignal.timeout(5000),
  });
  if (privileges.rows.length !== 1 || Object.values(privileges.rows[0]).some(Boolean))
    throw new Error();
  const page = await createProjectListReader(reader.query)(
    { issuer: state.issuer, subject: state.subject },
    {},
    AbortSignal.timeout(5000),
  );
  if (!page.projects.some((p) => p.id === state.projectId)) throw new Error();
  const analytics = createAnalyticsReader({
    endpoint: 'http://127.0.0.1:8123',
    username: state.readerName,
    password: state.chPassword,
  });
  await analytics.countOccurredEvents({
    projectId: state.projectId,
    from: new Date(Date.now() - 86400000).toISOString(),
    to: new Date().toISOString(),
  });
  const source = await readFile(envPath, 'utf8');
  const next = patchDashboardServices(source, {
    SIGNALTRAIL_CLICKHOUSE_READ_URL: 'http://127.0.0.1:8123',
    SIGNALTRAIL_CLICKHOUSE_READ_USER: state.readerName,
    SIGNALTRAIL_CLICKHOUSE_READ_PASSWORD: state.chPassword,
    SIGNALTRAIL_MEMBERSHIP_DATABASE_URL: connectionString,
    SIGNALTRAIL_MEMBERSHIP_TLS: 'false',
  });
  await writeFile(envPath + '.backup-' + randomUUID(), source, { flag: 'wx', mode: 0o600 });
  const temporary = envPath + '.pending-' + randomUUID();
  await writeFile(temporary, next, { flag: 'wx', mode: 0o600 });
  await rename(temporary, envPath);
  console.log(
    JSON.stringify({
      target: 'local-compose',
      ownerMembershipVerified: true,
      restrictedAnalyticsReadVerified: true,
      postgresWriteAndKeyAccessDenied: true,
      dashboardEnvironmentUpdated: true,
      credentialsPrinted: false,
      restartDashboard: true,
    }),
  );
} catch {
  console.error(
    'Local dashboard setup was not confirmed. Saved local setup state permits inspection/retry; no credentials were printed.',
  );
  process.exitCode = 1;
} finally {
  await reader?.close();
  await client?.end();
}
