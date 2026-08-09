# Current architecture

```text
letletme-web ── signed website envelope ─┐
letletme-web ── hashed Mini Program token ├─> letletme-graphql ──> PostgreSQL/Supabase
                                         │                    └─> Redis
letletme_data ── domain tables/hashes ───┘
```

`letletme-web` is the sole identity authority and owns the `bauth` schema.
`letletme_data` owns FPL domain tables and sync-maintained positive Redis
hashes. GraphQL is a read-heavy API and owns only its shaped/negative cache
namespace and forward read-model/RLS migrations.

## Request path

1. Bun receives `/graphql`, `/health`, or `/metrics`.
2. GraphQL bodies are capped at 256 KiB. Queries are bounded by depth 10, five
   root fields, 20 aliases, 200 AST nodes, weighted complexity 500, and entry
   batches of 500.
3. The client IP is derived from the direct peer unless a reviewed proxy hop
   count is configured. Redis enforces 120 requests/minute/IP and stricter
   security-operation limits. Security checks fail closed when Redis is down.
4. A principal is resolved from the website envelope or hashed web Mini Program
   session; legacy token families are deadline-gated validation-only bridges.
5. Root-field authorization requires a verified entry for protected entry,
   league, tournament, and calculation operations.
6. Repositories read sync-owned Redis data first, then authoritative database
   rows. GraphQL-shaped caches use `gql:v2:{season}:...` and explicit TTLs.

## Reliability boundaries

- `Season:active` is mandatory; missing or malformed metadata
  produces a degraded health response and a typed 503 GraphQL error.
- `event:current` falls back to the events table.
- Malformed shaped caches are evicted and retried from authoritative storage;
  database errors are not converted into empty collections.
- Live scoring can shadow-compare the official-total implementation behind
  `LIVE_POINTS_V2` before global enablement.
- Deploys retain the current and previous two repository image tags.

See the root README and [`docs/ROLLOUT.md`](../docs/ROLLOUT.md) for ownership,
migration, smoke-test, and rollback contracts.
