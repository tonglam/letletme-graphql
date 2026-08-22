export const COMPETITION_AGGREGATE_SQL = `
/* my-fpl competition aggregate: aggregate the complete field in PostgreSQL */
WITH aggregate_rows AS MATERIALIZED (
  SELECT summary.entry_id,
         entry.entry_name,
         entry.player_name,
         summary.overall_points,
         summary.overall_rank,
         summary.team_value,
         summary.cumulative_transfers,
         summary.cumulative_transfer_cost,
         summary.cumulative_bench_points,
         summary.cumulative_auto_sub_points,
         summary.event_points,
         summary.event_net_points,
         CASE regexp_replace(upper(COALESCE(summary.event_chip::text, 'NONE')), '[^A-Z0-9]', '', 'g')
           WHEN 'BENCHBOOST' THEN 'BENCH_BOOST'
           WHEN 'BBOOST' THEN 'BENCH_BOOST'
           WHEN 'BB' THEN 'BENCH_BOOST'
           WHEN 'TRIPLECAPTAIN' THEN 'TRIPLE_CAPTAIN'
           WHEN '3XC' THEN 'TRIPLE_CAPTAIN'
           WHEN 'TC' THEN 'TRIPLE_CAPTAIN'
           WHEN 'FREEHIT' THEN 'FREE_HIT'
           WHEN 'FH' THEN 'FREE_HIT'
           WHEN 'WILDCARD' THEN 'WILDCARD'
           WHEN 'WC' THEN 'WILDCARD'
           WHEN 'MANAGER' THEN 'MANAGER'
           WHEN 'AM' THEN 'MANAGER'
           ELSE 'NONE'
         END AS normalized_chip,
         summary.captain_points,
         summary.played_captain_element_id AS captain_id,
         captain.web_name AS captain_web_name,
         captain_team.short_name AS captain_team_short_name,
         COALESCE(group_result.event_group_rank, summary.tournament_event_rank)::integer AS tournament_rank,
         COALESCE(previous_group.event_group_rank, previous_summary.tournament_event_rank)::integer AS previous_tournament_rank
  FROM reporting.tournament_entry_event_summaries summary
  JOIN competition.entries entry
    ON entry.season_id = summary.season_id
   AND entry.entry_id = summary.entry_id
  LEFT JOIN competition.tournament_points_group_results group_result
    ON group_result.season_id = summary.season_id
   AND group_result.tournament_id = summary.tournament_id
   AND group_result.event_id = summary.event_id
   AND group_result.entry_id = summary.entry_id
  LEFT JOIN reporting.tournament_entry_event_summaries previous_summary
    ON previous_summary.season_id = summary.season_id
   AND previous_summary.tournament_id = summary.tournament_id
   AND previous_summary.event_id = summary.event_id - 1
   AND previous_summary.entry_id = summary.entry_id
  LEFT JOIN competition.tournament_points_group_results previous_group
    ON previous_group.season_id = summary.season_id
   AND previous_group.tournament_id = summary.tournament_id
   AND previous_group.event_id = summary.event_id - 1
   AND previous_group.entry_id = summary.entry_id
  LEFT JOIN fpl.players captain
    ON captain.season_id = summary.season_id
   AND captain.element_id = summary.played_captain_element_id
  LEFT JOIN LATERAL (
    SELECT fixture_stats.team_id
    FROM fpl.player_fixture_stats fixture_stats
    JOIN fpl.fixtures fixture
      ON fixture.season_id = fixture_stats.season_id
     AND fixture.fixture_id = fixture_stats.fixture_id
    WHERE fixture_stats.season_id = summary.season_id
      AND fixture_stats.event_id = summary.event_id
      AND fixture_stats.element_id = summary.played_captain_element_id
    ORDER BY fixture.kickoff_time NULLS LAST,
             fixture.fixture_id,
             fixture_stats.fixture_id
    LIMIT 1
  ) captain_historical_team ON TRUE
  LEFT JOIN fpl.teams captain_team
    ON captain_team.season_id = summary.season_id
   AND captain_team.team_id = captain_historical_team.team_id
  WHERE summary.season_id = $1
    AND summary.tournament_id = $2
    AND summary.event_id = $3
), field_stats AS (
  SELECT COUNT(*)::integer AS entry_count
  FROM aggregate_rows
), overall_ordered AS (
  SELECT aggregate_rows.*,
         ROW_NUMBER() OVER (ORDER BY overall_points DESC NULLS LAST, entry_id) AS overall_position
  FROM aggregate_rows
  WHERE overall_points IS NOT NULL
), overall_stats AS (
  SELECT
    (array_agg(overall_points ORDER BY overall_points DESC, entry_id) FILTER (WHERE overall_points IS NOT NULL))[1]::integer AS leader_overall_points,
    (array_agg(overall_points ORDER BY overall_points DESC, entry_id) FILTER (WHERE overall_points IS NOT NULL))[2]::integer AS second_overall_points,
    ROUND(AVG(overall_points))::integer AS average_overall_points
  FROM aggregate_rows
), metric_values AS (
  SELECT 'OVERALL_POINTS'::text AS key, entry_id, entry_name, player_name, overall_points::numeric AS value, TRUE AS higher_is_better
  FROM aggregate_rows WHERE overall_points IS NOT NULL
  UNION ALL
  SELECT 'TEAM_VALUE', entry_id, entry_name, player_name, team_value::numeric, TRUE
  FROM aggregate_rows WHERE team_value IS NOT NULL
  UNION ALL
  SELECT 'TRANSFERS', entry_id, entry_name, player_name, cumulative_transfers::numeric, FALSE
  FROM aggregate_rows WHERE cumulative_transfers IS NOT NULL
  UNION ALL
  SELECT 'TOTAL_COSTS', entry_id, entry_name, player_name, cumulative_transfer_cost::numeric, FALSE
  FROM aggregate_rows WHERE cumulative_transfer_cost IS NOT NULL
  UNION ALL
  SELECT 'BENCH_POINTS', entry_id, entry_name, player_name, cumulative_bench_points::numeric, TRUE
  FROM aggregate_rows WHERE cumulative_bench_points IS NOT NULL
  UNION ALL
  SELECT 'AUTO_SUB_POINTS', entry_id, entry_name, player_name, cumulative_auto_sub_points::numeric, TRUE
  FROM aggregate_rows WHERE cumulative_auto_sub_points IS NOT NULL
), metric_ranked AS (
  SELECT metric_values.*,
         RANK() OVER (
           PARTITION BY key
           ORDER BY CASE WHEN higher_is_better THEN value END DESC NULLS LAST,
                    CASE WHEN NOT higher_is_better THEN value END ASC NULLS LAST
         )::integer AS metric_rank,
         ROW_NUMBER() OVER (
           PARTITION BY key
           ORDER BY CASE WHEN higher_is_better THEN value END DESC NULLS LAST,
                    CASE WHEN NOT higher_is_better THEN value END ASC NULLS LAST,
                    entry_id
         ) AS leader_position
  FROM metric_values
), metric_stats AS (
  SELECT key,
         higher_is_better,
         (array_agg(value ORDER BY leader_position))[1] AS leader_value,
         (array_agg(entry_id ORDER BY leader_position))[1] AS leader_entry_id,
         (array_agg(entry_name ORDER BY leader_position))[1] AS leader_entry_name,
         (array_agg(player_name ORDER BY leader_position))[1] AS leader_player_name,
         ROUND(AVG(value), 2) AS average_value
  FROM metric_ranked
  GROUP BY key, higher_is_better
), performance_rows AS (
  SELECT aggregate_rows.*,
         ROW_NUMBER() OVER (ORDER BY event_net_points DESC, entry_id) AS performance_position
  FROM aggregate_rows
  WHERE event_points IS NOT NULL AND event_net_points IS NOT NULL
), movement_rows AS (
  SELECT aggregate_rows.*,
         previous_tournament_rank - tournament_rank AS movement
  FROM aggregate_rows
  WHERE previous_tournament_rank IS NOT NULL
    AND tournament_rank IS NOT NULL
    AND event_points IS NOT NULL
    AND event_net_points IS NOT NULL
), captain_groups AS (
  SELECT
    CASE WHEN captain_id IS NULL THEN 'NONE' ELSE captain_id::text END AS key,
    CASE WHEN captain_id IS NULL THEN 'NONE' ELSE COALESCE(captain_web_name, captain_id::text) END AS label,
    CASE WHEN captain_id IS NULL THEN NULL ELSE captain_team_short_name END AS team_short_name,
    COUNT(*)::integer AS count,
    ROUND(AVG(CASE WHEN captain_id IS NULL THEN 0 ELSE COALESCE(captain_points, 0) END), 1) AS average_points
  FROM aggregate_rows
  GROUP BY captain_id, captain_web_name, captain_team_short_name
), chip_groups AS (
  SELECT normalized_chip AS key,
         normalized_chip AS label,
         COUNT(*)::integer AS count,
         ROUND(AVG(COALESCE(event_net_points, event_points, 0)), 1) AS average_points
  FROM aggregate_rows
  GROUP BY normalized_chip
), metrics_json AS (
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'key', catalog.key,
        'leaderValue', stats.leader_value,
        'leaderEntryId', stats.leader_entry_id,
        'leaderEntryName', stats.leader_entry_name,
        'leaderPlayerName', stats.leader_player_name,
        'averageValue', stats.average_value,
        'higherIsBetter', catalog.higher_is_better
      ) ORDER BY catalog.sort_order
    ), '[]'::jsonb
  ) AS value
  FROM (
    VALUES
      (1, 'OVERALL_POINTS'::text, TRUE),
      (2, 'TEAM_VALUE'::text, TRUE),
      (3, 'TRANSFERS'::text, FALSE),
      (4, 'TOTAL_COSTS'::text, FALSE),
      (5, 'BENCH_POINTS'::text, TRUE),
      (6, 'AUTO_SUB_POINTS'::text, TRUE)
  ) AS catalog(sort_order, key, higher_is_better)
  LEFT JOIN metric_stats stats ON stats.key = catalog.key
)
SELECT jsonb_build_object(
  'eventId', $3,
  'entryCount', field_stats.entry_count,
  'leaderOverallPoints', overall_stats.leader_overall_points,
  'secondOverallPoints', overall_stats.second_overall_points,
  'gapFirstSecond', CASE
    WHEN overall_stats.leader_overall_points IS NULL OR overall_stats.second_overall_points IS NULL THEN NULL
    ELSE overall_stats.leader_overall_points - overall_stats.second_overall_points
  END,
  'averageOverallPoints', overall_stats.average_overall_points,
  'metrics', metrics_json.value,
  'viewer', (
    SELECT jsonb_build_object(
      'entryId', viewer.entry_id,
      'overallRank', viewer.overall_rank,
      'tournamentOverallRank', viewer.tournament_rank,
      'teamValue', viewer.team_value,
      'tournamentTeamValueRank', (SELECT metric_rank FROM metric_ranked WHERE key = 'TEAM_VALUE' AND entry_id = viewer.entry_id),
      'transfersNum', viewer.cumulative_transfers,
      'tournamentTransfersRank', (SELECT metric_rank FROM metric_ranked WHERE key = 'TRANSFERS' AND entry_id = viewer.entry_id),
      'totalCosts', viewer.cumulative_transfer_cost,
      'tournamentCostsRank', (SELECT metric_rank FROM metric_ranked WHERE key = 'TOTAL_COSTS' AND entry_id = viewer.entry_id),
      'totalBenchPoints', viewer.cumulative_bench_points,
      'tournamentBenchPointsRank', (SELECT metric_rank FROM metric_ranked WHERE key = 'BENCH_POINTS' AND entry_id = viewer.entry_id),
      'autoSubPoints', viewer.cumulative_auto_sub_points,
      'tournamentAutoSubRank', (SELECT metric_rank FROM metric_ranked WHERE key = 'AUTO_SUB_POINTS' AND entry_id = viewer.entry_id),
      'overallPoints', viewer.overall_points,
      'leaderOverallPoints', overall_stats.leader_overall_points,
      'gapToLeader', CASE
        WHEN viewer.overall_points IS NULL OR overall_stats.leader_overall_points IS NULL THEN NULL
        ELSE GREATEST(0, overall_stats.leader_overall_points - viewer.overall_points)
      END,
      'pointsBehindNext', CASE
        WHEN viewer_points.overall_position IS NULL THEN NULL
        WHEN viewer_points.overall_position = 1 THEN 0
        ELSE GREATEST(0, viewer_points.above_overall_points - viewer.overall_points)
      END,
      'pointsAheadOfPrev', CASE
        WHEN viewer_points.overall_position IS NULL THEN NULL
        WHEN viewer_points.overall_position = viewer_points.total_positions THEN 0
        ELSE GREATEST(0, viewer.overall_points - viewer_points.below_overall_points)
      END
    )
    FROM aggregate_rows viewer
    LEFT JOIN LATERAL (
      SELECT current_row.overall_position,
             above_row.overall_points AS above_overall_points,
             below_row.overall_points AS below_overall_points,
             (SELECT COUNT(*) FROM overall_ordered) AS total_positions
      FROM overall_ordered current_row
      LEFT JOIN overall_ordered above_row ON above_row.overall_position = current_row.overall_position - 1
      LEFT JOIN overall_ordered below_row ON below_row.overall_position = current_row.overall_position + 1
      WHERE current_row.entry_id = viewer.entry_id
    ) viewer_points ON TRUE
    WHERE viewer.entry_id = $4
    LIMIT 1
  ),
  'topPerformers', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'entryId', item.entry_id,
      'entryName', item.entry_name,
      'playerName', item.player_name,
      'eventPoints', item.event_points,
      'eventNetPoints', item.event_net_points,
      'rank', item.tournament_rank,
      'previousRank', item.previous_tournament_rank,
      'captainId', item.captain_id,
      'captainWebName', item.captain_web_name,
      'captainTeamShortName', item.captain_team_short_name,
      'captainPoints', item.captain_points
    ) ORDER BY item.performance_position)
    FROM performance_rows item
    WHERE item.performance_position <= 5
  ), '[]'::jsonb),
  'risers', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'entryId', item.entry_id,
      'entryName', item.entry_name,
      'playerName', item.player_name,
      'eventPoints', item.event_points,
      'eventNetPoints', item.event_net_points,
      'rank', item.tournament_rank,
      'previousRank', item.previous_tournament_rank,
      'captainId', item.captain_id,
      'captainWebName', item.captain_web_name,
      'captainTeamShortName', item.captain_team_short_name,
      'captainPoints', item.captain_points
    ) ORDER BY item.movement DESC, item.entry_id)
    FROM (
      SELECT * FROM movement_rows
      WHERE movement > 0
      ORDER BY movement DESC, entry_id
      LIMIT 5
    ) item
  ), '[]'::jsonb),
  'fallers', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'entryId', item.entry_id,
      'entryName', item.entry_name,
      'playerName', item.player_name,
      'eventPoints', item.event_points,
      'eventNetPoints', item.event_net_points,
      'rank', item.tournament_rank,
      'previousRank', item.previous_tournament_rank,
      'captainId', item.captain_id,
      'captainWebName', item.captain_web_name,
      'captainTeamShortName', item.captain_team_short_name,
      'captainPoints', item.captain_points
    ) ORDER BY item.movement ASC, item.entry_id)
    FROM (
      SELECT * FROM movement_rows
      WHERE movement < 0
      ORDER BY movement ASC, entry_id
      LIMIT 5
    ) item
  ), '[]'::jsonb),
  'captainDistribution', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'key', item.key,
      'label', item.label,
      'teamShortName', item.team_short_name,
      'count', item.count,
      'percentage', ROUND(item.count::numeric * 100 / NULLIF(field_stats.entry_count, 0), 2),
      'averagePoints', item.average_points
    ) ORDER BY item.count DESC, item.key)
    FROM captain_groups item
  ), '[]'::jsonb),
  'chipDistribution', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'key', item.key,
      'label', item.label,
      'teamShortName', NULL,
      'count', item.count,
      'percentage', ROUND(item.count::numeric * 100 / NULLIF(field_stats.entry_count, 0), 2),
      'averagePoints', item.average_points
    ) ORDER BY item.count DESC, item.key)
    FROM chip_groups item
  ), '[]'::jsonb)
) AS payload
FROM field_stats
CROSS JOIN overall_stats
CROSS JOIN metrics_json`;
