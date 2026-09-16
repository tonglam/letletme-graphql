# Public entry transfer-history rate-limit evidence

This note records the read-only workload evidence used to set the
`entryTransferHistory` root-field floor to 215 units. It supports the executable
registry in `src/graphql/limits.ts`; it is not a sustained capacity claim.

## Run identity and method

- Run date: 2026-09-16 (UTC).
- Dataset revision: `7808`.
- High-fanout public entry: `702902`, selected with a read-only Data Platform
  query. It had 94 transfer rows spanning three events (events 2 through 4).
  The current dataset is at GW4, so no mature-season entry is available for a
  direct 38-event measurement.
- Operations: `entryTransferHistory` (the normal history projection) and
  `entryTransferHistory_live` (`live: true`, including live transfer fields).
- Samples: 20 per operation, each on a fresh revisioned cache namespace, with a
  30-second per-sample timeout. All 40 samples completed successfully.
- Redis was accessed through the benchmark's read-only proxy; cache writes and
  deletes were simulated and did not reach the configured Redis store. The
  PostgreSQL query used for fan-out discovery and the GraphQL reads were
  read-only.

The benchmark command is `scripts/benchmark-queries.ts` with
`BENCHMARK_QUERY_FILTER`, `BENCHMARK_FRESH_CACHE=true`, and
`BENCHMARK_ENTRY_ID=702902`. The raw JSON reports were written outside the
repository during the run:

- `/tmp/graphql-transfer-benchmark-history-heavy-4e138ca.json`
- `/tmp/graphql-transfer-benchmark-live-heavy-4e138ca.json`

## Results

| Operation | Samples | Median (ms) | p95 (ms) | Maximum (ms) | Successful |
| --- | ---: | ---: | ---: | ---: | ---: |
| `entryTransferHistory` | 20 | 370.1 | 380.4 | 380.6 | 20/20 |
| `entryTransferHistory_live` | 20 | 1,063.1 | 1,123.3 | 1,323.5 | 20/20 |

The live projection is the dominant path. The resolver now fails closed when
source data contains more than 38 distinct events, the FPL regular-season
bound. This explicit bound prevents a malformed or cross-season read from
turning the live enrichment loop into an unbounded workload. The current
three-event run is an interim `n=20` measurement for admission sizing; a
formal p95 capacity profile still requires the separate 100-sample production
environment run.

## Floor derivation

The current Mini public weighted buckets refill at 10 units/second for an
anonymous device and 15 units/second for a session. The measured three-event
live p95 is 1.1233 seconds. Pricing the measured path across the explicit
38-event season bound gives this conservative upper-bound tier:

```text
ceil(max(10, 15) * 1.1233 * (38 / 3) / 5) * 5 = 215 units
```

This uses the observed worst path as a per-event upper-bound proxy and rounds
up to the next existing five-unit tier. One season-sized `live=true` read can
therefore consume the measured heavy path's admission budget instead of being
repeated at the ordinary one-request cost. The value is asserted by the
GraphQL limit and governance manifest tests, and the generated domain manifest
records the same 215-unit budget. Re-run the benchmark with mature-season data
and update the bound, registry, and this note together when the transfer query
shape, dataset fan-out, or public bucket policy changes.

## Boundaries

The run does not prove sustained throughput, database capacity, or end-to-end
Mini rendering. It also does not mutate production Redis, rate-limit buckets,
or Data publication state. Anonymous and authenticated consumer flows still
require the coordinated Web proxy and Mini verification after deployment.
