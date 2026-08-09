# Tournament reporting read models

Data Platform v3 owns both reporting materialized views:

- `reporting.tournament_selection_stats` publishes complete
  tournament/event/element selection counts after the 15-pick completeness
  gate.
- `reporting.tournament_entry_event_summaries` publishes one cumulative row per
  tournament/event/entry.

GraphQL selects these models directly through `letletme_graphql_reader`. It does
not scan picks/transfers at request time, call aggregation RPCs, refresh a view,
or maintain a duplicate physical summary table. Data is responsible for
refresh timing, completeness validation, and publication revision changes.

The public GraphQL query cache added in G2 includes the Data dataset revision,
so an accepted refresh invalidates prior shaped results without mutating the
source models.
