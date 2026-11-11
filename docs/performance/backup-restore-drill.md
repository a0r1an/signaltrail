# Local backup and replacement-host restore drill — November 11

```sh
./scripts/signaltrail-ops.mjs load backup-restore
```

Objectives (OPEN_QUESTIONS): four-hour RTO, best-effort one-hour RPO. This drill is
local and isolated: a shared Docker volume stands in for off-server storage. Sending
backups to S3 needs user approval and is not done.

## Procedure exercised

1. Primary ClickHouse with the full schema (001–004): 200,000 time-ordered rows with
   identity links, plus pipeline-written link/view events and a replay.
2. Primary PostgreSQL: tracked migrations 001–003, a bootstrapped owner,
   organization, project and key, and a scoped read role with a grant.
3. `BACKUP DATABASE signaltrail TO File(full)`; 50,000 more rows and new links;
   `BACKUP ... TO File(incremental) SETTINGS base_backup = File(full)`;
   `pg_dump -Fc`. Fingerprints are taken here: per-project row counts and
   `sum(cityHash64(*))` over `FINAL` for events and links, table/view definitions,
   and per-table count + md5 for every control-plane and migration table.
4. Writes after the backup (the RPO window): one event and one organization.
5. Replacement host: empty ClickHouse and PostgreSQL containers are started. Roles
   and users are provisioned first, as an operator would; they are cluster-level
   and not in the backups. Then `RESTORE DATABASE ... FROM File(incremental)` and
   `pg_restore --exit-on-error`.
6. Checks: fingerprints equal; post-backup writes absent; the restored host accepts
   writes from an insert-only processor user; the links view still fires;
   a select-only reader resolves three anonymous IDs to one visitor.

## Result — passed

Report: `test-results/load/*-backup-restore/backup-restore.json` (first pass
2026-11-11).

| Measurement | Value |
| --- | --- |
| ClickHouse full / incremental backup | 0.05 s, 10.2 MB / 0.02 s, 2.6 MB |
| pg_dump / pg_restore | 0.22 s / 0.37 s |
| ClickHouse restore | 0.04 s |
| Replacement start → verified (includes container start) | 6.4 s |
| Restored events / links | 250,004 / 5,002 (all projects match) |

Findings captured in the fixture:

- The shared backup volume starts root-owned; ClickHouse writes as `clickhouse`.
  Production destinations (S3 or a disk) need the same ownership or credential check.
- The image's `CLICKHOUSE_DB` creates an empty `signaltrail` database; the runbook
  drops it, after asserting it is empty, before `RESTORE`.
- The links view runs as its definer (`signaltrail`), which must exist on the
  replacement before restore.

## Limitations

- Small dataset: timings do not predict a 9M-row or multi-GB restore, or S3
  transfer time. A drill on the candidate VPS with production-size data is needed
  before claiming the RTO.
- No scheduler, retention of backup sets, encryption, or off-host copy yet; the
  hourly incremental cadence for the RPO is not automated.
- The Redpanda backlog is not backed up. Events accepted but not yet processed at
  failure time depend on the broker volume or the planned raw-event archive.
