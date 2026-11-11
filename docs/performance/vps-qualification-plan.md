# VPS qualification plan — November 11

Plan only. No account, instance, purchase or spending is authorized by this document.
Prices are third-party listings checked November 11, 2026, not checkout quotes; verify
each on the provider's page before any approval.

## Goal

Updated 2026-11-11 with the user's launch requirements:

- **Load:** about 1 event per minute at launch; must handle **1 event per second**
  (≈86k/day, ≈7.8M rows over 90 days, close to the 9M-row dashboard test).
- **No lost events.** Brief ingestion unavailability is acceptable (one server); no
  accepted or browser-queued event may be lost. Always-available ingestion
  (second server + load balancer) is not required.
- **Known limits:** measure the chosen host's sustained and burst ceilings and alarm
  well before them, with a rehearsed upgrade step.
- **AWS:** the user's other services stay in AWS, so the host is EC2 in the same
  region. OVH, Hetzner and DigitalOcean are dropped.
- **Budget:** at most $50/month for the VPS. One dashboard viewer at a time.

### How "no lost events" is met on one server

- Browser SDK: unsent events persist in IndexedDB for 24 h (500 events / 1 MiB per
  browser) and retry, so planned downtime of minutes delays rather than loses them.
  Limitation: queued events are sent only when a page from the site is open again;
  a visitor who never returns within 24 h keeps them. A managed front door
  (API Gateway → SQS/S3) can remove this later; not decided.
- Server: an event is acknowledged only after Redpanda stores it on EBS; the ledger
  checks every accepted ID reaches ClickHouse. Host loss with intact EBS loses
  nothing; EBS loss falls back to the hourly backup (one-hour RPO).

## What local testing already tells us

| Finding | Evidence | Sizing consequence |
| --- | --- | --- |
| Memory fits 4 GiB with async inserts | ClickHouse 230–390 MiB under its 1.5-GiB cap; app ≤ 384 MiB | 4 GiB is the floor; 8 GiB gives ClickHouse cache and merge headroom (ClickHouse guidance: 8 GB minimum) |
| Ingestion is light | 100 EPS: all services ≈35% of one core on average, ≈63% at peaks | 2 cores cover launch ingestion with wide margin |
| ClickHouse queries are the CPU peak | One viewer + 100 EPS: ClickHouse up to ≈120% at peaks | 2 cores enough for one viewer; dashboard concurrency deferred |
| Retention deletes are cheap | ≈6 s of one core per 9M rows, ≤ every 4 h | Not a sizing driver at launch volume |
| Disk speed unmeasured | Mac SSD only | Must measure on each host (merges, TTL, backup/restore) |
| Long-run pass/fail unreliable locally | Docker-VM-wide stalls on the shared Mac | Only a real host can qualify endurance |

Evidence: [readiness runs](4gb-launch-readiness-nov11.md),
[dashboard](4gb-dashboard-90day.md), [async inserts](4gb-async-insert.md),
[backup drill](backup-restore-drill.md).

## Candidates

At 1 EPS the stack is mostly idle, so a burstable instance fits: it earns CPU credits
while quiet and spends them on dashboard queries, merges and retention deletes. EC2
also upgrades in place (stop → change type → start; same EBS volume and Elastic IP).

| Instance (Oregon, Graviton) | vCPU / RAM | Listed $/hour | ≈ $/month incl. 30 GB gp3 + IPv4 | Role |
| --- | --- | --- | --- | --- |
| t4g.medium | 2 / 4 GiB, 20% baseline per vCPU | ≈$0.034 | ≈$31 | **Primary candidate** |
| t4g.large | 2 / 8 GiB, 30% baseline per vCPU | ≈$0.067 | ≈$56 | First upgrade step (slightly over the ceiling) |
| m7g.large / c7g.large | 2 dedicated / 8 or 4 GiB | ≈$0.082 / ≈$0.073 | ≈$66 / ≈$60 | Later steps when sustained CPU is needed |

Prices are listings to verify; t4g.large was found only for us-east-1. The key
measurement is whether idle stack CPU plus 1 EPS stays below t4g.medium's baseline;
if it does, credits never drain.

Earlier non-AWS candidates and the full price survey remain in the git history of this
document and in [launch-cost-and-capacity](launch-cost-and-capacity.md).

## Phases

### A. Remote-run tooling (no spending; can start now)

The harness now runs targets and generator in one local Docker project. Add:

1. `infra/host/bootstrap.sh`: install Docker on a fresh Ubuntu LTS host (x86-64 or
   ARM64), clone a pinned commit, start the production-like stack (Redpanda with
   fsync, not dev-mode shortcuts), firewall to the operator IP, no public dashboards.
2. A remote-target mode for the capacity runner: target services on the VPS, k6
   generator on a separate machine (second small instance in the same region), so
   generator CPU never competes with the measured host. Sampling via SSH/cgroups.
3. Host probes saved with every run: `fio` disk random/sequential I/O, CPU steal
   (`/proc/stat`), CPU credit balance where applicable, kernel/OS, provider metadata.
4. A teardown checklist and a cost log (instance-hours × rate).

Verification: dry-run against a local Linux VM or container before any paid host.

#### Phase A status (2026-11-11)

Done and verified locally (commits 2869fdb … 6ca3a0f):

| Piece | Verification |
| --- | --- |
| Images (`infra/host/Dockerfile`) and `compose.production.yaml` | Built for ARM64; non-root; production-mode Redpanda; tested memory split |
| `secrets.sh`, `migrate.sh`, PostgreSQL TLS, restricted identities | `host smoke-local`: ingest → storage, restart, NOTIFY revocation over TLS, identity limits |
| `bootstrap.sh`, `verify.sh` | `host vm-test` in a Lima Ubuntu 24.04 VM: fresh bootstrap 92–94 s, idempotent re-run, reboot keeps the data disk mounted and events stored |
| Remote runner (`tests/host/remote-run.mjs`), sampler, seed, generator-side ledger | `remote-smoke` and `remote-ramp-short` on the VM pass; 9 unit tests |
| `probe.sh` (fio fsync/random/sequential, EC2 metadata) | Runs on the VM; summarized in long profiles |
| `backup.sh` + hourly timer, `restore.sh` | `host vm-backup`: restore matches the backup exactly, post-backup write absent, 14 s |

Deferred to the start of phase B, because they depend on how the trial resources
are created: the SSH/Session Manager transport, `resize.sh` (stop → modify →
start → verify), launch and tag-based teardown scripts, and the cost log.

### B. AWS trial on the candidate (uses credits; needs approval)

On t4g.medium with the full schema, 9M-row 90-day seed and one dashboard viewer:

| Step | Measures |
| --- | --- |
| Idle stack for 2 h, then 1 EPS for 4 h | CPU vs baseline, credit balance trend, memory, disk |
| Ramp 1 → 5 → 10 → 25 → 50 → 100 EPS until failure | **Sustained limit** (credits start draining) and **burst limit** (latency/ack/refusal failure) |
| Resize rehearsal t4g.medium → t4g.large while sending 1 EPS through the real SDK path | Downtime length; ledger shows zero lost events |
| Hourly incremental backup to S3 via an IAM role; restore onto a fresh instance | Backup/restore time at production size, RPO/RTO |
| Disk and steal probes | EBS latency, any steal time |

Generator on a separate small instance. Estimated cost: a few dollars of credits;
all resources tagged and terminated the same day.

### C. Launch host (full price; needs separate approval)

Launch the instance type the trial supports, from the phase-A bootstrap, with
monitoring and alarms in place before traffic: events/s at 60–70% of the measured
sustained limit, CPU credit balance falling, memory, disk at 60%/70%, source lag,
ingestion latency and refusals. The documented upgrade step is the rehearsed resize.

## Pass criteria (per host)

From the earlier [qualification proposal](launch-cost-and-capacity.md), unchanged:

- Zero accepted events missing; zero stored without an ingestion outcome (ledger).
- No OOM or restarts; ingestion p95 < 500 ms, p99 < 2 s; source lag stable and
  drained within 60 s after traffic; one-viewer dashboard page p95 < 2 s.
- Each profile passes twice. The published operating ceiling is half the lowest
  repeated passing rate.
- Restore at production size within the four-hour RTO; hourly incremental backup
  completes well inside an hour.
- Steal time and disk latency recorded and explained.

## Decisions and inputs needed from the user

Answered 2026-11-11: phase B approved (t4g.medium/t4g.large plus a small generator,
≤ $10 of credits, same-day teardown); credits expire in 182 days (about 2027-05-12);
off-host backups to S3 approved. The credits are on a **new, separate AWS account**
(Free plan), not the account holding the Identity Center profiles and the replay dev
bucket, so CLI access must be set up for it (profile `signaltrail-trial`).

Still open:

1. CLI access to the new account (`aws login --profile signaltrail-trial`).
2. Region: Oregon (`us-west-2`) is assumed. The replay dev bucket is in the other
   account, so the region is no longer forced by it.
3. Whether the $50 ceiling covers only the VPS, or also backups, S3 and snapshots.
4. Which account hosts production. A Free plan account closes when the plan ends
   (six months or credits used) unless upgraded to a paid plan, which keeps the
   remaining credits; joining an AWS Organization upgrades it automatically.
5. Later: approval for phase C on the chosen long-term provider.

## Risks

- Listed prices are third-party; get the AWS quote for the chosen region.
- Burstable credits: a sustained rise above baseline drains credits slowly; the
  credit-balance alarm, not CPU percent, is the early warning.
- A single host remains a single point of failure; the four-hour RTO depends on
  tested backups and a scripted rebuild (phase A bootstrap doubles as the rebuild).

Sources: [DoiT c7g.large us-west-2](https://www.doit.com/compute/spot/us-west-2/c7g.large),
[DoiT m7g.large us-west-2](https://www.doit.com/compute/spot/us-west-2/m7g.large),
[Hetzner 2026 changes (bitdoze)](https://www.bitdoze.com/hetzner-cloud-cost-optimized-plans/),
[Hetzner US CCX (DEV)](https://dev.to/m_maksimovic_/affordable-alternative-to-hetzner-for-us-companies-3ad9),
[OVHcloud US VPS](https://us.ovhcloud.com/vps/),
[OVHcloud 2026 pricing blog](https://us.ovhcloud.com/resources/blog/cloud-infrastructure-pricing-in-2026/),
[DigitalOcean droplets](https://www.digitalocean.com/pricing/droplets),
[Lightsail options](lightsail-options.md).
