# EC2 t4g qualification trial — 2026-11-11

Account 231576004804 (paid plan, credits), us-east-2. Host t4g.medium (2 vCPU
Graviton2, 4 GiB, unlimited credits), 20 GB root + 40 GB gp3 data volume (3000 IOPS,
125 MB/s). Generator t4g.small (k6) in the same VPC, reaching ingestion on the host's
private address. Release built from the committed tree. Tooling:
`host ec2-up|ec2-bootstrap|ec2-status|ec2-resize-*|ec2-down`, then
`SIGNALTRAIL_HOST_TARGET=ec2 host remote-*`. Evidence: `test-results/host/`,
`test-results/aws-trial/`.

## Findings that changed code

1. **Free plan blocks t4g** (`not eligible for Free Tier`; a dry-run does not check
   this). The user upgraded the account to paid; credits were kept.
2. **Snap store unreachable on first boot**: bootstrap now installs the AWS CLI with
   AWS's installer.
3. **Exact-mode FINAL expansion** (fixed in 8ea9c8a): with several projects in shared
   parts, ClickHouse's default `use_skip_indexes_if_final_exact_mode=1` re-read every
   granule whose key range overlaps a selected one. A 1-day dashboard read scanned
   6.1M of 9.2M rows (1.6 s); dashboard queries hit the 4 s timeout at 1 EPS and
   starved ingestion (p95 794 ms). Event-time reads now disable exact mode (115k
   rows, 41 ms). Reproduced locally on 26.8.19.9, so it is the data layout (single-
   project local fixtures hid it), not the patch version.

## t4g.medium results (9M seeded rows over 90 days)

Disk probe (data volume): fsync 332–336/s (p99 3.5–4.7 ms), random read 3150 IOPS
(p99 7 ms), sequential write 131 MB/s. Seed of 9M rows: 33 s. Bootstrap: 150–189 s.
Steal ≤ 0.9% throughout.

**Ingestion only** (no dashboard viewer), 10-minute stages, every accepted event
stored (ledger reconciliation), drained within 0.6 s:

| EPS | Accepted | Lost | p95 ms | p99 ms | CPU (baseline 20%) |
| --: | -------: | ---: | -----: | -----: | -----------------: |
|  10 |    6,001 |    0 |      5 |      7 |              15.9% |
|  25 |   15,001 |    0 |      4 |      7 |              17.7% |
|  50 |   30,001 |    0 |      4 |      7 |              20.5% |
| 100 |   60,000 |    0 |      4 |      8 |              25.9% |
| 150 |   90,001 |    0 |      4 |      9 |              30.6% |

No failure up to 150 EPS. Sustainable without spending burst credits: ~50 EPS.
Fixed overhead (ClickHouse background work, Redpanda, idle services) is roughly
14–15% CPU, most of the 20% baseline; each additional 10 EPS adds about 1%.

**With one continuous dashboard viewer** (1/7/30-day pages every 5 s, far heavier
than a person), 15-minute stages:

| EPS | Ingestion | Lost | p95 ms | p99 ms |   CPU | Page p95 |
| --: | --------- | ---: | -----: | -----: | ----: | -------: |
|   1 | pass      |    0 |     12 |    244 | 28.5% |    3.5 s |
|   5 | pass      |    0 |     13 |    384 | 29.6% |    3.4 s |
|  10 | pass      |    0 |      9 |    317 | 30.3% |    3.6 s |
|  25 | pass      |    0 |     62 |    736 | 32.2% |    3.5 s |
|  50 | fail      |    0 |    305 |    931 | 35.0% |    3.7 s |

At 50 EPS the generator dropped 30 of 45,000 sends (0.07%) while responses slowed;
nothing accepted was lost. Cause: the viewer's queries burst ClickHouse to 109% (p90)
and 179% (max) CPU, saturating both vCPUs; ingestion averaged 14%, the disk ~1%.
1-day and 7-day pages stay under ~1.2 s; the 30-day visitor count (3M events in the
window) takes 3.1–3.4 s. The user accepted that for now (fix later: daily visitor
rollup or query cache).

## Limits for upgrade alarms (t4g.medium)

- Required: 1 EPS with no lost events — met with 50–150× headroom.
- Sustained ingestion within the CPU baseline: ~50 EPS. Burst: ≥ 150 EPS (untested
  above).
- With heavy dashboard use: ≤ 25 EPS keeps ingestion p99 under 1 s.
- Alarm candidates: CPU credit balance falling (not CPU %), ingestion p99 > 500 ms,
  dashboard query p95 > 2 s, sustained ingest rate > 25 EPS.

## t4g.large (same host, resized)

`host ec2-resize-large`: stop → change type → start → verify took **85 s** of
downtime; data, private address and services came back intact. t4g.large has the
**same 2 vCPUs** as t4g.medium; it adds memory (8 GiB, unused while the container
caps stay at their 4 GiB values) and a higher CPU baseline (30% vs 20%). The first
viewer stage (1 EPS, now 18M rows in two projects) passed ingestion (901/901,
p95 14 ms) with a 4.1 s dashboard page p95 — no faster than t4g.medium — so the run
was stopped. Per-rate CPU is the same on both, so on t4g.large ingestion alone stays
within the 30% baseline up to ~100–150 EPS (25.9% at 100, 30.6% at 150 above).
Faster dashboards need more vCPUs (t4g.xlarge, ~$98/month, over budget) or a rollup.

## Backup and restore at production size (18M events, 0.89M links)

| Step                                | Result                                 |
| ----------------------------------- | -------------------------------------- |
| Full backup, 9M rows (hourly timer) | ~7 s, 409 MB, copied to S3             |
| Incremental + S3 copy               | 9–10 s (differential against the full) |
| S3 after two runs                   | 515 objects, 0.92 GB                   |
| Restore (ClickHouse + PostgreSQL)   | 40 s                                   |
| Fingerprint at backup vs restored   | exact match; post-backup write gone    |
| Verify after restore                | OK event stored, restricted users, TLS |

Notes: incrementals are differentials against the latest full, so they grow during
the day. The host role cannot delete S3 objects, so S3 keeps every backup until a
lifecycle rule is added (retention decision pending). A replacement host restores
after syncing the bucket down first.

## Cost

All trials torn down; nothing left (instances, volumes, security groups, key pairs,
role, bucket checked). Estimated total **$0.26** (trials: $0.00, $0.04, $0.03,
$0.19 over 2.6 h). Budget alert: $10/month gross. Credits: $140 remaining.

## Instance comparison (for later sizing)

| Instance   | vCPU   | Memory | Baseline | Credits/h | EBS burst     | $/month (instance) |
| ---------- | ------ | ------ | -------- | --------: | ------------- | -----------------: |
| t4g.medium | 2      | 4 GiB  | 20%      |        24 | 2,085 Mbps    |             ~24.50 |
| t4g.large  | 2      | 8 GiB  | 30%      |        36 | 2,780 Mbps    |                ~49 |
| t4g.xlarge | 4      | 16 GiB | 40%      |        96 | 2,780 Mbps    |                ~98 |
| c7g.large  | 2 (G3) | 4 GiB  | 100%     |         — | up to 10 Gbps |                ~53 |
| c7g.xlarge | 4 (G3) | 8 GiB  | 100%     |         — | up to 10 Gbps |               ~106 |

Disk (60 GB gp3) and public IPv4 add ~$8.50/month. Only t4g prices were checked
with the Pricing API; the rest are approximate. Measured here: t4g.large does not
speed up the dashboard. c7g (Graviton3) is unmeasured.
