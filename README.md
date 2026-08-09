# letletme-graphql

Read-heavy Fantasy Premier League GraphQL API built with Bun, Apollo Server 5,
PostgreSQL 15, and Redis.

## Ownership contracts

- `letletme_data` is the only owner and writer of `fpl`, `competition`,
  `reporting`, `understat`, `bridge`, and `ops`. GraphQL reads the schema-qualified
  Data Platform v3 contract through a dedicated read-only PostgreSQL login.
- `letletme-web` is the sole authentication authority and writer of `bauth`.
  Website requests use a signed, 60-second `v=2` envelope; Mini Program clients
  use Web-issued hashed bearer sessions.
- GraphQL owns query shaping, authorization, and its own Redis query cache. It
  does not own business tables, migrations, reporting refreshes, or Data
  publications.
- Exactly one `fpl.seasons.is_current = true` row is the season authority. Time
  and Redis are not season authorities.

This G1 branch completes the schema-qualified PostgreSQL reader cut. The typed
Data Redis publication reader and revision-keyed GraphQL cache are introduced
by the following G2 branch; G1 is not a standalone production cutover target.

## Startup contract

Before opening a port, GraphQL performs `SELECT`-only checks that require:

- PostgreSQL 15 Data Platform v3 relations and columns used by every reader;
- exactly one current FPL season;
- exactly one active `fpl:core` publication with schema `v3` and plan `3.2.5`;
- a runtime login with schema usage and relation select privileges, but no
  unsafe role attributes, schema create privilege, or write privilege on any
  Data-owned relation.

Any mismatch fails startup. Deployment runs `bun run contract:check`; it never
creates, alters, drops, or migrates business objects.

## Local use

Copy `.env.example`, use a login that inherits `letletme_graphql_reader`, then:

```bash
bun install --frozen-lockfile
bun run contract:check
bun run dev
```

The server exposes:

- `POST /graphql` (internal service endpoint; public clients use the Web proxy)
- `GET /health` (503 when PostgreSQL, Redis, or current-season metadata fails)
- `GET /metrics` (requires `METRICS_TOKEN`)

Authentication is validation-only in GraphQL. `/api/auth/*` is absent and
`/api/device/auth` returns 410. Only verified FPL entry IDs authorize
entry-scoped operations.

Requests are limited by payload size, depth, root-field count, aliases, AST
nodes, weighted complexity, and unique entry IDs. Admission and weighted rate
limits fail closed when Redis is unavailable.

## Verification

```bash
bun run format:check
bun run lint
bunx tsc --noEmit
bun test
bun build src/index.ts --target bun --outdir /tmp/build-check
docker compose config --quiet
```

CI checks out the accepted `letletme_data` contract at
`cb49317ad04ac9a1a727f079acacfb12493a0004`, replays it twice into a disposable
PostgreSQL 15 database, creates a read-only runtime login, and runs the real
startup contract. There is no duplicated GraphQL schema fixture.

## Database changes

GraphQL has no business migration directory or migration command. Changes to
Data-owned schemas land and are accepted in `letletme_data` first. Changes to
`bauth` land in `letletme-web`.

## Rollback-sensitive settings

- `LEGACY_AUTH_VALIDATION_UNTIL=`: a bounded deadline for validation of already
  issued legacy WeChat/device tokens; empty disables that path.
- `TRUSTED_PROXY_HOPS=0`: use the direct peer unless a proxy chain is explicitly
  reviewed.
- `REQUIRE_SIGNED_WEB_INGRESS=false`: compatibility setting until every Web and
  Mini Program caller satisfies the signed-ingress contract.

Never extend a legacy validation deadline without a recorded rollback decision.
