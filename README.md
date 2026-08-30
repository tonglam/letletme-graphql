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
- Exactly one `fpl.seasons.is_current = true` row selects the current season;
  each non-health request pins that identity for its full execution.

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

`DATABASE_POOL_MAX` defaults to `2` and accepts only `1` through `2`. Production must use `1` or `2`
so the full-stack connection ceiling remains within the V2 release budget.

The service exposes:

- `POST /graphql` for trusted Web traffic;
- `GET /health/live` for liveness and `GET /health/ready` for PostgreSQL, both
  Redis clients, and current-season readiness; and
- `GET /metrics`, protected by `METRICS_TOKEN`.

Requests are bounded by body size, depth, root-field count, aliases, AST nodes,
weighted complexity, unique entry IDs, and Redis-backed rate limits.

GraphQL admission supports only the versioned `shadow-v3`, `enforce-v3`,
`shadow-v4`, and `enforce-v4` modes. There is no legacy request-count limiter,
legacy ingress class, or compatibility adapter. Supplying retired environment
variables or an old ingress envelope fails startup/request verification. v4 is
parallel to v3 and is not enabled by default. The versioned profile is
`src/config/rate-limit/production.json`. v3 uses Redis-time continuous token
buckets, a global emergency request gate, isolated Mini device/user and
NAT-abuse buckets, workload-specific Web RSC budgets, and an independent
service budget. `enforce-v3` refuses to start until the profile contains
reviewed 300-concurrent capacity evidence with at least 40% headroom. The v4
profile is `src/config/rate-limit/production-v4.json`; it adds separate Mini
anonymous/session aggregate ceilings and identity-plus-workload buckets. Its
aggregate ceilings must equal the sum of the workload buckets, and `enforce-v4`
refuses to start until generated capacity evidence is validated.

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
45 signed-in / 15 service model at 50, 100, 200, and 300 concurrency, the
10-second burst, the one-device abuse isolation check, and
five-minute higher-throughput probes that stop at the first failed level. The
report gates GraphQL 429 and non-429 errors, p95/p99, readiness, PostgreSQL pool
waiting, CPU, memory, NAT-peer isolation, and the required 40% headroom. It
derives `S` from the highest passing probe; profile generation has no manual
`S` override. `LOAD_SESSION_COOKIES_JSON` must contain 45 distinct temporary
test sessions; neither sessions nor signing credentials are written to the
report. Set `LOAD_INCLUDE_MINI_SESSIONS=true` and provide 45 distinct
temporary bearer tokens in `LOAD_MINI_SESSION_TOKENS_JSON` to run the Mini
anonymous/session mix required by v4 observation.

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

For a v4 capacity profile, run the loader with the Mini session mix enabled,
then use the v4 observation and profile commands:

```bash
bun run rate-limit:observe:v4 \
  --load-report load-test/run-123.json \
  --logs load-test/run-123-graphql.jsonl \
  --output load-test/run-123-v4-observation.json
bun run rate-limit:profile:v4 \
  --observation load-test/run-123-v4-observation.json \
  --evidence load-test/run-123.json \
  --output src/config/rate-limit/production-v4.json
```

Deploy the generated profile in `shadow-v4` first. The monitor must observe a
full 24-hour window covering production peak, with zero storage failures and
global would-deny, no more than 1% organic Mini workload would-deny, and zero
player-stats would-deny before `enforce-v4` is considered.

## Blue/green deployment

GraphQL runs two immutable Compose projects: `letletme_graphql_blue` on local
port 4000 and `letletme_graphql_green` on local port 4002. VPS Ops owns the
Nginx active-slot include and root-only switch helper. A candidate is promoted
only after readiness, schema, revision, and public proxy probes pass; a failed
public probe switches back to the previous slot without rebuilding it. Images
are addressed by their exact commit and digest, never by `latest` as an input.

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
