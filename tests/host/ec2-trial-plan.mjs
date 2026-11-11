// Pure pieces of the EC2 trial: resource shapes, the data-disk lookup and the cost
// log. The AWS calls live in ec2-trial.mjs.

/** us-east-2 on-demand, Linux, checked with the Pricing API on 2026-11-11. */
export const PRICES = {
  't4g.small': 0.0168,
  't4g.medium': 0.0336,
  't4g.large': 0.0672,
  gp3GbMonth: 0.08,
  publicIpv4Hour: 0.005,
};
const HOUR = 3600 * 1000;
const MONTH_HOURS = 730;

export const TRIAL_TAG = 'signaltrail:trial';

export function tagSpecifications(trial, role, resourceTypes) {
  return resourceTypes.map((ResourceType) => ({
    ResourceType,
    Tags: [
      { Key: TRIAL_TAG, Value: trial },
      { Key: 'Name', Value: `signaltrail-trial-${trial}-${role}` },
    ],
  }));
}

/** Encrypted gp3 root and data volumes that go away with the instance. */
export function blockDevices({ rootGb, dataGb }) {
  const ebs = (VolumeSize) => ({
    VolumeSize,
    VolumeType: 'gp3',
    Encrypted: true,
    DeleteOnTermination: true,
  });
  const devices = [{ DeviceName: '/dev/sda1', Ebs: ebs(rootGb) }];
  if (dataGb) devices.push({ DeviceName: '/dev/sdf', Ebs: ebs(dataGb) });
  return devices;
}

/** Nitro exposes EBS volumes as NVMe devices whose serial is the volume ID without the dash. */
export function findDataDevice(lsblk, volumeId) {
  const serial = volumeId.replace('-', '');
  const device = lsblk.blockdevices.find((entry) => entry.serial === serial);
  if (!device) throw new Error(`No block device for ${volumeId}`);
  return `/dev/${device.name}`;
}

/** Host instance role: sync and read backups; no delete, no other buckets. */
export function instancePolicy(bucket) {
  return {
    Version: '2012-10-17',
    Statement: [
      { Effect: 'Allow', Action: ['s3:ListBucket'], Resource: [`arn:aws:s3:::${bucket}`] },
      {
        Effect: 'Allow',
        Action: ['s3:GetObject', 's3:PutObject'],
        Resource: [`arn:aws:s3:::${bucket}/*`],
      },
    ],
  };
}

const hoursOf = ({ from, to }, now) => ((to ?? now) - from) / HOUR;

/**
 * Running instance hours by type, volume GB-hours and the public IPv4 address each
 * running instance holds (released while stopped). Excludes S3 (cents) and T4g
 * unlimited surplus credits, which CloudWatch reports separately.
 */
export function estimateCost(state, now) {
  let usd = 0,
    first = now;
  for (const instance of state.instances) {
    for (const interval of instance.intervals) {
      const hours = hoursOf(interval, now);
      usd += hours * PRICES[interval.type];
      if (instance.publicIpv4) usd += hours * PRICES.publicIpv4Hour;
      first = Math.min(first, interval.from);
    }
  }
  for (const volume of state.volumes) {
    usd += (volume.gb * hoursOf(volume, now) * PRICES.gp3GbMonth) / MONTH_HOURS;
    first = Math.min(first, volume.from);
  }
  return { usd, hours: (now - first) / HOUR };
}
