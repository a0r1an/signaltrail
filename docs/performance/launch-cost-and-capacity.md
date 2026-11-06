# Proposed low-cost launch budget and capacity qualification

Prepared 2026-11-06. Proposal only: no provider, budget, instance or supported
capacity is approved by this document. No purchase or deployment was performed.
Prices are USD before tax; advertised starting prices are not checkout quotes.

## Scope and assumptions

SignalTrail initially collects analytics only from software built by its owner.
Those applications have no traffic today and may receive social-media bursts.
Their visitors are not SignalTrail dashboard users: Clerk/dashboard access stays
owner-only. Application hosting, application auth and application databases are
outside this SignalTrail infrastructure estimate.

Keep the agreed single self-managed VPS for ingestion, workers, PostgreSQL,
Redpanda, ClickHouse and Valkey. Dashboard/demo remain on Vercel, Grafana Cloud
stores monitoring off-host, and S3 holds replay/recovery objects. Single-host
failure tolerance and uninterrupted resizing are not implied.

## Published candidate prices

| Candidate                  | Advertised RAM / CPU / storage       | Advertised monthly starting price |
| -------------------------- | ------------------------------------ | --------------------------------- |
| OVHcloud US VPS-3          | 12 GB / 6 vCores / 100 GB NVMe       | $12.32                            |
| OVHcloud US VPS-4          | 24 GB / 8 vCores / 200 GB NVMe       | $23.37                            |
| DigitalOcean Basic regular | 8 GiB / 4 shared vCPU / 160 GiB SSD  | $48                               |
| DigitalOcean Basic regular | 16 GiB / 8 shared vCPU / 320 GiB SSD | $96                               |

Sources: [OVHcloud US](https://us.ovhcloud.com/vps/),
[DigitalOcean](https://www.digitalocean.com/pricing/droplets).
OVH pricing is explicitly “starting at”; commitment, renewal price, location,
availability and exact month-to-month quote must be checked before selecting it.
The public configurator's term-specific quote was not accessible to this lookup.
Do not assume the starting price is an uncommitted monthly offer.
Do not equate advertised shared vCores with dedicated cores or measured disk IOPS.
Hetzner's public page did not expose a verifiable current price; no stale price
is used here. Do not choose a long commitment before qualification.

Working recommendation: benchmark the OVH 24-GB/200-GB class first if its
uncommitted quote is acceptable. Extra RAM/disk are useful for colocated broker,
analytics merges, indexes and caches. The 12-GB plan is a lean pilot candidate;
neither is certified for 1,000 active users. Reserve $30–40/month for VPS planning
until the exact quote is known; the advertised price may be lower.

## Monthly budget envelope (analytics first)

| Component                    |         Planning amount | Assumption                                                    |
| ---------------------------- | ----------------------: | ------------------------------------------------------------- |
| VPS                          |                  $30–40 | Allowance, not a quote; use measured candidate                |
| Vercel                       | $0 or $20 plus overages | Hobby personal/noncommercial, or one Pro seat                 |
| Clerk                        |                      $0 | One dashboard owner on eligible free plan                     |
| Grafana Cloud                |                      $0 | Free plan, bounded metric labels and usage                    |
| S3 archives/backups/requests |                   $3–10 | Small initial retained volume; not a measured bill            |
| Domain                       |         $1–2 equivalent | Placeholder; renewal/TLD may differ, shared domain may add $0 |

Calculated envelope: $34–52/month with Hobby, $54–72 with Pro. Round to a planning
budget of $35–55 or $55–75 respectively. If the advertised $23.37 VPS quote is
available, the same assumptions produce $27.37–35.37 or $47.37–55.37. Excludes
taxes, application hosting, usage overages, unusual transfers, extra backup storage,
load balancers and additional servers. No paid Clerk/Grafana account upgrade is
assumed, and actual account bills have not been audited.

Published references: [Vercel](https://vercel.com/pricing),
[Hobby use](https://vercel.com/docs/plans/hobby),
[Clerk](https://clerk.com/pricing), [Grafana](https://grafana.com/pricing/),
[S3](https://aws.amazon.com/s3/pricing/).
Grafana Free currently includes 10k active metric series and 14-day retention;
visitor/event IDs must never become unbounded metric labels.

Provider daily backups are not the agreed one-hour recovery point or a proven
datacenter-loss recovery mechanism. Off-server archive/backups, lag gating and a
restore drill remain required work. Preserve independent S3 budget for those.

## Convert users into a test workload

Clarification pending: whether 1,000 means arrivals over minutes or simultaneous
active people. Until answered, cover both. User count does not determine event
rate, request rate, payload size, replay volume or retained bytes.

| Simultaneously active users | 6 analytics events/user/minute | 30 events/user/minute |
| --------------------------- | -----------------------------: | --------------------: |
| 100                         |                    10 events/s |           50 events/s |
| 1,000                       |                   100 events/s |          500 events/s |

These are assumptions, not observed behavior. Test singleton/small batches and
simultaneous flushes: the existing 20-event batch test understates HTTP work for
sparse real browsers. Separately test 1,000 new sessions arriving over 60 seconds,
startup-event bursts, retries, hot sessions and occasional larger payloads.

Illustrative monthly analytics volume at 100 events/visitor/day and 1 KB/event:

| Daily visitors | Events/month (30 days) | Raw event bytes across 90 days |
| -------------- | ---------------------: | -----------------------------: |
| 100            |                300,000 |                         0.9 GB |
| 1,000          |              3,000,000 |                           9 GB |
| 10,000         |             30,000,000 |                          90 GB |

Raw bytes are not ClickHouse disk usage. Account separately for broker retention,
dedupe duplicates/merges, indexes, actual compression, logs and backup retention.
The 90-day product default is agreed but enforcement is not implemented yet.

Replay is a separate model: at 1,000 recorded sessions/day, five minutes each,
and an assumed compressed 0.2–2 MB/minute, uploads would be 30–300 GB/month and
14-day retained objects 14–140 GB. These byte rates are unmeasured placeholders.
GET/PUT counts, playback egress, archive copies and account-wide free allowances
change the price. Reserve an additional $5–20/month as a provisional low-volume
replay allowance, not a quote or an unlimited-usage promise; measure actual
recordings before approving it. Sampling 10% cuts the modeled recording volume
to one tenth, but must be an explicit product configuration, not silent loss.

All arithmetic was calculated with a script. Decimal GB and 30-day months are
used for workload illustrations; provider GiB/storage billing can differ.

## Establish the actual safe limit before launch

Existing [local measurements](2026-10-31-analytics-pipeline.md) passed 1,000
events/s for 60 seconds with 20-event batches on an M3 Pro/Docker Desktop setup.
They do not establish capacity on any candidate VPS, small-batch HTTP load,
replay, endurance or real storage durability during host loss.

1. Provision a short-term isolated candidate only after explicit authorization.
   Use production-like resource limits and disk durability settings, not broker
   dev-mode shortcuts. Keep the load generator off the measured VPS.
2. Seed representative retained data. Measure dashboard queries concurrently with
   ingestion and merges. Include backups/archive work and same-VPS PostgreSQL key
   lookups; test the final configuration, not only the earlier development mapper.
3. Ramp event rates and small-batch request rates independently through the
   expected 100/1,000-user patterns, then beyond them to find first failure.
   Repeat representative runs, add burst/retry/storage-recovery cases, and soak
   at normal load for hours. Verify generator capacity and zero dropped iterations.
4. Reconcile accepted event IDs with unique stored rows and acknowledged offsets;
   distinguish intentional overload retries from successful offered-load tests.
5. Publish a workload-specific capacity report, not a universal “users” limit.
   Set the initial operating ceiling at roughly half the lowest repeated passing
   throughput for the qualified workload, subject to latency/disk/retention limits.

Proposed initial qualification targets, not current guarantees: zero unreconciled
accepted events, no OOM/restarts, p95 ingestion acknowledgement under 500 ms,
p99 under two seconds, steady backlog age under five seconds and recovery from
the planned burst within two minutes. Adjust targets explicitly after baseline.

## Monitor and expand before saturation

Provisional alerts: workload at 60–70% of its qualified ceiling; sustained CPU
above 65–70%; low available RAM/OOM/swap pressure; disk at 60% warning and 70%
action; increasing disk latency; growing oldest source-record age; admission
refusals; and HTTP latency outside target. Trends and predicted disk-exhaustion
time matter more than one instantaneous sample. Include shared-CPU steal time.
These are planning thresholds, not implemented alarms or universal safe values.

Add host/container/disk and backlog-age collection before launch; current
ingestion/broker metrics and fixture lag sampling do not prove all production
signals exist. Capacity tests should produce these signals through Grafana.

Early scaling is usually a larger VPS. More containers on the same VPS do not
create resources. If ClickHouse merges/queries or disk I/O become the bottleneck,
move it to a separate host; add ingestion instances/load balancing only when that
layer is measured as constrained. Broker/metadata high availability is a separate
change from increasing throughput. Test again after each topology change.

OVH's US page states that upgrading requires a quick reboot, and downgrading
requires migration. Plan a maintenance/retry window: resizing the initial single
VPS is not zero-downtime scaling. Choose a region near the source applications
and existing Oregon S3 where practical, and check the actual Vercel API region.
