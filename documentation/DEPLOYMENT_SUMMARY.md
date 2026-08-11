# Deployment summary

This repository is the read-heavy GraphQL runtime. `letletme_data` owns every
Data Platform business schema and publication; `letletme-web` owns `bauth`.

## Runtime contract

- Bun, Apollo Server 5, PostgreSQL 15, and Redis.
- `POST /graphql`, `GET /health`, and token-protected `GET /metrics`.
- A dedicated read-only PostgreSQL login inherits
  `letletme_graphql_reader`; it is never the Data migration login.
- Startup runs `bun run contract:check` and fails closed unless the exact
  catalog, current season, active publication, and read-only ACL contract are
  present.
- GraphQL has no business migration command. Data migrations run only from the
  accepted `letletme_data` build before GraphQL deployment.

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
startup contract, and verifies `/health` before completion.
