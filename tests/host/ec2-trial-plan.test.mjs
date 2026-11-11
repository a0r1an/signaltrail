import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  PRICES,
  blockDevices,
  estimateCost,
  findDataDevice,
  instancePolicy,
  tagSpecifications,
} from './ec2-trial-plan.mjs';

test('finds the EBS data volume by its NVMe serial, not by device order', () => {
  const lsblk = {
    blockdevices: [
      { name: 'nvme0n1', serial: 'vol0aaaaaaaaaaaaaaaaa' },
      { name: 'nvme1n1', serial: 'vol0bbbbbbbbbbbbbbbbb' },
    ],
  };
  assert.equal(findDataDevice(lsblk, 'vol-0bbbbbbbbbbbbbbbbb'), '/dev/nvme1n1');
  assert.throws(() => findDataDevice(lsblk, 'vol-0ccccccccccccccccc'), /vol-0ccccccccccccccccc/);
});

test('root and data volumes are encrypted gp3 and deleted with the instance', () => {
  assert.deepEqual(blockDevices({ rootGb: 20, dataGb: 40 }), [
    {
      DeviceName: '/dev/sda1',
      Ebs: { VolumeSize: 20, VolumeType: 'gp3', Encrypted: true, DeleteOnTermination: true },
    },
    {
      DeviceName: '/dev/sdf',
      Ebs: { VolumeSize: 40, VolumeType: 'gp3', Encrypted: true, DeleteOnTermination: true },
    },
  ]);
});

test('every trial resource carries the trial tag used for teardown', () => {
  assert.deepEqual(tagSpecifications('t1', 'host', ['instance', 'volume']), [
    {
      ResourceType: 'instance',
      Tags: [
        { Key: 'signaltrail:trial', Value: 't1' },
        { Key: 'Name', Value: 'signaltrail-trial-t1-host' },
      ],
    },
    {
      ResourceType: 'volume',
      Tags: [
        { Key: 'signaltrail:trial', Value: 't1' },
        { Key: 'Name', Value: 'signaltrail-trial-t1-host' },
      ],
    },
  ]);
});

test('the host role can sync and read backups but not delete them or touch other buckets', () => {
  const policy = instancePolicy('signaltrail-backups-x');
  assert.deepEqual(policy.Statement, [
    {
      Effect: 'Allow',
      Action: ['s3:ListBucket'],
      Resource: ['arn:aws:s3:::signaltrail-backups-x'],
    },
    {
      Effect: 'Allow',
      Action: ['s3:GetObject', 's3:PutObject'],
      Resource: ['arn:aws:s3:::signaltrail-backups-x/*'],
    },
  ]);
});

test('cost sums instance hours by type (including resizes), volumes and public IPv4', () => {
  const hour = 3600 * 1000;
  const t0 = Date.UTC(2026, 10, 12, 0);
  const state = {
    instances: [
      {
        role: 'host',
        publicIpv4: true,
        intervals: [
          { type: 't4g.medium', from: t0, to: t0 + 4 * hour },
          { type: 't4g.large', from: t0 + 4 * hour },
        ],
      },
      { role: 'generator', publicIpv4: true, intervals: [{ type: 't4g.small', from: t0 }] },
    ],
    volumes: [{ gb: 60, from: t0 }],
  };
  const cost = estimateCost(state, t0 + 6 * hour);
  const expected =
    4 * PRICES['t4g.medium'] +
    2 * PRICES['t4g.large'] +
    6 * PRICES['t4g.small'] +
    (60 * 6 * PRICES.gp3GbMonth) / 730 +
    2 * 6 * PRICES.publicIpv4Hour;
  assert.ok(Math.abs(cost.usd - expected) < 1e-9, `${cost.usd} vs ${expected}`);
  assert.equal(cost.hours, 6);
});

test('cost of a stopped interval counts only volumes and no instance hours', () => {
  const hour = 3600 * 1000;
  const state = {
    instances: [{ role: 'host', publicIpv4: true, intervals: [] }],
    volumes: [{ gb: 73, from: 0, to: 730 * hour }],
  };
  assert.ok(Math.abs(estimateCost(state, 730 * hour).usd - 73 * PRICES.gp3GbMonth) < 1e-9);
});
