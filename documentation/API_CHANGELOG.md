# GraphQL API change log

## Data Platform v3 plan 3.2.5 — 2026-08-09

- Advanced the fail-closed database and Redis publication contract to plan
  `3.2.5` after the Data core-cache publisher's least-privilege preflight was
  corrected. A stale 3.2.4 database or Redis pointer cannot serve this build.

## Data Platform v3 G2 — 2026-08-09

- Locked startup and Redis publication parsing to the exact Data contract:
  schema `v3`, plan `3.2.5`, and an RFC-shaped publication UUID. Missing or
  stale contract metadata fails closed.
- Added strict typed readers for the immutable core and live Data publications.
  Invalid Redis revisions fall back as a whole to one coherent PostgreSQL
  statement; individual items are never mixed across sources or revisions.
- GraphQL query caches now include GraphQL schema version plus the pinned Data
  revision and use fixed 10/60/300/3600-second policy classes.
- Removed legacy live scoring, aggregate-cache, reporting-view, and RPC
  compatibility paths. Live scoring has one canonical implementation.
- Redis query-cache failures are best-effort; PostgreSQL remains authoritative.

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

- Live totals used official FPL
  `total_points - official bonus + effective bonus`; Data Platform v3 later
  made that the only implementation and removed its rollout path.
- Historical baselines use event `N-1`; transfer history is ordered by the
  canonical `transfer_time` and includes every transfer.
- Live match reconciliation prefers real fixture IDs and never synthesizes
  event 39 matches.

### Historical cache and migration contracts

- Data-owned Redis hashes remained read-only to GraphQL. GraphQL-shaped caches
  used the now-retired season-keyed namespace with explicit TTLs and
  malformed-value eviction.
- At that date, `PlayerValue:{date}` was a shared hash and
  `PlayerValueMissing:{date}` was a coordinated 600-second marker. Both keys are
  retired by Data Platform v3 and are not read by current GraphQL code.
- The migration behavior described in this 2026-07-18 entry was retired by
  Data Platform v3 G1 and must not be used as current deployment guidance.

Older entries below are historical context only and must not be replayed as
deployment instructions.
