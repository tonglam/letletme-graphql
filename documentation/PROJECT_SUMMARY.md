# Project summary

`letletme-graphql` is a read-heavy Bun/Apollo GraphQL API for FPL domain data.
It resolves public data from Redis and Supabase, provides protected entry and
tournament calculations, and exposes health and Prometheus endpoints.

The repository is deliberately not an identity provider. Authentication is
owned by `letletme-web`; domain tables and sync-owned caches are owned by
`letletme_data`. The service verifies web-signed envelopes and hashed web
Mini Program sessions and requires `fpl_entry_verified_at` for entry-scoped
access.

Operational contracts:

- 256 KiB request cap; depth 10; five root fields; 20 aliases; 200 AST nodes;
  weighted complexity 500; entry batches 500.
- 120 GraphQL requests/minute/IP with fail-closed security mutations.
- `Season:active` is required in every environment and missing metadata is a typed
  503; `event:current` has a database fallback.
- Sync-owned positive Redis keys are read-only to GraphQL. Shaped caches use
  explicit season-scoped `gql:v2` keys.
- `LIVE_POINTS_V2` can shadow-compare official FPL totals before enablement.

Use [README](../README.md), [architecture](ARCHITECTURE_OVERVIEW.md), and
[rollout](../docs/ROLLOUT.md) as the current source of truth. Older detailed
design documents should not be used to infer the deployed API surface.
