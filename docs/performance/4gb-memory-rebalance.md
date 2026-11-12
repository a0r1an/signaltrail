# Four-GiB memory redistribution — November 9

## Experiment

User authorized repeating generator isolation and testing a revised four-GiB
allocation. All runs use 100 singleton events/second for 300 seconds, one million
historical rows, the full concurrent analytical SQL workload, target CPUs 0,1 and
generator CPUs 2,3, HTTP 128 / eight metadata connections / 24 outstanding queries.
Diagnostics and workload code are the same for the baseline repeat and revised run.
Only the service memory distribution changes, as one allocation experiment with
three caps adjusted. Existing profiles/application/development defaults are retained.

| Allocation, MiB         | Baseline | Revised |
| ----------------------- | -------- | ------- |
| Redpanda                | 1280     | 1280    |
| ClickHouse              | 1280     | 1536    |
| PostgreSQL              | 256      | 128     |
| Valkey                  | 128      | 128     |
| Ingestion + processor   | 512      | 384     |
| Host/operations reserve | 640      | 640     |
| Total                   | 4096     | 4096    |

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
A fresh confirmation run also passes, as recorded below.

## Verification

The allocation test and workload-profile test were each observed failing before
implementation. All 48 harness unit tests pass. The runner inspects actual caps,
swap/CPU affinity and lifecycle; the new profile is a separate Compose override.
Reports retain failed results as failed evidence. No production limits changed.

## Revised allocation confirmation

Fresh report:
`test-results/load/2026-11-09T21-41-43.622Z-capacity-4gb-db8-q24-rebalanced/result.json`.

Passes again: 30001 accepted/unique stored, zero HTTP/metadata/publisher refusals,
retries/rejections/generator drops and final source lag zero. HTTP p95/p99
7.20/17.62 ms. Metadata outstanding peak 14/24; loop-delay maximum 121.96 ms.
Actual target memory/swap/CPU limits and generator placement verified. No detected
OOM/restart; all owned resources removed and load lock released.

ClickHouse max-limit events reach 15497, pressure `some/full` totals 1.029/0.835 s.
Docker-displayed individual peaks: ClickHouse 1502.21 MiB of 1536, app 155.1 MiB
of 384, PostgreSQL 39.93 MiB of 128. Summed displayed target peak 1927.61 MiB;
this excludes guest OS/some cache and can miss brief peaks.

| Measurement                                    | Original allocation repeat | Revised 1     | Revised 2     |
| ---------------------------------------------- | -------------------------- | ------------- | ------------- |
| Result                                         | Fail                       | Pass          | Pass          |
| Metadata HTTP 503s                             | 13                         | 0             | 0             |
| Accepted / unique stored                       | 29988 / 29988              | 30001 / 30001 | 30001 / 30001 |
| HTTP p99, ms                                   | 35.67                      | 23.19         | 17.62         |
| Peak outstanding metadata queries              | 24                         | 14            | 14            |
| ClickHouse memory-pressure some total, seconds | 1.982                      | 1.161         | 1.029         |
| ClickHouse max-limit event count               | 15475                      | 15239         | 15497         |

### Working conclusion

The revised distribution is the more promising local experimental allocation:
two fresh five-minute 100-EPS zero-refusal trials, without observed OOM/restarts
in the reduced donor budgets. Retain it as the named comparison profile, not a
production default or certified host size. Shared-host variation, sequential order
and limited duration prevent a causal/optimality claim; the original generator-
isolated allocation itself had one pass before this failed repeat.

The larger ClickHouse cap does not eliminate reclaim or max-limit events. Similar
event counts with lower pressure duration show why those counts alone are not
failure counts or a latency metric. Cache/memory utilization can expand to fill
the allowance. Two short passes do not qualify retention, maintenance/backup
pressure, replay, idle Valkey becoming active, OS reserve or burst-credit limits.

Next: use the revised profile for longer retained-data/maintenance measurements
and targeted CPU/GC observation; qualify the actual candidate host before purchase/
production claims. No paid target, deployment or production defaults are approved.

## Longer follow-up supersedes the short-pass inference

The subsequent 30-minute offered 100-EPS run fails with an analytical ClickHouse
memory rejection, later HTTP/metadata refusals, latency and generator drops.
Its sampling loop also stops on the analytical failure, so it cannot establish
continuous full-query endurance. See [endurance evidence](4gb-endurance.md).
Retain the short passes as evidence of those trials, not stable capacity.
