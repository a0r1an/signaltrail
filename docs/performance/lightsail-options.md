# Lightsail CPU/RAM options — checked November 9, 2026

Public Linux/Unix instance bundle prices, USD per month, excluding tax and extra
services/overages. No purchase, region, deployment or provider selection is approved.
Lightsail bundles CPU/RAM/storage; the requested four-vCPU/four-GB instance is not
listed in the current bundle tables. This is public pricing, not an account quote.

| Bundle                   | vCPUs | Advertised RAM | SSD    | Public IPv4 monthly cap | IPv6-only monthly cap |
| ------------------------ | ----- | -------------- | ------ | ----------------------- | --------------------- |
| General purpose Medium   | 2     | 4 GB           | 80 GB  | $24                     | $20                   |
| Compute optimized Large  | 2     | 4 GB           | 160 GB | $42                     | $38                   |
| Compute optimized Xlarge | 4     | 8 GB           | 320 GB | $84                     | $80                   |
| General purpose Xlarge   | 4     | 16 GB          | 320 GB | $84                     | $80                   |

Sources: [AWS bundle tables](https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-bundles.html)
and [AWS pricing](https://aws.amazon.com/lightsail/pricing/), accessed November 9.
IPv6-only requires a deliberately compatible network/deployment design; it is not
an interchangeable assumption for the current app. Backup snapshots, object
storage, taxes and transfer overages are outside the bundle price. Transfer
allowances vary in some regions. No checkout availability/quote was verified.

The $24 general-purpose four-GB plan has a 20% baseline per vCPU and burst credits.
Local CPU affinity to two logical CPUs does not emulate those credit economics
or establish sustained Lightsail capacity. See [AWS CPU baseline documentation](https://docs.aws.amazon.com/lightsail/latest/userguide/baseline-cpu-performance.html).
The retrieved baseline table does not specify the compute-optimized plan's exact
baseline; do not assume sustained performance solely from its name/price. Verify
that plan's terms/performance before recommending a purchase.

Within the user's recorded $50/month VPS budget, advertised two-vCPU/four-GB
options fit the instance-price allowance; the listed four-vCPU options exceed it.
This is a price comparison, not a production sizing recommendation. Our four-GiB
local budget remains experimental pending CPU isolation, memory pressure,
endurance, backups/restore and actual-host measurements.
