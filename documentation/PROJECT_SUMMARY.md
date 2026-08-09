# Project summary

`letletme-graphql` is a read-heavy Bun/Apollo GraphQL API for FPL, competition,
reporting, and limited cross-provider data. It is not a database owner or an
identity provider.

Operational contracts:

- Data business reads use the schema-qualified Data Platform v3 PostgreSQL
  contract through a fail-closed, read-only login.
- `fpl.seasons.is_current` is the sole current-season authority.
- `letletme-web` owns authentication and `bauth`; `letletme_data` owns facts,
  reporting models, sync state, and Data publications.
- Request size, GraphQL complexity, entry batches, ingress, and rate limits are
  bounded before expensive work.
- PostgreSQL is authoritative. G2 owns the revision-coherent Redis publication
  and GraphQL query-cache cut.

Use [README](../README.md), [architecture](ARCHITECTURE_OVERVIEW.md), and
[rollout](../docs/ROLLOUT.md) as current instructions. Older design documents
are historical context only.
