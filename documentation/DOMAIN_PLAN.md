# Domain plan

The pre-v3 table-by-table domain plan has been retired because it described
public, singular, and season-suffixed objects that GraphQL no longer owns.

Current contracts are maintained in:

- [`ARCHITECTURE_OVERVIEW.md`](ARCHITECTURE_OVERVIEW.md)
- [`RLS_SECURITY.md`](RLS_SECURITY.md)
- [`TOURNAMENT_SUMMARY_READ_MODEL.md`](TOURNAMENT_SUMMARY_READ_MODEL.md)
- the versioned Data Platform v3 plan in `letletme_data/docs/data-platform-v3`

GraphQL schema fields remain organized by domain under `src/domains`, while all
business persistence and reporting definitions are owned by `letletme_data`.
