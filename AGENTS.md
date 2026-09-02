# Repository Instructions

## Repository profile

- `letletme-graphql` is a read-heavy Bun/TypeScript GraphQL runtime built on Apollo Server, `graphql`, PostgreSQL through `pg`, and Redis through `ioredis`. It is not a business-data writer, migration repository, identity provider, or general REST backend.
- Preserve the request path: `src/bootstrap.ts` owns HTTP lifecycle and admission; `src/http` contains transport/security/rate-limit policy; `src/infra` contains database, Redis, ingress, metrics, and Data clients; `src/graphql` composes schema/runtime policy; `src/domains/<domain>` owns schema, resolver, service/read-model, and repository code for one product domain.
- `src/infra` and `src/http` must not import `src/domains` or `src/index.ts`; keep composition pointing inward and verify it with `bun run layers:check`. Keep resolvers thin and put reusable shaping/reads in the domain service or repository.
- Data owns `fpl`, `competition`, `understat`, `bridge`, `reporting`, `ops`, Data publications, and business migrations. Web owns authentication, sessions, and `bauth`. GraphQL owns authorization, query shaping, read-only access, root-field policy, and `llm:gql:*` query/security state.

## Trust, data, and schema invariants

- Every non-health request must pin the single PostgreSQL current-season authority for its execution. Startup fails closed on catalog/read-model drift, missing or invalid active Data publication, incorrect `bauth` grants, or a runtime login broader than `letletme_graphql_reader`.
- Accept only the existing trusted request classes: Web-signed ingress with optional signed user context, Web public-RSC service token, or a Web-issued Mini bearer inside verified signed ingress. Do not accept unsigned direct GraphQL, cookie fallback, self-issued sessions, or client bypass of the Web proxy.
- Protected fields authorize the resolved principal and verified entry/tournament relationship, not caller-supplied IDs alone. Preserve explicit public exceptions narrowly; a new root field must declare its auth class and rate-limit budget in executable policy.
- PostgreSQL is business truth. Data Redis publications are accepted only as complete, field-exact, revision-coherent units; reject corrupt/partial candidates and use only a coherent PostgreSQL fallback. GraphQL may request narrowly defined producer work through existing authenticated Data clients, but must not write Data tables, run DDL, or repair Data Redis directly.
- Keep the primary publication/query-cache Redis and rate-limit Redis isolated. Query-cache keys must include the Data revision and arguments and always have a TTL. Do not create a GraphQL Understat business cache or let a query cache become source of truth.
- A schema/root-field change must update `src/graphql/schema.ts`, `src/graphql/domain-manifest.ts`, root-field authorization and rate-limit registries, generated documentation, focused domain tests, and affected Web/Mini operations. Do not add compatibility aliases or retired fields without an explicit cross-client contract decision.
- Keep `DATABASE_STATEMENT_TIMEOUT_MS` below the Web proxy deadline. Timeout, pool, complexity, or rate-limit changes require measured query/load evidence; short harness runs are smoke diagnostics, not production capacity proof.

## Work and validation

- Inspect `git status --short --branch`, `origin/main` divergence, and occupied worktrees before editing. Preserve unrelated WIP; do not update a behind checkout or move another worktree merely to edit instructions.
- Use the Bun version pinned by `packageManager`/CI and `bun.lock`; install with `bun install --frozen-lockfile`. Compare `bun --version` before broad gates and keep local-version evidence distinct from CI evidence.
- Start with a focused `bun test <test-file>`. Normal gates are `bun run format:check`, `bun run lint`, `bun run typecheck`, `bun run layers:check`, `bun run docs:check`, `bun run deprecation:check`, and `bun test` as justified by the change.
- This repository has no `build` script and no migration command. Use the checked CI build form `bun build src/index.ts --target bun --outdir <temporary-dir>` when build evidence is required. Run `bun run contract:check`, `bun run data:contract:check`, and `bun run redis:check` only with their documented PostgreSQL/Redis fixtures and read-only login contract.
- Use `$letletme-graphql-read-path` for ingress, auth, schema/domain, read-model, publication/fallback, cache, or rate-limit work. Use `$letletme-stack-audit` when a behavior or contract crosses Data/Web/Mini/Ops, and `$letletme-release-acceptance` for an authorized end-to-end release.
- Deployment uses immutable blue/green slots and the checked-in remote deploy workflow. Liveness is not acceptance: verify exact image/SHA, `/health/ready`, startup/database contract, trusted public query, relevant revision, and representative Web/Mini behavior.
- Never log or retain tokens, signed envelopes, cookies, bearer values, raw identities, variables, full queries, IPs, or production connection strings. Preserve existing fingerprints and controlled-dimension observability.
