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

GraphQL admission supports `legacy`, `shadow-v3`, and `enforce-v3` modes.
The versioned profile is `src/config/rate-limit/production.json`. v3 uses
Redis-time continuous token buckets, a global emergency request gate, isolated
Mini device/user and NAT-abuse buckets, workload-specific Web RSC budgets, and
an independent service budget. `enforce-v3` refuses to start until the profile
contains reviewed 300-concurrent capacity evidence with at least 40% headroom.

The three legacy-v2 limits remain environment variables only for compatibility
and rollback: `GRAPHQL_BROWSER_INGRESS_RATE_LIMIT`,
`GRAPHQL_AUTHENTICATED_RATE_LIMIT`, and
`GRAPHQL_ANONYMOUS_RATE_LIMIT`. Select the runtime with
`GRAPHQL_RATE_LIMIT_MODE=legacy|shadow-v3|enforce-v3`. The deploy workflow has
explicit persisted rollout profiles for P0, shadow, enforce, compatibility
restoration, and rollback; P0 captures the previous environment, image, SHA,
health, metrics, and container resource baseline before replacement.

Live manager headlines use the official FPL entry/Classic standings read-through.
When the official row is outside its freshness window, GraphQL returns an explicit
`UNAVAILABLE` score; it never substitutes a locally calculated manager total.
This cutover is forward-only: there is no manager-live local mode or rollback flag.
An unavailable or inconsistent official row is repaired by fixing the upstream
publication/read-through and re-serving the official value.

Redis keeps fourteen days of controlled-dimension aggregates and denied
12-character HMAC fingerprints. It never stores raw IPs, device IDs, tokens,
variables, or queries. Read the report with:

```bash
bun run rate-limit:report --days 2 --json
```

The five-minute monitor fails when actual interactive 429s exceed 1% or any
global 429 occurs and retains the non-sensitive report as a workflow artifact.
Run the capacity harness from an external load generator, with secrets supplied
only through its process environment. It executes the exact 180 Mini / 60 RSC /
45 signed-in / 15 compatibility-service model at 50, 100, 200, and 300
concurrency, the 10-second burst, the one-device abuse isolation check, and
five-minute higher-throughput probes that stop at the first failed level. The
report gates GraphQL 429 and non-429 errors, p95/p99, readiness, PostgreSQL pool
waiting, CPU, memory, NAT-peer isolation, and the required 40% headroom. It
derives `S` from the highest passing probe; profile generation has no manual
`S` override. `LOAD_SESSION_COOKIES_JSON` must contain 45 distinct
temporary test sessions; neither sessions nor signing credentials are written
to the report.

```bash
bun run rate-limit:load --output load-test/run-123.json
```

Required environment names are `LOAD_WEB_ORIGIN`, `LOAD_GRAPHQL_ORIGIN`,
`BACKEND_PROXY_SECRET`, `GRAPHQL_SERVICE_TOKEN`, `LOAD_METRICS_TOKEN`,
`LOAD_MEMORY_LIMIT_BYTES`, `LOAD_CPU_CORES`, and
`LOAD_SESSION_COOKIES_JSON`. Short-duration overrides are available for harness
smoke tests, but are not valid capacity evidence. After the full stepped run,
derive weighted workload rates from the matching structured v3 decision logs,
using a command that rejects failed runs and any 300-concurrent stage shorter
than fifteen minutes:

```bash
bun run rate-limit:observe \
  --load-report load-test/run-123.json \
  --logs load-test/run-123-graphql.jsonl \
  --output load-test/run-123-observation.json
```

Then generate the reviewed production profile from the measured sustainable
RPS embedded in that observation and the target traffic:

```bash
bun run rate-limit:profile --observation load-test/run-123-observation.json \
  --evidence load-test/run-123.json \
  --output src/config/rate-limit/production.json
```

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
