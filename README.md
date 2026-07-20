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

- `POST /graphql`
- `GET /health` (503 when PostgreSQL, Redis, or `Season:active` is unavailable)
- `GET /metrics` (requires `METRICS_TOKEN`)

Requests are limited to 256 KiB, depth 10, five root fields, 20 aliases, 200
AST nodes, weighted complexity 500, and entry batches of 500. Rate limits are
120 GraphQL requests/minute/IP and 5 legacy session attempts/minute/IP.

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
  signed ingress envelope, set true so any request carrying a website user
  envelope must also carry a valid 60-second opaque ingress subject.

Never enable legacy issuance or extend the validation deadline without a
recorded rollback decision.
