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

## Cost

Three short trials before this host: $0.00, $0.04, $0.03. This host to the end of
the t4g.medium runs: ~$0.15 (2.3 h). Budget alert: $10/month gross.
