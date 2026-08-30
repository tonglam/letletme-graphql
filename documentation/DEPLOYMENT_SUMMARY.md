# Deployment summary

This repository is the read-heavy GraphQL runtime. `letletme_data` owns every
Data Platform business schema and publication; `letletme-web` owns `bauth`.

## Runtime contract

- Bun, Apollo Server 5, PostgreSQL 15, and Redis.
- `POST /graphql`, `GET /health/live`, `GET /health/hot`, `GET /health/ready`, and token-protected
  `GET /metrics`.
- `/health/live` proves only process liveness. `/health/hot` covers the
  Redis/current-season serving path so a PostgreSQL outage does not remove a
  live-points-capable instance. `/health/ready` is strict and is ready only
  when PostgreSQL, the current-season authority, the publication/cache Redis
  client, and the isolated rate-limit Redis client all answer within the
  bounded probe window.
- `/health` is intentionally not exposed; monitors must use `/health/ready`.
- `DATABASE_STATEMENT_TIMEOUT_MS` defaults to 12 seconds and must stay below
  the Web proxy's 15-second upstream timeout.
- A dedicated read-only PostgreSQL login inherits
  `letletme_graphql_reader`; it is never the Data migration login.
- Startup runs `bun run contract:check` and fails closed unless the exact
  catalog, current season, active publication, and read-only ACL contract are
  present.
- GraphQL has no business migration command. Data migrations run only from the
  accepted `letletme_data` build before GraphQL deployment.
- Runtime deployment uses two immutable GraphQL slots (`blue` on 4000 and
  `green` on 4002). The VPS-owned Nginx include is switched atomically only
  after `/health/ready`, schema, and core-query probes pass. Public validation
  failure rolls back the active slot without rebuilding the previous
  container.

## Verification

```bash
bun run format:check
bun run lint
bunx tsc --noEmit
bun test
bun run contract:check
docker compose config --quiet
```

Main deployment builds one image, deploys its immutable digest, runs the
startup contract, and verifies `/health/ready` before completion.
