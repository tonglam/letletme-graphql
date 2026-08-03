# letletme-graphql

Read-heavy Fantasy Premier League GraphQL API built with Bun, Apollo Server
5.5.1, PostgreSQL/Supabase, and Redis.

## Ownership contracts

- `letletme-web` is the sole authentication authority and sole owner of the
  `bauth` schema. Website requests use a signed, 60-second `v=2` envelope with
  `aud=letletme-graphql`; Mini Program clients use web-issued hashed bearer
  sessions.
- Only verified FPL entry IDs authorize entry-scoped operations.
- Legacy GraphQL WeChat and device tokens are validation-only until the
  explicit `LEGACY_AUTH_VALIDATION_UNTIL` deadline. Issuance is disabled by
  default. `/api/auth/*` is absent and `/api/device/auth` returns 410.
- `letletme_data` owns domain tables and shared positive Redis hashes. GraphQL
  reads those keys but never rebuilds them. GraphQL-shaped and negative caches
  live under `gql:v2:{season}:...`, except the coordinated
  `PlayerValueMissing:{date}` marker.

## Local use

```bash
bun install --frozen-lockfile
bun run dev
```

The server exposes:

- `POST /graphql` (internal service endpoint; clients use
  `https://www.letletme.top/api/graphql`)
- `GET /health` (503 when PostgreSQL, Redis, or `Season:active` is unavailable)
- `GET /metrics` (requires `METRICS_TOKEN`)

Requests are limited to 256 KiB, depth 10, five root fields, 20 aliases, 200
AST nodes, weighted complexity 600, and 500 unique entry IDs. Duplicate entry
IDs are rejected before resolver work. Rate limits are weighted: signed client
subjects receive 120 units/minute, cached public Web reads receive 600
units/minute, and legacy session attempts retain a separate five/minute limit.
All GraphQL limits fail closed when Redis is unavailable.
During compatibility mode, credential-bearing direct traffic first passes a
separate 120-request/minute admission bucket keyed by a non-logging credential
fingerprint or validated principal. Protected requests are authorized before
weighted charging, and validated legacy users receive distinct weighted
subjects instead of sharing a network bucket. Anonymous public reads skip the
credential-validation admission bucket.

## Verification

```bash
bun run format:check
bun run lint
bunx tsc --noEmit
bun test
bun build src/index.ts --target bun --outdir /tmp/build-check
docker compose config --quiet
```

## Migrations

`letletme_data` bootstraps domain tables, `letletme-web` migrates `bauth`, and
this repository applies only `migrations/forward`. The runner uses an advisory
lock, per-file SHA-256 checksums, and a transaction per migration.

```bash
bun run migrate
bun run migrate:status
```

Historical scripts are retained under `migrations/legacy` and are never
replayed into fresh databases. See [migrations/README.md](migrations/README.md)
and [docs/ROLLOUT.md](docs/ROLLOUT.md).

## Rollback-sensitive flags

- `LIVE_POINTS_V2=false`: shadow compare official-total scoring before enabling.
- `LEGACY_WECHAT_ISSUANCE_ENABLED=false`: emergency-only rollback switch; keep
  false after the web Mini Program release.
- `LEGACY_AUTH_VALIDATION_UNTIL=`: exact dual-verifier deployment timestamp plus
  30 days; empty disables old WeChat and device token validation.
- `TRUSTED_PROXY_HOPS=0`: use the direct peer unless the deployment has an
  explicitly reviewed proxy chain.
- `REQUIRE_SIGNED_WEB_INGRESS=false`: compatibility phase. After web emits the
  signed ingress envelope, cached public reads send `GRAPHQL_SERVICE_TOKEN`,
  and the accepted Mini Program release has seven days of zero unsigned
  traffic, set true. Enforced mode rejects every request without either a
  valid 60-second ingress signature or the service token.

Never enable legacy issuance or extend the validation deadline without a
recorded rollback decision.
