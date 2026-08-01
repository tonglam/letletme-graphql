-- Tournament event result view (optimized):
-- Combines tournament_points_group_results + league_event_results + entry_infos + tournament_infos
-- into a single row per (tournament_id, event_id, entry_id).
-- Includes tournament metadata columns so callers can validate group_mode
-- without a separate round-trip.

CREATE OR REPLACE VIEW public.v_tournament_event_result AS
SELECT
  tpr.tournament_id,
  tpr.event_id,
  tpr.entry_id,
  tpr.group_id,
  tpr.event_group_rank,
  tpr.event_points,
  tpr.event_cost,
  tpr.event_net_points,
  tpr.event_rank,
  ler.overall_points,
  ler.overall_rank,
  ler.event_chip,
  ler.captain_id,
  ler.captain_points,
  ler.team_value,
  ler.bank,
  COALESCE(ler.entry_name, ei.entry_name) AS entry_name,
  COALESCE(ler.player_name, ei.player_name) AS player_name,
  -- tournament metadata (identical for every row in a tournament)
  ti.id AS _tournament_id,
  ti.name AS _tournament_name,
  ti.creator AS _tournament_creator,
  ti.admin_entry_id AS _tournament_admin_entry_id,
  ti.league_id AS _tournament_league_id,
  ti.league_type AS _tournament_league_type,
  ti.total_team_num AS _tournament_total_team_num,
  ti.tournament_mode AS _tournament_tournament_mode,
  ti.group_mode AS _tournament_group_mode,
  ti.group_team_num AS _tournament_group_team_num,
  ti.group_num AS _tournament_group_num,
  ti.group_started_event_id AS _tournament_group_started_event_id,
  ti.group_ended_event_id AS _tournament_group_ended_event_id,
  ti.group_auto_averages AS _tournament_group_auto_averages,
  ti.group_rounds AS _tournament_group_rounds,
  ti.group_play_against_num AS _tournament_group_play_against_num,
  ti.group_qualify_num AS _tournament_group_qualify_num,
  ti.knockout_mode AS _tournament_knockout_mode,
  ti.knockout_team_num AS _tournament_knockout_team_num,
  ti.knockout_rounds AS _tournament_knockout_rounds,
  ti.knockout_event_num AS _tournament_knockout_event_num,
  ti.knockout_started_event_id AS _tournament_knockout_started_event_id,
  ti.knockout_ended_event_id AS _tournament_knockout_ended_event_id,
  ti.knockout_play_against_num AS _tournament_knockout_play_against_num,
  ti.state AS _tournament_state,
  ti.created_at AS _tournament_created_at,
  ti.updated_at AS _tournament_updated_at
FROM public.tournament_points_group_results tpr
JOIN public.tournament_infos ti
  ON ti.id = tpr.tournament_id
LEFT JOIN public.league_event_results ler
  ON ler.league_id = ti.league_id
  AND ler.league_type::text = ti.league_type::text
  AND ler.event_id = tpr.event_id
  AND ler.entry_id = tpr.entry_id
LEFT JOIN public.entry_infos ei
  ON ei.id = tpr.entry_id;

ALTER VIEW public.v_tournament_event_result
  SET (security_invoker = true);
