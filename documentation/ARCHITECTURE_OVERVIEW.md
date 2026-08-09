# Current architecture

```text
letletme-web  -- signed identity/session --> letletme-graphql
letletme_data -- PostgreSQL v3 + Redis ----> letletme-graphql --> Web/clients
```

`letletme_data` is the only writer of `fpl`, `competition`, `reporting`,
`understat`, `bridge`, and `ops`. `letletme-web` is the only writer of `bauth`.
GraphQL uses schema-qualified PostgreSQL reads and owns only query shaping,
authorization, and its Redis query-cache namespace.

## Request path

1. Startup validates the v3 catalog, one current season, active Data
   publication, and read-only runtime ACLs using `SELECT` only.
2. Bun receives `/graphql`, `/health`, or `/metrics`.
3. Request size, shape, complexity, batch size, ingress, and Redis-backed rate
   limits are checked before resolver work.
4. Web envelopes or Web-issued Mini Program sessions resolve a principal;
   deadline-gated legacy tokens are validation-only.
5. Protected entry, league, tournament, and calculation fields require the
   verified entry contract.
6. G1 repositories read schema-qualified v3 PostgreSQL models. G2 adds the
   typed, revision-coherent Data Redis reader and revision-keyed GraphQL cache.

## Reliability boundaries

- Exactly one `fpl.seasons.is_current = true` row is required. Redis and wall
  clock time never select a season.
- A missing relation, column, publication, or safe privilege boundary prevents
  startup.
- GraphQL deploys never execute business DDL or reporting refreshes.
- PostgreSQL remains authoritative when a Redis publication or query cache is
  absent or rejected.
