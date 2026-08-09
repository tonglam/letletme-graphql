# Deployment summary

This repository is the read-heavy GraphQL runtime. `letletme_data` owns every
Data Platform business schema and publication; `letletme-web` owns `bauth`.

## Runtime contract

- Bun, Apollo Server 5, PostgreSQL 15, and Redis.
- `POST /graphql`, `GET /health`, and token-protected `GET /metrics`.
- A dedicated read-only PostgreSQL login inherits
  `letletme_graphql_reader`; it is never the Data migration login.
- Startup runs `bun run contract:check` and fails closed unless the exact v3
  catalog, current season, active publication, and read-only ACL contract are
  present.
- GraphQL has no business migration command. Data migrations run only from the
  accepted `letletme_data` build before GraphQL deployment.

G1 is an integration branch, not a standalone production cutover candidate.
Production deployment waits for accepted G2, G3, W1, and two complete P5
rehearsals.

## Verification

```bash
bun run format:check
bun run lint
bunx tsc --noEmit
bun test
bun run contract:check
docker compose config --quiet
```

See [`docs/ROLLOUT.md`](../docs/ROLLOUT.md). This document is not production
activation evidence.
