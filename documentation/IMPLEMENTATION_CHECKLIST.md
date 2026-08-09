# Implementation checklist

- [x] Schema-qualified Data Platform v3 PostgreSQL read models.
- [x] `fpl.seasons.is_current` current-season authority.
- [x] SELECT-only, fail-closed startup catalog and ACL contract.
- [x] Supabase business client, dependency, env, and GraphQL migration runner
      removed.
- [x] Deploy runs `contract:check` and cannot mutate business schemas.
- [x] Unit and real PG15 contract gates in CI.
- [x] Web-owned authentication verifier and verified-entry authorization.
- [x] Request body, complexity, batch, ingress, and Redis rate limits.
- [ ] G2 typed Data publication reader and dataset-revision query cache.
- [ ] G3 limited `playerStateProfile` PostgreSQL contract.
- [ ] W1 Web operation, maintenance-state, and auth journey acceptance.
- [ ] Two full P5 hard-cutover rehearsals and rollback gates.

Run the verification commands in the root README before accepting G1.
