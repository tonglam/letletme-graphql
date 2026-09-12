# Database execution performance evidence

This note records the bounded read-path comparison required for the GraphQL
database executor change. It is evidence for the implementation review and is
not a production capacity claim.

## Run identity and method

- Baseline source: `b80289c6430b75d31a544da00f601625a351c395`.
- Candidate source: `0532c07123295b08af1b6dfd8e88392cc3770a89`.
- Bun: `1.4.0`; PostgreSQL: `15`; Redis and rate-limit Redis were separate
  loopback fixtures.
- Scenarios: Redis publication cache hit, PostgreSQL consistent-snapshot
  fallback, and Mini Program session authentication.
- Concurrency: 1 and 4; three rounds per scenario and concurrency; 30 warmup
  calls per case, then 100 measured calls per version per round.
- Baseline used the existing `pg` pool and candidate used the bounded
  Postgres.js slot pool. The candidate's read transaction includes `BEGIN READ
ONLY`, transaction-local `statement_timeout`, the business SQL, and
  `COMMIT`.
- The regression gate is the maximum per-round p95 increase against
  `max(30 ms, baseline p95 * 15%)`.

## Results

The table reports the median of the three round p95 values. `max delta` is the
largest candidate-minus-baseline p95 across the three rounds.

| Scenario                     | Concurrency | Baseline p95 (ms) | Candidate p95 (ms) | Max delta (ms) | Gate |
| ---------------------------- | ----------: | ----------------: | -----------------: | -------------: | ---- |
| Redis publication cache hit  |           1 |             0.299 |              0.315 |          0.018 | Pass |
| Redis publication cache hit  |           4 |             0.922 |              1.155 |          0.496 | Pass |
| PostgreSQL snapshot fallback |           1 |             5.987 |              7.408 |          1.421 | Pass |
| PostgreSQL snapshot fallback |           4 |             9.563 |             10.763 |          1.872 | Pass |
| Mini session authentication  |           1 |             0.210 |              0.645 |          0.456 | Pass |
| Mini session authentication  |           4 |             0.466 |              1.344 |          0.951 | Pass |

The run stayed below the configured regression gate for all 18
scenario/concurrency/round comparisons. The candidate deliberately performs more
SQL round trips for a read (100 baseline SQL calls versus 400 candidate SQL
calls per 100 measured fallback/auth calls in the harness), so the result also
exposes the transaction overhead instead of hiding it behind a cache.

## Limits of this evidence

The run is a local microbenchmark with fixture data. It does not prove remote
Supavisor latency, a full HTTP request budget, consumer rendering, a sustained
load target, or the planned 300-concurrent capacity. Those require the
candidate blue/green slot and the separate capacity work item; capacity remains
`validated: false` until that work produces evidence.

The raw rows, exact timestamps, and the repeatable harness used for this run
are kept with the visual review artifact:
`/Users/tong/.codex/visualizations/2026/09/12/01a09417-458b-7931-97a2-02531ddf0d7e/performance-evidence.json`
and `performance-probe.ts`.
