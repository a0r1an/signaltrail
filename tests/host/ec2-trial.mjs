// Disposable EC2 qualification trial (approved: ≤ $10 of credits, same-day teardown).
// Every resource carries the signaltrail:trial tag (IAM and the bucket by name), and
// `down` removes them all, then checks nothing tagged is left.
//
//   node tests/host/ec2-trial.mjs up|bootstrap|status|resize-large|resize-medium|down
//   (bootstrap re-runs provisioning on the running trial)
//   AWS_PROFILE (default signaltrail-trial), AWS_REGION (default us-east-2).
// State, SSH key and cost log: test-results/aws-trial/ (ignored by git).
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import {
  TRIAL_TAG,
  blockDevices,
  estimateCost,
  findDataDevice,
  instancePolicy,
  tagSpecifications,
} from './ec2-trial-plan.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const directory = resolve(root, 'test-results/aws-trial');
const stateFile = resolve(directory, 'state.json');
const profile = process.env.AWS_PROFILE ?? 'signaltrail-trial';
const region = process.env.AWS_REGION ?? 'us-east-2';
const HOST_TYPE = 't4g.medium';
const GENERATOR_TYPE = 't4g.small';
const K6_VERSION = '1.6.0';
export const REPO = '/opt/signaltrail';

function run(command, args, { input, allowFailure = false } = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 || allowFailure
        ? resolveRun({ code, stdout, stderr })
        : reject(
            new Error(
              `${command} ${args.slice(0, 3).join(' ')} exited ${code}: ${stderr.slice(-2000)}`,
            ),
          ),
    );
    if (input?.pipe) input.pipe(child.stdin);
    else child.stdin.end(input ?? '');
  });
}

async function aws(args, options) {
  const { stdout, code, stderr } = await run(
    'aws',
    [...args, '--profile', profile, '--region', region, '--output', 'json'],
    options,
  );
  if (options?.allowFailure)
    return { code, stderr, value: stdout.trim() ? JSON.parse(stdout) : undefined };
  return stdout.trim() ? JSON.parse(stdout) : undefined;
}

const log = (message) => console.log(`${new Date().toISOString().slice(11, 19)} ${message}`);
const loadState = async () => JSON.parse(await readFile(stateFile, 'utf8').catch(() => 'null'));
const saveState = (state) => writeFile(stateFile, JSON.stringify(state, null, 2));
const quote = (text) => `'${text.replaceAll("'", `'\\''`)}'`;

export function sshArgs(state, address) {
  return [
    '-i',
    resolve(directory, state.trial, 'id_ed25519'),
    '-o',
    'StrictHostKeyChecking=accept-new',
    '-o',
    `UserKnownHostsFile=${resolve(directory, state.trial, 'known_hosts')}`,
    '-o',
    'ConnectTimeout=10',
    '-o',
    'ServerAliveInterval=30',
    '-o',
    'BatchMode=yes',
    `ubuntu@${address}`,
  ];
}

/** Root shell command on a trial instance. */
export const ssh = (state, address, command, options) =>
  run('ssh', [...sshArgs(state, address), `sudo sh -c ${quote(command)}`], options);

async function waitForSsh(state, address) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const { code } = await ssh(state, address, 'cloud-init status --wait >/dev/null; true', {
      allowFailure: true,
    });
    if (code === 0) return;
    await delay(5000);
  }
  throw new Error(`SSH to ${address} did not come up`);
}

async function describe(instanceId) {
  const { Reservations } = await aws(['ec2', 'describe-instances', '--instance-ids', instanceId]);
  return Reservations[0].Instances[0];
}

async function launch(state, role, { type, rootGb, dataGb, securityGroup, instanceProfile }) {
  const args = [
    'ec2',
    'run-instances',
    '--image-id',
    state.ami,
    '--instance-type',
    type,
    '--key-name',
    state.keyName,
    '--security-group-ids',
    securityGroup,
    '--block-device-mappings',
    JSON.stringify(blockDevices({ rootGb, dataGb })),
    '--metadata-options',
    'HttpTokens=required,HttpEndpoint=enabled',
    '--credit-specification',
    'CpuCredits=unlimited',
    '--tag-specifications',
    JSON.stringify(tagSpecifications(state.trial, role, ['instance', 'volume'])),
  ];
  if (instanceProfile) args.push('--iam-instance-profile', `Name=${instanceProfile}`);
  // A new instance profile takes a few seconds to become usable.
  for (let attempt = 0; ; attempt++) {
    const result = await aws(args, { allowFailure: true });
    if (result.code === 0) return result.value.Instances[0].InstanceId;
    if (attempt >= 12 || !/InvalidParameterValue|instance profile/i.test(result.stderr))
      throw new Error(result.stderr);
    await delay(5000);
  }
}

async function up() {
  const existing = await loadState();
  if (existing && !existing.closedAt)
    throw new Error(`Trial ${existing.trial} is still up; run down first`);
  const trial = `${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${randomBytes(3).toString('hex')}`;
  const own = resolve(directory, trial);
  await mkdir(own, { recursive: true });
  const account = (await aws(['sts', 'get-caller-identity'])).Account;
  const myIp = (await (await fetch('https://checkip.amazonaws.com')).text()).trim();
  const state = {
    trial,
    account,
    region,
    sshFrom: `${myIp}/32`,
    keyName: `signaltrail-trial-${trial}`,
    role: `signaltrail-trial-${trial}-host`,
    bucket: `signaltrail-backups-${account}-${trial}`,
    instances: [],
    volumes: [],
    startedAt: Date.now(),
  };
  await saveState(state);
  log(`trial ${trial} in ${account}/${region}, SSH from ${state.sshFrom}`);

  await run('ssh-keygen', [
    '-q',
    '-t',
    'ed25519',
    '-N',
    '',
    '-C',
    state.keyName,
    '-f',
    resolve(own, 'id_ed25519'),
  ]);
  await aws([
    'ec2',
    'import-key-pair',
    '--key-name',
    state.keyName,
    '--public-key-material',
    `fileb://${resolve(own, 'id_ed25519.pub')}`,
    '--tag-specifications',
    JSON.stringify(tagSpecifications(trial, 'key', ['key-pair'])),
  ]);

  const vpc = (await aws(['ec2', 'describe-vpcs', '--filters', 'Name=is-default,Values=true']))
    .Vpcs[0].VpcId;
  const group = async (role) =>
    (
      await aws([
        'ec2',
        'create-security-group',
        '--vpc-id',
        vpc,
        '--group-name',
        `signaltrail-trial-${trial}-${role}`,
        '--description',
        `SignalTrail trial ${trial} ${role}`,
        '--tag-specifications',
        JSON.stringify(tagSpecifications(trial, role, ['security-group'])),
      ])
    ).GroupId;
  state.hostGroup = await group('host');
  state.generatorGroup = await group('generator');
  await saveState(state);
  const ingress = (groupId, permissions) =>
    aws([
      'ec2',
      'authorize-security-group-ingress',
      '--group-id',
      groupId,
      '--ip-permissions',
      JSON.stringify(permissions),
    ]);
  const sshRule = {
    IpProtocol: 'tcp',
    FromPort: 22,
    ToPort: 22,
    IpRanges: [{ CidrIp: state.sshFrom }],
  };
  await ingress(state.hostGroup, [
    sshRule,
    {
      IpProtocol: 'tcp',
      FromPort: 4100,
      ToPort: 4100,
      UserIdGroupPairs: [{ GroupId: state.generatorGroup }],
    },
  ]);
  await ingress(state.generatorGroup, [sshRule]);

  // Backup bucket: private, encrypted by default, written only by the host role.
  await aws([
    's3api',
    'create-bucket',
    '--bucket',
    state.bucket,
    '--create-bucket-configuration',
    `LocationConstraint=${region}`,
  ]);
  await aws([
    's3api',
    'put-public-access-block',
    '--bucket',
    state.bucket,
    '--public-access-block-configuration',
    'BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true',
  ]);
  await aws([
    's3api',
    'put-bucket-tagging',
    '--bucket',
    state.bucket,
    '--tagging',
    JSON.stringify({ TagSet: [{ Key: TRIAL_TAG, Value: trial }] }),
  ]);
  await aws([
    'iam',
    'create-role',
    '--role-name',
    state.role,
    '--assume-role-policy-document',
    JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        { Effect: 'Allow', Principal: { Service: 'ec2.amazonaws.com' }, Action: 'sts:AssumeRole' },
      ],
    }),
    '--tags',
    JSON.stringify([{ Key: TRIAL_TAG, Value: trial }]),
  ]);
  await aws([
    'iam',
    'put-role-policy',
    '--role-name',
    state.role,
    '--policy-name',
    'backups',
    '--policy-document',
    JSON.stringify(instancePolicy(state.bucket)),
  ]);
  await aws(['iam', 'create-instance-profile', '--instance-profile-name', state.role]);
  await aws([
    'iam',
    'add-role-to-instance-profile',
    '--instance-profile-name',
    state.role,
    '--role-name',
    state.role,
  ]);
  await saveState(state);

  state.ami = (
    await aws([
      'ssm',
      'get-parameter',
      '--name',
      '/aws/service/canonical/ubuntu/server/24.04/stable/current/arm64/hvm/ebs-gp3/ami-id',
    ])
  ).Parameter.Value;
  const hostId = await launch(state, 'host', {
    type: HOST_TYPE,
    rootGb: 20,
    dataGb: 40,
    securityGroup: state.hostGroup,
    instanceProfile: state.role,
  });
  state.instances.push({
    role: 'host',
    id: hostId,
    publicIpv4: true,
    intervals: [{ type: HOST_TYPE, from: Date.now() }],
  });
  state.volumes.push({ gb: 60, from: Date.now() });
  await saveState(state);
  const generatorId = await launch(state, 'generator', {
    type: GENERATOR_TYPE,
    rootGb: 10,
    securityGroup: state.generatorGroup,
  });
  state.instances.push({
    role: 'generator',
    id: generatorId,
    publicIpv4: true,
    intervals: [{ type: GENERATOR_TYPE, from: Date.now() }],
  });
  state.volumes.push({ gb: 10, from: Date.now() });
  await saveState(state);
  log(`launched host ${hostId} (${HOST_TYPE}) and generator ${generatorId} (${GENERATOR_TYPE})`);

  await aws(['ec2', 'wait', 'instance-running', '--instance-ids', hostId, generatorId]);
  await refreshAddresses(state);
  const host = await describe(hostId);
  state.dataVolume = host.BlockDeviceMappings.find(
    (mapping) => mapping.DeviceName === '/dev/sdf',
  ).Ebs.VolumeId;
  await saveState(state);

  await provision(state);
}

/** Copy the committed tree, bootstrap the host, install k6, verify. Safe to re-run. */
async function provision(state) {
  state ??= await loadState();
  if (!state || state.closedAt) throw new Error('No running trial');
  const own = resolve(directory, state.trial);
  await Promise.all([
    waitForSsh(state, state.host.public),
    waitForSsh(state, state.generator.public),
  ]);
  log('SSH up; copying the committed tree to the host');
  const release = (await run('git', ['-C', root, 'rev-parse', '--short', 'HEAD'])).stdout.trim();
  const archive = spawn('git', ['-C', root, 'archive', '--format=tar', 'HEAD'], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await ssh(state, state.host.public, `rm -rf ${REPO} && mkdir -p ${REPO} && tar -x -C ${REPO}`, {
    input: archive.stdout,
  });
  const device = findDataDevice(
    JSON.parse((await ssh(state, state.host.public, 'lsblk -J -d -o NAME,SERIAL')).stdout),
    state.dataVolume,
  );
  log(`bootstrap (release ${release}, data disk ${device})`);
  const started = Date.now();
  const bootstrap = await ssh(
    state,
    state.host.public,
    [
      `SIGNALTRAIL_RELEASE=${release}`,
      `SIGNALTRAIL_DATA_DEVICE=${device}`,
      `SIGNALTRAIL_INGESTION_PUBLISH=${state.host.private}:4100`,
      `SIGNALTRAIL_BACKUP_S3=s3://${state.bucket}/host`,
      `SIGNALTRAIL_BACKUP_S3_REGION=${region}`,
      `sh ${REPO}/infra/host/bootstrap.sh`,
    ].join(' '),
    { allowFailure: true },
  );
  await writeFile(resolve(own, 'bootstrap.log'), bootstrap.stdout + bootstrap.stderr);
  if (bootstrap.code !== 0)
    throw new Error(`bootstrap failed; see ${resolve(own, 'bootstrap.log')}`);
  state.bootstrapSeconds = (Date.now() - started) / 1000;
  state.release = release;
  await saveState(state);

  log('installing k6 on the generator');
  await ssh(
    state,
    state.generator.public,
    `curl -fsSL https://github.com/grafana/k6/releases/download/v${K6_VERSION}/k6-v${K6_VERSION}-linux-arm64.tar.gz | tar -xz -C /tmp && install /tmp/k6-v${K6_VERSION}-linux-arm64/k6 /usr/local/bin/k6 && k6 version`,
  );
  await run('scp', [
    ...sshArgs(state, state.generator.public).slice(0, -1),
    resolve(root, 'tests/host/k6-ledger.js'),
    `ubuntu@${state.generator.public}:/home/ubuntu/k6-ledger.js`,
  ]);
  const verified = (await ssh(state, state.host.public, `sh ${REPO}/infra/host/verify.sh`)).stdout
    .trim()
    .split('\n')
    .at(-1);
  log(`verify: ${verified}`);
  log(
    `bootstrap took ${state.bootstrapSeconds.toFixed(0)} s; run SIGNALTRAIL_HOST_TARGET=ec2 remote profiles next`,
  );
  await status(state);
}

async function refreshAddresses(state) {
  for (const instance of state.instances) {
    const described = await describe(instance.id);
    state[instance.role] = {
      public: described.PublicIpAddress,
      private: described.PrivateIpAddress,
    };
  }
  await saveState(state);
}

async function cost(state) {
  const { usd, hours } = estimateCost(state, state.closedAt ?? Date.now());
  return { trial: state.trial, usd: Number(usd.toFixed(3)), hours: Number(hours.toFixed(2)) };
}

async function status(state) {
  state ??= await loadState();
  if (!state) return log('no trial');
  const types = state.instances.map(
    (instance) => `${instance.role} ${instance.intervals.at(-1)?.type ?? 'stopped'}`,
  );
  log(`trial ${state.trial} ${state.closedAt ? 'closed' : 'up'}: ${types.join(', ')}`);
  console.log(
    JSON.stringify(
      { host: state.host, generator: state.generator, cost: await cost(state) },
      null,
      2,
    ),
  );
}

/** Stop, change the instance type, start and verify. Data and private IP are kept. */
async function resize(type) {
  const state = await loadState();
  if (!state || state.closedAt) throw new Error('No running trial');
  const host = state.instances.find((instance) => instance.role === 'host');
  const started = Date.now();
  log(`stopping host to resize to ${type}`);
  await aws(['ec2', 'stop-instances', '--instance-ids', host.id]);
  await aws(['ec2', 'wait', 'instance-stopped', '--instance-ids', host.id]);
  host.intervals.at(-1).to = Date.now();
  await saveState(state);
  await aws([
    'ec2',
    'modify-instance-attribute',
    '--instance-id',
    host.id,
    '--instance-type',
    JSON.stringify({ Value: type }),
  ]);
  await aws(['ec2', 'start-instances', '--instance-ids', host.id]);
  host.intervals.push({ type, from: Date.now() });
  await saveState(state);
  await aws(['ec2', 'wait', 'instance-running', '--instance-ids', host.id]);
  await refreshAddresses(state);
  await waitForSsh(state, state.host.public);
  const verified = (await ssh(state, state.host.public, `sh ${REPO}/infra/host/verify.sh`)).stdout
    .trim()
    .split('\n')
    .at(-1);
  state.resizes = [...(state.resizes ?? []), { type, seconds: (Date.now() - started) / 1000 }];
  await saveState(state);
  log(`resized to ${type} in ${((Date.now() - started) / 1000).toFixed(0)} s; verify: ${verified}`);
}

async function down() {
  const state = await loadState();
  if (!state || state.closedAt) return log('no trial to tear down');
  const filter = `Name=tag:${TRIAL_TAG},Values=${state.trial}`;
  const tagged = await aws([
    'ec2',
    'describe-instances',
    '--filters',
    filter,
    'Name=instance-state-name,Values=pending,running,stopping,stopped',
  ]);
  const ids = tagged.Reservations.flatMap((reservation) =>
    reservation.Instances.map((instance) => instance.InstanceId),
  );
  if (ids.length) {
    log(`terminating ${ids.join(' ')}`);
    await aws(['ec2', 'terminate-instances', '--instance-ids', ...ids]);
    await aws(['ec2', 'wait', 'instance-terminated', '--instance-ids', ...ids]);
  }
  const now = Date.now();
  for (const instance of state.instances)
    for (const interval of instance.intervals) interval.to ??= now;
  for (const volume of state.volumes) volume.to ??= now;
  await saveState(state);

  const ignoreMissing = { allowFailure: true };
  // The host group references the generator group, so it goes first; network
  // interfaces of terminated instances can hold a group for a few seconds.
  for (const groupId of [state.hostGroup, state.generatorGroup].filter(Boolean))
    for (let attempt = 0; attempt < 12; attempt++) {
      const result = await aws(
        ['ec2', 'delete-security-group', '--group-id', groupId],
        ignoreMissing,
      );
      if (result.code === 0 || /InvalidGroup.NotFound/.test(result.stderr)) break;
      await delay(5000);
    }
  await aws(['ec2', 'delete-key-pair', '--key-name', state.keyName], ignoreMissing);
  await aws(
    [
      'iam',
      'remove-role-from-instance-profile',
      '--instance-profile-name',
      state.role,
      '--role-name',
      state.role,
    ],
    ignoreMissing,
  );
  await aws(
    ['iam', 'delete-instance-profile', '--instance-profile-name', state.role],
    ignoreMissing,
  );
  await aws(
    ['iam', 'delete-role-policy', '--role-name', state.role, '--policy-name', 'backups'],
    ignoreMissing,
  );
  await aws(['iam', 'delete-role', '--role-name', state.role], ignoreMissing);
  await run(
    'aws',
    [
      's3',
      'rm',
      `s3://${state.bucket}`,
      '--recursive',
      '--quiet',
      '--profile',
      profile,
      '--region',
      region,
    ],
    ignoreMissing,
  );
  await aws(['s3api', 'delete-bucket', '--bucket', state.bucket], ignoreMissing);

  // Nothing tagged for this trial may remain (terminated instances linger briefly).
  const left = [];
  const instancesLeft = await aws([
    'ec2',
    'describe-instances',
    '--filters',
    filter,
    'Name=instance-state-name,Values=pending,running,stopping,stopped',
  ]);
  left.push(...instancesLeft.Reservations.flatMap((r) => r.Instances.map((i) => i.InstanceId)));
  left.push(
    ...(await aws(['ec2', 'describe-volumes', '--filters', filter])).Volumes.map((v) => v.VolumeId),
  );
  left.push(
    ...(await aws(['ec2', 'describe-security-groups', '--filters', filter])).SecurityGroups.map(
      (g) => g.GroupId,
    ),
  );
  left.push(
    ...(await aws(['ec2', 'describe-key-pairs', '--filters', filter])).KeyPairs.map(
      (k) => k.KeyName,
    ),
  );
  if ((await aws(['iam', 'get-role', '--role-name', state.role], ignoreMissing)).code === 0)
    left.push(state.role);
  if ((await aws(['s3api', 'head-bucket', '--bucket', state.bucket], ignoreMissing)).code === 0)
    left.push(state.bucket);
  if (left.length) throw new Error(`Trial resources still present: ${left.join(' ')}`);

  state.closedAt = now;
  await saveState(state);
  const summary = {
    ...(await cost(state)),
    closedAt: new Date(now).toISOString(),
    resizes: state.resizes ?? [],
  };
  await appendFile(resolve(directory, 'cost-log.jsonl'), JSON.stringify(summary) + '\n');
  await rm(resolve(directory, state.trial, 'id_ed25519'), { force: true });
  log(
    `trial ${state.trial} torn down; nothing tagged remains. Estimated $${summary.usd} over ${summary.hours} h`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await mkdir(directory, { recursive: true });
  const action = process.argv[2];
  const actions = {
    up,
    bootstrap: () => provision(),
    status: () => status(),
    'resize-large': () => resize('t4g.large'),
    'resize-medium': () => resize('t4g.medium'),
    down,
  };
  if (!actions[action])
    throw new Error(`Action must be one of: ${Object.keys(actions).join(', ')}`);
  await actions[action]();
}
