# Four-GiB memory redistribution — November 9

## Experiment

User authorized repeating generator isolation and testing a revised four-GiB
allocation. All runs use 100 singleton events/second for 300 seconds, one million
historical rows, the full concurrent analytical SQL workload, target CPUs 0,1 and
generator CPUs 2,3, HTTP 128 / eight metadata connections / 24 outstanding queries.
Diagnostics and workload code are the same for the baseline repeat and revised run.
Only the service memory distribution changes, as one allocation experiment with
three caps adjusted. Existing profiles/application/development defaults are retained.

| Allocation, MiB | Baseline | Revised |
| --- | --- | --- |
| Redpanda | 1280 | 1280 |
| ClickHouse | 1280 | 1536 |
| PostgreSQL | 256 | 128 |
| Valkey | 128 | 128 |
| Ingestion + processor | 512 | 384 |
| Host/operations reserve | 640 | 640 |
| Total | 4096 | 4096 |

Swap remains disabled. Node heaps, PostgreSQL shared buffers/max connections,
Redpanda internal memory and application gates are unchanged. Reduced donor caps
are experimental, based on observed headroom; absence of OOM in short runs is not
a production memory guarantee. Valkey remains idle and host reserve is an allowance,
not measured whole-guest memory. PostgreSQL donor-specific memory-pressure counters
are not collected; its Docker usage/lifecycle and query behavior are observed.

## Baseline repeat

`load capacity-4gb-db8-q24-generator`, report:
`test-results/load/2026-11-09T21-28-55.435Z-capacity-4gb-db8-q24-generator/result.json`.

Fails with 13 metadata-gate HTTP 503s, 29988 accepted/unique stored, final lag zero.
HTTP p95/p99 7.95/35.67 ms. No HTTP-admission refusals, event retries/rejections,
generator drops, detected OOM or restart; owned cleanup/lock release pass. Generator
separation alone therefore does not reliably eliminate refusals: the preceding
isolated run passed, but this fresh repeat fails.

ClickHouse max-limit events reach 15475, pressure `some/full` totals 1.982/1.655 s.
Its Docker-displayed peak is 1274.88 MiB; total target displayed peak 1702.66 MiB.
Metadata outstanding peak 24/24, ingestion loop-delay maximum 239.34 ms.

## Revised allocation, first run

`load capacity-4gb-db8-q24-rebalanced`, report:
`test-results/load/2026-11-09T21-35-04.912Z-capacity-4gb-db8-q24-rebalanced/result.json`.

Passes: 30001 accepted/unique stored, no refusals/retries/rejections/generator drops,
final source lag zero. HTTP p95/p99 7.81/23.19 ms; analytical SQL maximum 277.49 ms.
Metadata outstanding peak 14/24, ingestion loop-delay maximum 123.34 ms. All caps
and generator affinity verified, no detected OOM/restart; cleanup/lock release pass.

ClickHouse still hits its cap: 15239 max-limit events, pressure `some/full` totals
1.161/0.980 s. Last sampled cgroup current 1489.09 MiB of 1536; Docker-displayed
peak 1490.94 MiB. App peak 150.5 MiB of 384 and PostgreSQL 40.89 MiB of 128.
Summed displayed target peak 1909.25 MiB excludes guest OS/some cache and can miss
peaks. Larger cache use is expected with more allowance; lower total RAM usage
is not the experiment's goal. The cap still causes reclaim, without OOM.

First-run result is encouraging but does not establish causation or an optimum;
shared-host variation remains, and prior first passes did not always repeat.
A fresh confirmation run is in progress before deciding whether the result repeats.

## Verification

The allocation test and workload-profile test were each observed failing before
implementation. All 48 harness unit tests pass. The runner inspects actual caps,
swap/CPU affinity and lifecycle; the new profile is a separate Compose override.
Reports retain failed results as failed evidence. No production limits changed.
