# GraphQL API change log

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

### Cache and migration contracts

- Data-owned Redis hashes remain read-only to GraphQL. GraphQL-shaped caches use
  `gql:v2:{season}:...` with explicit TTLs and malformed-value eviction.
- `PlayerValue:{date}` remains a shared hash; `PlayerValueMissing:{date}` is a
  coordinated 600-second marker.
- Only `migrations/forward` is applied by GraphQL's advisory-lock/checksum
  migration runner. Historical SQL remains under `migrations/legacy`.

Older entries below are historical context only and must not be replayed as
deployment instructions.
