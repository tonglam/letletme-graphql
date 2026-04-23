-- Tournament summary read model:
-- 1) Persist cumulative metrics directly on tournament_points_group_results.
-- 2) Expose a snapshot view with SQL-computed tournament ranks.

ALTER TABLE public.tournament_points_group_results
  ADD COLUMN IF NOT EXISTS cum_transfers_num integer,
  ADD COLUMN IF NOT EXISTS cum_total_costs integer,
  ADD COLUMN IF NOT EXISTS cum_total_bench_points integer,
  ADD COLUMN IF NOT EXISTS cum_auto_sub_points integer;

CREATE INDEX IF NOT EXISTS idx_tournament_points_summary_lookup
  ON public.tournament_points_group_results (tournament_id, event_id, entry_id);

CREATE INDEX IF NOT EXISTS idx_tournament_points_incremental_lookup
  ON public.tournament_points_group_results (tournament_id, entry_id, event_id);

CREATE INDEX IF NOT EXISTS idx_league_event_summary_lookup
  ON public.league_event_results (league_id, league_type, event_id, entry_id);

-- Backfill cumulative fields from entry_event_results for existing data.
WITH cumulative_source AS (
  SELECT
    tpr.tournament_id,
    tpr.event_id,
    tpr.entry_id,
    COALESCE(SUM(eer.event_transfers), 0)::integer AS cum_transfers_num,
    COALESCE(SUM(eer.event_transfers_cost), 0)::integer AS cum_total_costs,
    COALESCE(SUM(eer.event_bench_points), 0)::integer AS cum_total_bench_points,
    COALESCE(SUM(eer.event_auto_sub_points), 0)::integer AS cum_auto_sub_points
  FROM public.tournament_points_group_results AS tpr
  JOIN public.tournament_infos AS ti
    ON ti.id = tpr.tournament_id
  LEFT JOIN public.entry_event_results AS eer
    ON eer.entry_id = tpr.entry_id
   AND eer.event_id >= COALESCE(ti.group_started_event_id, 1)
   AND eer.event_id <= tpr.event_id
  GROUP BY tpr.tournament_id, tpr.event_id, tpr.entry_id
)
UPDATE public.tournament_points_group_results AS target
SET
  cum_transfers_num = source.cum_transfers_num,
  cum_total_costs = source.cum_total_costs,
  cum_total_bench_points = source.cum_total_bench_points,
  cum_auto_sub_points = source.cum_auto_sub_points
FROM cumulative_source AS source
WHERE target.tournament_id = source.tournament_id
  AND target.event_id = source.event_id
  AND target.entry_id = source.entry_id
  AND (
    target.cum_transfers_num IS DISTINCT FROM source.cum_transfers_num
    OR target.cum_total_costs IS DISTINCT FROM source.cum_total_costs
    OR target.cum_total_bench_points IS DISTINCT FROM source.cum_total_bench_points
    OR target.cum_auto_sub_points IS DISTINCT FROM source.cum_auto_sub_points
  );

ALTER TABLE public.tournament_points_group_results
  ALTER COLUMN cum_transfers_num SET DEFAULT 0,
  ALTER COLUMN cum_total_costs SET DEFAULT 0,
  ALTER COLUMN cum_total_bench_points SET DEFAULT 0,
  ALTER COLUMN cum_auto_sub_points SET DEFAULT 0;

UPDATE public.tournament_points_group_results
SET
  cum_transfers_num = COALESCE(cum_transfers_num, 0),
  cum_total_costs = COALESCE(cum_total_costs, 0),
  cum_total_bench_points = COALESCE(cum_total_bench_points, 0),
  cum_auto_sub_points = COALESCE(cum_auto_sub_points, 0)
WHERE cum_transfers_num IS NULL
   OR cum_total_costs IS NULL
   OR cum_total_bench_points IS NULL
   OR cum_auto_sub_points IS NULL;

ALTER TABLE public.tournament_points_group_results
  ALTER COLUMN cum_transfers_num SET NOT NULL,
  ALTER COLUMN cum_total_costs SET NOT NULL,
  ALTER COLUMN cum_total_bench_points SET NOT NULL,
  ALTER COLUMN cum_auto_sub_points SET NOT NULL;

CREATE OR REPLACE VIEW public.v_tournament_event_snapshot AS
SELECT
  tpr.tournament_id,
  tpr.event_id,
  tpr.entry_id,
  tpr.event_group_rank AS tournament_overall_rank,
  ler.overall_rank,
  ler.team_value,
  COALESCE(tpr.cum_transfers_num, 0) AS cum_transfers_num,
  COALESCE(tpr.cum_total_costs, 0) AS cum_total_costs,
  COALESCE(tpr.cum_total_bench_points, 0) AS cum_total_bench_points,
  COALESCE(tpr.cum_auto_sub_points, 0) AS cum_auto_sub_points,
  CASE
    WHEN ler.team_value IS NULL THEN NULL
    ELSE RANK() OVER (
      PARTITION BY tpr.tournament_id, tpr.event_id
      ORDER BY ler.team_value DESC NULLS LAST
    )
  END AS tournament_team_value_rank,
  RANK() OVER (
    PARTITION BY tpr.tournament_id, tpr.event_id
    ORDER BY COALESCE(tpr.cum_transfers_num, 0) ASC
  ) AS tournament_transfers_rank,
  RANK() OVER (
    PARTITION BY tpr.tournament_id, tpr.event_id
    ORDER BY COALESCE(tpr.cum_total_costs, 0) ASC
  ) AS tournament_costs_rank,
  RANK() OVER (
    PARTITION BY tpr.tournament_id, tpr.event_id
    ORDER BY COALESCE(tpr.cum_total_bench_points, 0) DESC
  ) AS tournament_bench_points_rank,
  RANK() OVER (
    PARTITION BY tpr.tournament_id, tpr.event_id
    ORDER BY COALESCE(tpr.cum_auto_sub_points, 0) DESC
  ) AS tournament_auto_sub_rank
FROM public.tournament_points_group_results AS tpr
JOIN public.tournament_infos AS ti
  ON ti.id = tpr.tournament_id
LEFT JOIN public.league_event_results AS ler
  ON ler.league_id = ti.league_id
 AND ler.league_type::text = ti.league_type::text
 AND ler.event_id = tpr.event_id
 AND ler.entry_id = tpr.entry_id;

ALTER VIEW public.v_tournament_event_snapshot
  SET (security_invoker = true);
