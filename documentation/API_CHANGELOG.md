# API Changelog

## 2026-04-22 - Tournament Summary Read Model

### Updated
- `tournamentEntryRankingSummary` backend read path now uses a precomputed read model:
  - persisted cumulative fields on `tournament_points_group_results`
  - SQL view `v_tournament_event_snapshot` for event snapshot + tournament-scoped rank columns

### Rollout Checklist
1. Apply migration `migrations/005_tournament_summary_read_model.sql`.
2. Ensure upstream ingestion updates cumulative fields incrementally for each event.
3. Validate parity versus previous runtime aggregation on sampled tournaments/events.
4. Deploy backend repository changes to consume the snapshot view.

## 2026-04-20 - Price History API

### Added
- New GraphQL query:
  - `playerValueHistory(playerId: Int!, limit: Int, fromDate: DateTime, toDate: DateTime): [PlayerValueHistoryItem!]!`
- New GraphQL types:
  - `PlayerValueHistoryItem`
  - `PriceChangeType` (`RISE`, `FALL`, `UNCHANGED`)

### Updated (Non-Breaking)
- `PlayerValue` now includes:
  - `teamShortName: String!`
  - `positionEnum: Position`

### Behavior
- History results are sorted by `changeDate DESC`.
- `limit` defaults to `30` and is capped at `365`.
- Invalid date ranges (`fromDate > toDate`) return a validation error.
- Empty history returns `[]`.
- `oldValue` and `newValue` use tenths (for example, `101` means `10.1`).

### Rollout Checklist
1. Apply migration `migrations/004_player_values_history_index.sql`.
2. Deploy backend with new schema/resolver/service/repository changes.
3. Validate in GraphQL playground using `playerValueHistory`.
4. Coordinate frontend switch from snapshot-only reads to history query.
5. Remove temporary frontend snapshot-only messaging after adoption.
