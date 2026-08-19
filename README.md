# letletme-graphql

Read-heavy Fantasy Premier League GraphQL API built with Bun, Apollo Server 5,
PostgreSQL 15, and Redis.

## Ownership contracts

- `letletme_data` is the only owner and writer of `fpl`, `competition`,
  `reporting`, `understat`, `bridge`, and `ops`.
- `letletme-web` is the authentication authority and the only writer of
  `bauth`.
- GraphQL owns query shaping, authorization, and the `llm:gql` Redis namespace.
  It does not own business migrations, reporting refreshes, or Data
  publications.
- PostgreSQL is the business source of truth. Redis contains validated Data
  publications, expiring query results, security counters, and queue state.
- Exactly one `fpl.seasons.is_current = true` row selects the current season.

## Request trust boundary

GraphQL accepts only:

- a short-lived Web-signed ingress plus an optional short-lived Web-signed user
  context;
- the Web public-RSC service token; or
- a Mini Program bearer inside verified signed ingress, validated against
  `bauth.mini_program_session`.

Unsigned direct requests, invalid bearer tokens, and malformed signed contexts
return `401`. GraphQL does not serve authentication routes or issue sessions.
`/api/device/auth` is not registered and returns the ordinary `404` response.

## Startup contract

Before opening a port, GraphQL performs `SELECT`-only checks that require:

- PostgreSQL 15 and every registered read model;
- exactly one current FPL season;
- exactly one active, canonical `fpl:core` publication;
- the exact `bauth` relations and column-level grants used by the service; and
- a dedicated login that inherits only `letletme_graphql_reader`, has no
  administrative attributes, and cannot mutate application schemas.

Publication validity is established by its exact field set, scope, item set,
keys, hashes, counts, and database read-model contract. It is not selected by a
generation label.

## Redis contracts

- Data publications: `llm:data:<dataset>:<scope>:...`
- Query cache: `llm:gql:<dataset-revision>:<query-name>:<args-hash>`
- Security counters: `llm:gql:security:rate:<scope>:<subject>`

Every query cache entry has a TTL. Understat is read from PostgreSQL and has no
GraphQL data cache.

## Local use

Copy `.env.example`, use a login that inherits `letletme_graphql_reader`, then:

```bash
bun install --frozen-lockfile
bun run contract:check
bun run dev
```

`DATABASE_POOL_MAX` defaults to `5` and accepts only `1` through `10`. Keep the production value at
`5` unless the shared PostgreSQL connection budget is deliberately rebalanced.

The service exposes:

- `POST /graphql` for trusted Web traffic;
- `GET /health` for PostgreSQL, both Redis clients, and current-season readiness; and
- `GET /metrics`, protected by `METRICS_TOKEN`.

Requests are bounded by body size, depth, root-field count, aliases, AST nodes,
weighted complexity, unique entry IDs, and Redis-backed rate limits.

GraphQL admission has two stages: a fixed-cost global plus browser-ingress
request gate before principal verification, followed by complexity-weighted
authenticated, anonymous, or shared-public admission. Defaults are 120 browser
requests/minute, 300 authenticated units/minute, 120 anonymous units/minute,
and a fixed 1200-unit shared public budget. The deploy-tunable values are
`GRAPHQL_BROWSER_INGRESS_RATE_LIMIT`, `GRAPHQL_AUTHENTICATED_RATE_LIMIT`, and
`GRAPHQL_ANONYMOUS_RATE_LIMIT`; every value must be a positive integer.

## Verification

```bash
bun run format:check
bun run lint
bunx tsc --noEmit
bun test
bun build src/index.ts --target bun --outdir /tmp/build-check
docker compose config --quiet
```

CI builds the accepted Data schema in PostgreSQL 15, installs the exact Web
auth read boundary, provisions a disposable read-only login, and runs the real
startup contract. GraphQL has no business migration command; Data schema
changes land in `letletme_data`, while `bauth` changes land in `letletme-web`.

`DATABASE_STATEMENT_TIMEOUT_MS` defaults to 12 seconds and must remain below
the Web proxy's 15-second upstream deadline. Rate-limit overrides should be
changed only with matching production traffic evidence; the versioned Redis
scopes intentionally do not reuse old counters.
