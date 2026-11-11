# VPS qualification plan — November 11

Plan only. No account, instance, purchase or spending is authorized by this document.
Prices are third-party listings checked November 11, 2026, not checkout quotes; verify
each on the provider's page before any approval.

## Goal

Choose the long-term single host for ingestion, processor, PostgreSQL, Redpanda,
ClickHouse and Valkey within the **$50/month VPS ceiling**, and publish a measured
operating limit for the launch workload: 10–50 active users (≈1–5 EPS), one dashboard
viewer, bursts toward 100 EPS. Dashboard/demo stay on Vercel; backups go off-host.

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

| Host | vCPU / RAM / disk | Listed $/month | CPU type | Notes |
| --- | --- | --- | --- | --- |
| OVHcloud US VPS-2 | 4–6 vCores / 8–12 GB / 75–100 GB NVMe | ≈$8.50–12 (some listings need 12-month upfront) | Shared | Most RAM per dollar; verify month-to-month price, term and steal time |
| OVHcloud US VPS-3 | 6–8 vCores / 12–24 GB / 100–200 GB NVMe | ≈$12–28 (listings conflict) | Shared | Strong long-term candidate if month-to-month and steady |
| AWS Lightsail compute-optimized Large | 2 / 4 GB / 160 GB | $42 (Nov 9) | Baseline unclear | Fits budget; verify sustained CPU terms |
| Hetzner CCX13 (Ashburn/Hillsboro) | 2 dedicated / 8 GB | ≈$51 after June 2026 increase | Dedicated | At/over the ceiling; ~1 TB US traffic included |
| DigitalOcean CPU-optimized | 4 / 8 GB | ≈$84 | Dedicated | Over budget; reference only |
| AWS EC2 c7g.large (Oregon) | 2 / 4 GB + EBS | ≈$0.0725/h ≈ $53 + disk | Dedicated (Graviton) | Trial reference matching the local 4-GiB/2-CPU plan; over budget long-term |
| AWS EC2 m7g.large (Oregon) | 2 / 8 GB + EBS | ≈$0.0816/h ≈ $60 + disk | Dedicated (Graviton) | Trial reference for the 8-GB case |

Burstable plans (t4g, Lightsail general purpose) are excluded as long-term hosts:
their sustained CPU is a fraction of each vCPU unless extra is paid, and our load is
steady. They may be measured only to document that limit.

Shared-vCore hosts (OVH) are cheap but other tenants can take CPU ("steal"). That is
exactly what qualification must measure before choosing one.

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

### B. AWS reference trial (uses credits; needs approval)

Purpose: measure the same workload on known, dedicated 2-vCPU hardware to separate
"too few resources" from "noisy Mac", and calibrate the cheaper shared hosts.

| Run on c7g.large (then m7g.large if memory-limited) | Duration |
| --- | --- |
| Smoke and 100 EPS (`capacity-4gb-memory-trace-async`), twice | 2 × 15 min |
| Dashboard endurance with TTL | 30 min |
| Launch-rate soak (5 EPS) and 50 EPS soak | 2 h each |
| Five-viewer burst (reference only) | 10 min |
| Backup/restore at production size (9M rows) | ≈30 min |
| Disk and steal probes | 10 min |

Estimated cost: two hosts × ≈12 h × ≈$0.08 + generator t4g.small + ≈50 GB gp3 for a
day + snapshot/S3 traffic ≈ **under $10 of credits**. All resources tagged and
terminated the same day; cost log recorded.

### C. Long-term candidate (full price; needs separate approval)

Run the same matrix on the cheapest candidate that the AWS reference suggests can
pass (likely an OVH VPS-3-class host on month-to-month billing). Then a 24-hour soak
at launch rate with dashboard and hourly backups before committing.

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

1. Approval for phase B on the AWS account: instance types, ≤ $10 of credits, same-day
   teardown. Plus CLI access (`aws login` or credentials) and the credit expiry date.
2. Region: Oregon (`us-west-2`) is assumed, because the existing S3 bucket is there.
   Confirm or choose a region near the source applications.
3. Whether the $50 ceiling covers only the VPS, or also backups, S3 and snapshots.
4. Approval for off-host backups to S3 (from the backup drill).
5. Later: approval for phase C on the chosen long-term provider.

## Risks

- Listed prices conflict and changed in 2026 (Hetzner, OVH increases). Get quotes.
- Shared-vCore hosts can pass a short trial and degrade later; the 24-hour soak and
  steal monitoring reduce, but do not remove, that risk.
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
