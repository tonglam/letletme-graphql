# API Changelog

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
