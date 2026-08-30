# Current architecture

```text
letletme-web  -- signed identity/session --> letletme-graphql
letletme_data -- PostgreSQL + Redis -------> letletme-graphql --> Web/clients
```

`letletme_data` is the only writer of `fpl`, `competition`, `reporting`,
`understat`, `bridge`, and `ops`. `letletme-web` is the only writer of `bauth`.
GraphQL uses schema-qualified PostgreSQL reads and owns only query shaping,
authorization, and its Redis query-cache namespace.

## Request path

1. Startup validates the canonical catalog, one current season, active Data
   publication, and read-only runtime ACLs using `SELECT` only.
2. Bun receives `/graphql`, `/health/live`, `/health/hot`, `/health/ready`, or `/metrics`.
3. Request size, shape, complexity, batch size, ingress, and Redis-backed rate
   limits are checked before resolver work. Admission uses a dedicated
   rate-limit Redis endpoint so a publication/cache outage cannot consume the
   safety budget.
4. A verified Web ingress plus an optional Web user context or Mini Program
   session resolves a principal. Public Web reads use the service token.
5. Protected entry, league, tournament, and calculation fields require the
   verified entry contract.
6. Repositories read schema-qualified PostgreSQL models and use validated,
   revision-coherent Data publications plus revision-keyed query caches.

## Reliability boundaries

- Exactly one `fpl.seasons.is_current = true` row is required. Redis and wall
  clock time never select a season.
- A missing relation, column, publication, or safe privilege boundary prevents
  startup.
- GraphQL deploys never execute business DDL or reporting refreshes.
- PostgreSQL remains authoritative when a Redis publication or query cache is
  absent or rejected.
- `/health/live` only proves process liveness; `/health/hot` verifies the
  Redis/current-season serving path; `/health/ready` verifies PostgreSQL
  season authority plus both Redis endpoints and returns 503 when a hard
  dependency cannot be confirmed.
- Entry reads use the explicit `entryLookup` result contract; Player Detail
  separates injury availability from section-level data authority.
