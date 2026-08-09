# GraphQL API change log

## Data Platform v3 G1 — 2026-08-09

- Replaced Supabase Data API business reads with schema-qualified PostgreSQL 15
  readers over the Data-owned `fpl`, `competition`, and `reporting` contracts.
- Removed the Supabase dependency/env and all GraphQL-owned business migrations.
- Added a SELECT-only startup contract for exact v3 columns, publication
  version, current season, and read-only ACLs.
- Current season now comes only from `fpl.seasons.is_current`.
- Deployment runs `contract:check`; Data and Web remain the only schema owners.
- G1 is not a production cutover build. Revision-coherent Redis and query-cache
  changes follow in G2.

## Coordinated remediation — 2026-07-18

### Authentication

- GraphQL no longer initializes Better Auth or serves `/api/auth/*`.
- Website requests use a signed v2 envelope (`aud=letletme-graphql`, 60-second
  lifetime); Mini Program requests use web-issued hashed bearer sessions.
- Protected entry, league, tournament, and calculation operations require a
  verified FPL entry. `User.fplEntryVerifiedAt` is exposed for clients.
- `createWechatApiSession` is retained only as a deadline-gated legacy detector;
  issuance is disabled by default. Device issuance returns `410 Gone`.

### Request safety

- HTTP request bodies are capped at 256 KiB (`413 PAYLOAD_TOO_LARGE`).
- GraphQL requests enforce depth 10, five root fields, 20 aliases, 200 AST
  nodes, weighted complexity 500, and entry batches of 500
  (`400 QUERY_TOO_COMPLEX`).
- Redis-backed limits return `429 RATE_LIMITED`; security routes fail closed
  when the limiter is unavailable.
- Missing production season metadata and failed event metadata fallback return
  typed `503 CACHE_METADATA_UNAVAILABLE` errors.

### Live data and transfers

- Live totals use official FPL `total_points - official bonus + effective bonus`
  under the `LIVE_POINTS_V2` rollout flag.
- Historical baselines use event `N-1`; transfer history is ordered by the
  canonical `transfer_time` and includes every transfer.
- Live match reconciliation prefers real fixture IDs and never synthesizes
  event 39 matches.

### Historical cache and migration contracts

- Data-owned Redis hashes remain read-only to GraphQL. GraphQL-shaped caches use
  `gql:v2:{season}:...` with explicit TTLs and malformed-value eviction.
- `PlayerValue:{date}` remains a shared hash; `PlayerValueMissing:{date}` is a
  coordinated 600-second marker.
- The migration behavior described in this 2026-07-18 entry was retired by
  Data Platform v3 G1 and must not be used as current deployment guidance.

Older entries below are historical context only and must not be replayed as
deployment instructions.
