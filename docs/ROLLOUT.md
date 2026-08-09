# Data Platform v3 coordinated rollout

This repository follows the versioned Data Platform v3 plan and cutover runbook
stored in `letletme_data/docs/data-platform-v3`. That runbook, its external
backup evidence, and its exact approval strings are authoritative.

## Branch order

1. Accept G1 schema-qualified PostgreSQL readers and startup contract.
2. Build G2 from the exact accepted G1 SHA; add typed Data publications,
   reporting readers, and revision-keyed GraphQL caches.
3. Build G3 from the exact accepted G2 SHA; add only the limited indexed
   Understat player-state contract.
4. Accept W1 Web operations, maintenance UX, and auth ownership tests.
5. Run two complete P5 rehearsals against restored B0 with the exact candidate
   SHAs and image digests.

G1, G2, or G3 alone must not be deployed as the production hard cutover.

## Deployment boundary

- Data migrations and reporting refreshes run from the accepted Data build.
- Web migrations modify only Web-owned `bauth` objects.
- GraphQL uses a dedicated read-only login and runs
  `bun run contract:check` before the service starts.
- GraphQL deploy contains no business migration, DDL, or schema bootstrap.
- Maintenance mode remains enabled until private smoke tests pass.

## GraphQL smoke tests

- Startup reports the expected role, season, dataset revision, schema `v3`, and
  plan `3.2.5`.
- `/health` reports Redis, PostgreSQL, and current-season metadata healthy.
- Representative selections, player detail, live points, market, tournament,
  profile, and verified-binding journeys pass through Web.
- A missing Data relation/column/publication or a write-capable runtime role
  prevents startup.
- Redis failure uses one coherent PostgreSQL revision after G2; no per-key mix
  is returned.

## Rollback

Use only the exact rollback SHAs/images and B1 selective-restore procedure
accepted during P5. Production activation and legacy deletion are separate
operator approvals. Never infer either approval from a deploy, edit migration
history, or start a dual-write/shadow path.
