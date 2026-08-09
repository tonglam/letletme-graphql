# Tournament Summary Read Model

## Purpose

Remove runtime cumulative scans for `tournamentEntryRankingSummary` by persisting cumulative metrics on `tournament_points_group_results` and reading ranked snapshot data from `v_tournament_event_snapshot`.

## Data Model

- Source table: `tournament_points_group_results`
- New cumulative fields:
  - `cum_transfers_num`
  - `cum_total_costs`
  - `cum_total_bench_points`
  - `cum_auto_sub_points`
- Snapshot view: `v_tournament_event_snapshot`

## Ingestion Lifecycle (required)

This repository does not write tournament data; ingestion must maintain cumulative fields.

For each `(tournament_id, event_id)` batch:

1. Ensure current-event rows exist in `tournament_points_group_results`.
2. Upsert cumulative fields by adding current event deltas to previous event cumulative values.
3. Commit the batch atomically.

### Incremental update template

```sql
WITH current_rows AS (
  SELECT
    tpr.tournament_id,
    tpr.event_id,
    tpr.entry_id,
    COALESCE(eer.event_transfers, 0)::integer AS event_transfers,
    COALESCE(eer.event_transfers_cost, 0)::integer AS event_transfers_cost,
    COALESCE(eer.event_bench_points, 0)::integer AS event_bench_points,
    COALESCE(eer.event_auto_sub_points, 0)::integer AS event_auto_sub_points
  FROM public.tournament_points_group_results AS tpr
  LEFT JOIN public.entry_event_results AS eer
    ON eer.entry_id = tpr.entry_id
   AND eer.event_id = tpr.event_id
  WHERE tpr.tournament_id = $1
    AND tpr.event_id = $2
),
previous_rows AS (
  SELECT
    tournament_id,
    entry_id,
    cum_transfers_num,
    cum_total_costs,
    cum_total_bench_points,
    cum_auto_sub_points
  FROM public.tournament_points_group_results
  WHERE tournament_id = $1
    AND event_id = $2 - 1
)
UPDATE public.tournament_points_group_results AS target
SET
  cum_transfers_num = COALESCE(prev.cum_transfers_num, 0) + curr.event_transfers,
  cum_total_costs = COALESCE(prev.cum_total_costs, 0) + curr.event_transfers_cost,
  cum_total_bench_points = COALESCE(prev.cum_total_bench_points, 0) + curr.event_bench_points,
  cum_auto_sub_points = COALESCE(prev.cum_auto_sub_points, 0) + curr.event_auto_sub_points
FROM current_rows AS curr
LEFT JOIN previous_rows AS prev
  ON prev.tournament_id = curr.tournament_id
 AND prev.entry_id = curr.entry_id
WHERE target.tournament_id = curr.tournament_id
  AND target.event_id = curr.event_id
  AND target.entry_id = curr.entry_id;
```

## Correction / Repair Strategy

If event corrections happen after initial publish, run repair from the corrected event to season end:

1. Recompute cumulative values from `entry_event_results` for all affected `(tournament_id, entry_id, event_id >= corrected_event_id)`.
2. Re-run parity query below on affected scope.

The backfill section in `migrations/005_tournament_summary_read_model.sql` can be reused for full recomputation.

## Parity Verification Query

Use this query to compare persisted cumulative values against recomputed totals:

```sql
WITH recomputed AS (
  SELECT
    tpr.tournament_id,
    tpr.event_id,
    tpr.entry_id,
    COALESCE(SUM(eer.event_transfers), 0)::integer AS expected_cum_transfers_num,
    COALESCE(SUM(eer.event_transfers_cost), 0)::integer AS expected_cum_total_costs,
    COALESCE(SUM(eer.event_bench_points), 0)::integer AS expected_cum_total_bench_points,
    COALESCE(SUM(eer.event_auto_sub_points), 0)::integer AS expected_cum_auto_sub_points
  FROM public.tournament_points_group_results AS tpr
  JOIN public.tournament_infos AS ti
    ON ti.id = tpr.tournament_id
  LEFT JOIN public.entry_event_results AS eer
    ON eer.entry_id = tpr.entry_id
   AND eer.event_id >= COALESCE(ti.group_started_event_id, 1)
   AND eer.event_id <= tpr.event_id
  GROUP BY tpr.tournament_id, tpr.event_id, tpr.entry_id
)
SELECT
  target.tournament_id,
  target.event_id,
  target.entry_id
FROM public.tournament_points_group_results AS target
JOIN recomputed AS expected
  ON expected.tournament_id = target.tournament_id
 AND expected.event_id = target.event_id
 AND expected.entry_id = target.entry_id
WHERE target.cum_transfers_num <> expected.expected_cum_transfers_num
   OR target.cum_total_costs <> expected.expected_cum_total_costs
   OR target.cum_total_bench_points <> expected.expected_cum_total_bench_points
   OR target.cum_auto_sub_points <> expected.expected_cum_auto_sub_points;
```

Expected result for parity: no rows.
