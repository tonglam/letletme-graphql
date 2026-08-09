import type { QueryResultRow } from "pg";
import type { QueryExecutor } from "./database";
import type { CurrentSeason } from "./season";

export const V3_READ_MODELS = {
	events: "fpl.events",
	teams: "fpl.teams",
	players: "fpl.players",
	playerEventSnapshots: "fpl.player_event_snapshots",
	fixtures: "fpl.fixtures",
	playerGameweekStats: "fpl.player_gameweek_stats",
	playerGameweekScoringItems: "fpl.player_gameweek_scoring_items",
	playerSeasonSummaries: "reporting.player_season_summaries",
	playerValueChanges: "reporting.player_value_changes",
	playerMarketSnapshots: "fpl.player_market_snapshots",
	playerFixtureStats: "fpl.player_fixture_stats",
	understatSeasons: "understat.seasons",
	understatPlayerSeasons: "understat.player_seasons",
	bridgeEntityLinks: "bridge.entity_links",
	entries: "competition.entries",
	entryEventResults: "competition.entry_event_results",
	entryEventPicks: "competition.entry_event_picks",
	entryEventTransfers: "competition.entry_event_transfers",
	entrySeasonHistories: "competition.entry_season_histories",
	entryLeagues: "competition.entry_leagues",
	leagueEventResults: "competition.league_event_results",
	tournaments: "competition.tournaments",
	tournamentEntries: "competition.tournament_entries",
	tournamentBattleGroupResults: "competition.tournament_battle_group_results",
	tournamentSelectionStats: "reporting.tournament_selection_stats",
	tournamentEventResults: "reporting.tournament_event_results",
	tournamentEntryEventSummaries: "reporting.tournament_entry_event_summaries",
} as const;

export type V3ReadModel = (typeof V3_READ_MODELS)[keyof typeof V3_READ_MODELS];

type ReadModelDefinition = Readonly<{
	sql: string;
	sourceRelations: readonly string[];
}>;

const READ_MODEL_DEFINITIONS: Readonly<Record<V3ReadModel, ReadModelDefinition>> = {
	[V3_READ_MODELS.events]: {
		sourceRelations: ["fpl.events"],
		sql: `
			SELECT
				event_id AS id,
				name,
				deadline_time,
				average_entry_score,
				finished,
				data_checked,
				highest_scoring_entry,
				deadline_time_epoch,
				deadline_time_game_offset,
				highest_score,
				is_previous,
				is_current,
				is_next,
				cup_league_create,
				h2h_ko_matches_created,
				chip_plays,
				most_selected,
				most_transferred_in,
				top_element,
				top_element_info,
				transfers_made,
				most_captained,
				most_vice_captained,
				created_at,
				updated_at,
				live_snapshot_checked_at,
				live_snapshot_finalized_at,
				data_checked_at
			FROM fpl.events
			WHERE season_id = $1
		`,
	},
	[V3_READ_MODELS.teams]: {
		sourceRelations: ["fpl.teams"],
		sql: `
			SELECT
				team_id AS id,
				code,
				name,
				short_name,
				strength,
				position,
				points,
				win,
				draw,
				loss,
				created_at,
				played,
				form,
				team_division,
				unavailable,
				strength_overall_home,
				strength_overall_away,
				strength_attack_home,
				strength_attack_away,
				strength_defence_home,
				strength_defence_away,
				pulse_id,
				updated_at
			FROM fpl.teams
			WHERE season_id = $1
		`,
	},
	[V3_READ_MODELS.players]: {
		sourceRelations: ["fpl.players"],
		sql: `
			SELECT
				element_id AS id,
				code,
				element_type AS type,
				team_id,
				price,
				start_price,
				first_name,
				second_name,
				web_name,
				created_at,
				updated_at,
				total_points,
				price_source_checked_at
			FROM fpl.players
			WHERE season_id = $1
		`,
	},
	[V3_READ_MODELS.playerEventSnapshots]: {
		sourceRelations: ["fpl.player_event_snapshots", "fpl.players", "fpl.teams"],
		sql: `
			SELECT
				snapshot.source_snapshot_id AS id,
				snapshot.event_id,
				snapshot.element_id,
				snapshot.element_type,
				snapshot.total_points,
				snapshot.form,
				snapshot.influence,
				snapshot.creativity,
				snapshot.threat,
				snapshot.ict_index,
				snapshot.expected_goals,
				snapshot.expected_assists,
				snapshot.expected_goal_involvements,
				snapshot.expected_goals_conceded,
				snapshot.minutes,
				snapshot.goals_scored,
				snapshot.assists,
				snapshot.clean_sheets,
				snapshot.goals_conceded,
				snapshot.own_goals,
				snapshot.penalties_saved,
				snapshot.yellow_cards,
				snapshot.red_cards,
				snapshot.saves,
				snapshot.bonus,
				snapshot.bps,
				snapshot.starts,
				snapshot.influence_rank,
				snapshot.influence_rank_type,
				snapshot.creativity_rank,
				snapshot.creativity_rank_type,
				snapshot.threat_rank,
				snapshot.threat_rank_type,
				snapshot.ict_index_rank,
				snapshot.ict_index_rank_type,
				snapshot.created_at,
				snapshot.updated_at,
				snapshot.transfers_in,
				snapshot.transfers_in_event,
				snapshot.transfers_out,
				snapshot.transfers_out_event,
				snapshot.selected_by_percent,
				player.web_name,
				player.team_id,
				team.name AS team_name,
				team.short_name AS team_short_name,
				player.price AS value
			FROM fpl.player_event_snapshots snapshot
			JOIN fpl.players player
			  ON player.season_id = snapshot.season_id
			 AND player.element_id = snapshot.element_id
			JOIN fpl.teams team
			  ON team.season_id = snapshot.season_id
			 AND team.team_id = player.team_id
			WHERE snapshot.season_id = $1
		`,
	},
	[V3_READ_MODELS.fixtures]: {
		sourceRelations: ["fpl.fixtures"],
		sql: `
			SELECT
				fixture_id AS id,
				code,
				event_id,
				kickoff_time,
				started,
				finished,
				minutes,
				team_h_id,
				team_h_difficulty,
				team_h_score,
				team_a_id,
				team_a_difficulty,
				team_a_score,
				created_at,
				finished_provisional,
				provisional_start_time,
				stats,
				pulse_id,
				updated_at
			FROM fpl.fixtures
			WHERE season_id = $1
		`,
	},
	[V3_READ_MODELS.playerGameweekStats]: {
		sourceRelations: ["fpl.player_gameweek_stats"],
		sql: `
			SELECT
				source_live_id AS id,
				event_id,
				element_id,
				minutes,
				goals_scored,
				assists,
				clean_sheets,
				goals_conceded,
				own_goals,
				penalties_saved,
				penalties_missed,
				yellow_cards,
				red_cards,
				saves,
				bonus,
				bps,
				starts,
				expected_goals,
				expected_assists,
				expected_goal_involvements,
				expected_goals_conceded,
				in_dream_team,
				total_points,
				created_at,
				updated_at,
				defensive_contribution
			FROM fpl.player_gameweek_stats
			WHERE season_id = $1
		`,
	},
	[V3_READ_MODELS.playerGameweekScoringItems]: {
		sourceRelations: ["fpl.player_gameweek_scoring_items"],
		sql: `
			SELECT
				MIN(source_explain_id) AS id,
				event_id,
				element_id,
				COALESCE(MAX(scoring_value) FILTER (WHERE scoring_identifier = 'bonus'), 0)::integer AS bonus,
				COALESCE(MAX(scoring_value) FILTER (WHERE scoring_identifier = 'minutes'), 0)::integer AS minutes,
				COALESCE(MAX(points) FILTER (WHERE scoring_identifier = 'minutes'), 0)::integer AS minutes_points,
				COALESCE(MAX(scoring_value) FILTER (WHERE scoring_identifier = 'goals_scored'), 0)::integer AS goals_scored,
				COALESCE(MAX(points) FILTER (WHERE scoring_identifier = 'goals_scored'), 0)::integer AS goals_scored_points,
				COALESCE(MAX(scoring_value) FILTER (WHERE scoring_identifier = 'assists'), 0)::integer AS assists,
				COALESCE(MAX(points) FILTER (WHERE scoring_identifier = 'assists'), 0)::integer AS assists_points,
				COALESCE(MAX(scoring_value) FILTER (WHERE scoring_identifier = 'clean_sheets'), 0)::integer AS clean_sheets,
				COALESCE(MAX(points) FILTER (WHERE scoring_identifier = 'clean_sheets'), 0)::integer AS clean_sheets_points,
				COALESCE(MAX(scoring_value) FILTER (WHERE scoring_identifier = 'goals_conceded'), 0)::integer AS goals_conceded,
				COALESCE(MAX(points) FILTER (WHERE scoring_identifier = 'goals_conceded'), 0)::integer AS goals_conceded_points,
				COALESCE(MAX(scoring_value) FILTER (WHERE scoring_identifier = 'own_goals'), 0)::integer AS own_goals,
				COALESCE(MAX(points) FILTER (WHERE scoring_identifier = 'own_goals'), 0)::integer AS own_goals_points,
				COALESCE(MAX(scoring_value) FILTER (WHERE scoring_identifier = 'penalties_saved'), 0)::integer AS penalties_saved,
				COALESCE(MAX(points) FILTER (WHERE scoring_identifier = 'penalties_saved'), 0)::integer AS penalties_saved_points,
				COALESCE(MAX(scoring_value) FILTER (WHERE scoring_identifier = 'penalties_missed'), 0)::integer AS penalties_missed,
				COALESCE(MAX(points) FILTER (WHERE scoring_identifier = 'penalties_missed'), 0)::integer AS penalties_missed_points,
				COALESCE(MAX(scoring_value) FILTER (WHERE scoring_identifier = 'yellow_cards'), 0)::integer AS yellow_cards,
				COALESCE(MAX(points) FILTER (WHERE scoring_identifier = 'yellow_cards'), 0)::integer AS yellow_cards_points,
				COALESCE(MAX(scoring_value) FILTER (WHERE scoring_identifier = 'red_cards'), 0)::integer AS red_cards,
				COALESCE(MAX(points) FILTER (WHERE scoring_identifier = 'red_cards'), 0)::integer AS red_cards_points,
				COALESCE(MAX(scoring_value) FILTER (WHERE scoring_identifier = 'saves'), 0)::integer AS saves,
				COALESCE(MAX(points) FILTER (WHERE scoring_identifier = 'saves'), 0)::integer AS saves_points,
				MIN(created_at) AS created_at,
				MAX(updated_at) AS updated_at,
				COALESCE(MAX(scoring_value) FILTER (WHERE scoring_identifier = 'defensive_contribution'), 0)::integer AS defensive_contribution,
				COALESCE(MAX(points) FILTER (WHERE scoring_identifier = 'defensive_contribution'), 0)::integer AS defensive_contribution_points
			FROM fpl.player_gameweek_scoring_items
			WHERE season_id = $1
			GROUP BY event_id, element_id
		`,
	},
	[V3_READ_MODELS.playerSeasonSummaries]: {
		sourceRelations: ["reporting.player_season_summaries"],
		sql: `
			SELECT
				season_id,
				element_id,
				element_type,
				gameweeks_available,
				gameweeks_started,
				minutes,
				goals_scored,
				assists,
				clean_sheets,
				goals_conceded,
				own_goals,
				penalties_saved,
				penalties_missed,
				yellow_cards,
				red_cards,
				saves,
				bonus,
				bps,
				total_points,
				defensive_contribution,
				expected_goals,
				expected_assists,
				expected_goal_involvements,
				expected_goals_conceded,
				dream_team_appearances
			FROM reporting.player_season_summaries
			WHERE season_id = $1
		`,
	},
	[V3_READ_MODELS.playerValueChanges]: {
		sourceRelations: ["reporting.player_value_changes"],
		sql: `
			SELECT
				source_value_id AS id,
				element_id,
				element_type,
				event_id,
				value,
				TO_CHAR(snapshot_date, 'YYYYMMDD') AS change_date,
				last_value,
				change_type
			FROM reporting.player_value_changes
			WHERE season_id = $1
		`,
	},
	[V3_READ_MODELS.playerMarketSnapshots]: {
		sourceRelations: ["fpl.player_market_snapshots"],
		sql: `
			SELECT
				source_snapshot_id AS id,
				snapshot_date,
				captured_at,
				element_id,
				player_code,
				web_name,
				first_name,
				second_name,
				team_id,
				team_name,
				team_short_name,
				element_type,
				position,
				price,
				selected_by_percent,
				transfers_in,
				transfers_out,
				transfers_in_event,
				transfers_out_event,
				status,
				news,
				news_added,
				chance_of_playing_this_round,
				chance_of_playing_next_round
			FROM fpl.player_market_snapshots
			WHERE season_id = $1
		`,
	},
	[V3_READ_MODELS.playerFixtureStats]: {
		sourceRelations: ["fpl.player_fixture_stats", "fpl.seasons"],
		sql: `
			SELECT
				stats.source_fixture_stat_id AS id,
				season.season_code AS season,
				stats.event_id,
				stats.fixture_id,
				stats.fixture_code,
				stats.element_id,
				stats.player_code,
				stats.team_id,
				stats.team_code,
				stats.element_type,
				stats.minutes,
				stats.starts,
				stats.goals,
				stats.assists,
				stats.own_goals,
				stats.yellow_cards,
				stats.red_cards,
				stats.source_hash,
				stats.created_at,
				stats.updated_at
			FROM fpl.player_fixture_stats stats
			JOIN fpl.seasons season ON season.season_id = stats.season_id
			WHERE stats.season_id = $1
		`,
	},
	[V3_READ_MODELS.understatSeasons]: {
		sourceRelations: ["understat.seasons", "fpl.seasons"],
		sql: `
			SELECT
				provider.season_code,
				provider.source_year,
				provider.league,
				provider.state,
				provider.first_seen_at,
				provider.last_seen_at,
				provider.created_at,
				provider.updated_at
			FROM understat.seasons provider
			JOIN fpl.seasons season ON season.season_code = provider.season_code
			WHERE season.season_id = $1
		`,
	},
	[V3_READ_MODELS.understatPlayerSeasons]: {
		sourceRelations: ["understat.player_seasons", "fpl.seasons"],
		sql: `
			SELECT
				metrics.season_code,
				metrics.player_id,
				metrics.source_name,
				metrics.source_team_title,
				metrics.games,
				metrics.time_minutes,
				metrics.goals,
				metrics.non_penalty_goals,
				metrics.assists,
				metrics.shots,
				metrics.key_passes,
				metrics.yellow_cards,
				metrics.red_cards,
				metrics.xg,
				metrics.non_penalty_xg,
				metrics.xa,
				metrics.xg_chain,
				metrics.xg_buildup,
				metrics.position,
				metrics.source_hash,
				metrics.created_at,
				metrics.updated_at
			FROM understat.player_seasons metrics
			JOIN fpl.seasons season ON season.season_code = metrics.season_code
			WHERE season.season_id = $1
		`,
	},
	[V3_READ_MODELS.bridgeEntityLinks]: {
		sourceRelations: ["bridge.entity_links"],
		sql: `
			SELECT
				link_id,
				entity_type,
				left_provider,
				left_entity_id,
				right_provider,
				right_entity_id,
				status,
				method,
				rule_version,
				evidence,
				first_seen_season,
				last_seen_season,
				reviewed_by,
				reviewed_at,
				created_at,
				updated_at
			FROM bridge.entity_links
			WHERE $1::smallint IS NOT NULL
		`,
	},
	[V3_READ_MODELS.entries]: {
		sourceRelations: ["competition.entries"],
		sql: `
			SELECT
				entry_id AS id,
				entry_name,
				player_name,
				region,
				started_event,
				overall_points,
				overall_rank,
				bank,
				team_value,
				total_transfers,
				last_entry_name,
				last_overall_points,
				last_overall_rank,
				last_team_value,
				used_entry_names,
				created_at,
				updated_at,
				last_bank,
				last_event_id,
				snapshot_synced_through_event_id AS entry_snapshot_synced_through_event_id,
				transfers_synced_through_event_id AS entry_transfers_synced_through_event_id,
				transfers_source_checked_at AS entry_transfers_source_checked_at
			FROM competition.entries
			WHERE season_id = $1
		`,
	},
	[V3_READ_MODELS.entryEventResults]: {
		sourceRelations: ["competition.entry_event_results", "competition.entry_event_picks"],
		sql: `
			SELECT
				result.source_result_id AS id,
				result.entry_id,
				result.event_id,
				result.event_points,
				result.event_transfers,
				result.event_transfers_cost,
				result.event_net_points,
				result.event_bench_points,
				result.event_auto_sub_points,
				result.event_rank,
				result.event_chip,
				result.played_captain_element_id AS event_played_captain,
				result.captain_points AS event_captain_points,
				COALESCE(picks.picks, '[]'::jsonb) AS event_picks,
				result.automatic_substitutions AS event_auto_sub,
				result.overall_points,
				result.overall_rank,
				result.team_value,
				result.bank,
				result.created_at,
				result.updated_at,
				result.rich_synced_at
			FROM competition.entry_event_results result
			LEFT JOIN LATERAL (
				SELECT jsonb_agg(
					jsonb_build_object(
						'element', pick.element_id,
						'position', pick.position,
						'multiplier', pick.multiplier,
						'is_captain', pick.is_captain,
						'is_vice_captain', pick.is_vice_captain
					)
					ORDER BY pick.position
				) AS picks
				FROM competition.entry_event_picks pick
				WHERE pick.season_id = result.season_id
				  AND pick.entry_id = result.entry_id
				  AND pick.event_id = result.event_id
			) picks ON TRUE
			WHERE result.season_id = $1
		`,
	},
	[V3_READ_MODELS.entryEventPicks]: {
		sourceRelations: ["competition.entry_event_picks"],
		sql: `
			SELECT
				MIN(source_pick_row_id) AS id,
				entry_id,
				event_id,
				(ARRAY_AGG(active_chip::text ORDER BY position))[1] AS chip,
				jsonb_agg(
					jsonb_build_object(
						'element', element_id,
						'position', position,
						'multiplier', multiplier,
						'is_captain', is_captain,
						'is_vice_captain', is_vice_captain
					)
					ORDER BY position
				) AS picks,
				MAX(transfers) AS transfers,
				MAX(transfers_cost) AS transfers_cost,
				MIN(source_created_at) AS created_at,
				MAX(source_updated_at) AS updated_at
			FROM competition.entry_event_picks
			WHERE season_id = $1
			GROUP BY entry_id, event_id
		`,
	},
	[V3_READ_MODELS.entryEventTransfers]: {
		sourceRelations: ["competition.entry_event_transfers"],
		sql: `
			SELECT
				transfer_id AS id,
				entry_id,
				event_id,
				element_in_id,
				element_in_cost,
				element_in_points,
				element_out_id,
				element_out_cost,
				element_out_points,
				transfer_time,
				created_at,
				updated_at,
				element_in_played
			FROM competition.entry_event_transfers
			WHERE season_id = $1
		`,
	},
	[V3_READ_MODELS.entrySeasonHistories]: {
		sourceRelations: ["competition.entry_season_histories"],
		sql: `
			SELECT
				source_history_id AS id,
				entry_id,
				source_season_label AS season,
				total_points,
				overall_rank,
				created_at,
				updated_at
			FROM competition.entry_season_histories
			WHERE season_id = $1
		`,
	},
	[V3_READ_MODELS.entryLeagues]: {
		sourceRelations: ["competition.entry_leagues"],
		sql: `
			SELECT
				source_entry_league_id AS id,
				entry_id,
				league_id,
				league_name,
				league_type,
				started_event,
				entry_rank,
				entry_last_rank,
				created_at,
				updated_at
			FROM competition.entry_leagues
			WHERE season_id = $1
		`,
	},
	[V3_READ_MODELS.leagueEventResults]: {
		sourceRelations: ["competition.league_event_results"],
		sql: `
			SELECT
				source_result_id AS id,
				league_id,
				entry_id,
				event_id,
				event_points,
				event_transfers,
				event_transfers_cost,
				event_net_points,
				overall_points,
				overall_rank,
				created_at,
				updated_at,
				league_type,
				entry_name,
				player_name,
				team_value,
				bank,
				event_bench_points,
				event_auto_sub_points,
				event_rank,
				event_chip,
				captain_element_id AS captain_id,
				captain_points,
				captain_blank,
				vice_captain_element_id AS vice_captain_id,
				vice_captain_points,
				vice_captain_blank,
				played_captain_element_id AS played_captain_id,
				highest_score_element_id,
				highest_score_points,
				highest_score_blank,
				source_checked_at
			FROM competition.league_event_results
			WHERE season_id = $1
		`,
	},
	[V3_READ_MODELS.tournaments]: {
		sourceRelations: ["competition.tournaments"],
		sql: `
			SELECT
				tournament_id AS id,
				name,
				creator,
				admin_entry_id,
				league_id,
				league_type,
				total_team_num,
				tournament_mode,
				group_mode,
				group_team_num,
				group_num,
				group_started_event_id,
				group_ended_event_id,
				group_auto_averages,
				group_rounds,
				group_play_against_num,
				group_qualify_num,
				knockout_mode,
				knockout_team_num,
				knockout_rounds,
				knockout_event_num,
				knockout_started_event_id,
				knockout_ended_event_id,
				knockout_play_against_num,
				state,
				created_at,
				updated_at,
				setup_status,
				setup_error,
				setup_started_at,
				setup_finished_at,
				source_league_name,
				roster_mode,
				roster_sync_status,
				roster_last_synced_at,
				roster_sync_error,
				setup_phase,
				setup_completed_units,
				setup_total_units,
				setup_progress_updated_at,
				standings_ready_at,
				setup_warning_count
			FROM competition.tournaments
			WHERE season_id = $1
		`,
	},
	[V3_READ_MODELS.tournamentEntries]: {
		sourceRelations: ["competition.tournament_entries"],
		sql: `
			SELECT
				entry_id AS id,
				tournament_id,
				league_id,
				entry_id,
				created_at
			FROM competition.tournament_entries
			WHERE season_id = $1
		`,
	},
	[V3_READ_MODELS.tournamentBattleGroupResults]: {
		sourceRelations: ["competition.tournament_battle_group_results"],
		sql: `
			SELECT
				source_result_id AS id,
				tournament_id,
				group_id,
				event_id,
				home_index,
				home_entry_id,
				home_net_points,
				home_rank,
				home_match_points,
				away_index,
				away_entry_id,
				away_net_points,
				away_rank,
				away_match_points,
				created_at,
				updated_at
			FROM competition.tournament_battle_group_results
			WHERE season_id = $1
		`,
	},
	[V3_READ_MODELS.tournamentSelectionStats]: {
		sourceRelations: ["reporting.tournament_selection_stats"],
		sql: `
			SELECT
				tournament_id,
				event_id,
				element_id,
				selected_count AS pick_count,
				captain_count,
				vice_captain_count,
				transfer_in_count,
				transfer_out_count,
				total_entries,
				selection_percentage,
				captain_percentage,
				vice_captain_percentage,
				effective_ownership_percentage,
				NULL::timestamptz AS created_at,
				NULL::timestamptz AS updated_at
			FROM reporting.tournament_selection_stats
			WHERE season_id = $1
		`,
	},
	[V3_READ_MODELS.tournamentEventResults]: {
		sourceRelations: [
			"reporting.tournament_entry_event_summaries",
			"competition.tournament_points_group_results",
			"competition.tournaments",
			"competition.entries",
		],
		sql: `
			SELECT
				summary.tournament_id,
				summary.event_id,
				summary.entry_id,
				group_result.group_id,
				group_result.event_group_rank,
				summary.event_points,
				summary.event_transfers_cost AS event_cost,
				summary.event_net_points,
				summary.event_rank,
				summary.overall_points,
				summary.overall_rank,
				summary.event_chip,
				summary.played_captain_element_id AS captain_id,
				summary.captain_points,
				summary.team_value,
				summary.bank,
				entry.entry_name,
				entry.player_name,
				tournament.tournament_id AS _tournament_id,
				tournament.name AS _tournament_name,
				tournament.creator AS _tournament_creator,
				tournament.admin_entry_id AS _tournament_admin_entry_id,
				tournament.league_id AS _tournament_league_id,
				tournament.league_type AS _tournament_league_type,
				tournament.total_team_num AS _tournament_total_team_num,
				tournament.tournament_mode AS _tournament_tournament_mode,
				tournament.group_mode AS _tournament_group_mode,
				tournament.group_team_num AS _tournament_group_team_num,
				tournament.group_num AS _tournament_group_num,
				tournament.group_started_event_id AS _tournament_group_started_event_id,
				tournament.group_ended_event_id AS _tournament_group_ended_event_id,
				tournament.group_auto_averages AS _tournament_group_auto_averages,
				tournament.group_rounds AS _tournament_group_rounds,
				tournament.group_play_against_num AS _tournament_group_play_against_num,
				tournament.group_qualify_num AS _tournament_group_qualify_num,
				tournament.knockout_mode AS _tournament_knockout_mode,
				tournament.knockout_team_num AS _tournament_knockout_team_num,
				tournament.knockout_rounds AS _tournament_knockout_rounds,
				tournament.knockout_event_num AS _tournament_knockout_event_num,
				tournament.knockout_started_event_id AS _tournament_knockout_started_event_id,
				tournament.knockout_ended_event_id AS _tournament_knockout_ended_event_id,
				tournament.knockout_play_against_num AS _tournament_knockout_play_against_num,
				tournament.state AS _tournament_state,
				tournament.created_at AS _tournament_created_at,
				tournament.updated_at AS _tournament_updated_at
			FROM reporting.tournament_entry_event_summaries summary
			JOIN competition.tournaments tournament
			  ON tournament.season_id = summary.season_id
			 AND tournament.tournament_id = summary.tournament_id
			JOIN competition.entries entry
			  ON entry.season_id = summary.season_id
			 AND entry.entry_id = summary.entry_id
			LEFT JOIN competition.tournament_points_group_results group_result
			  ON group_result.season_id = summary.season_id
			 AND group_result.tournament_id = summary.tournament_id
			 AND group_result.event_id = summary.event_id
			 AND group_result.entry_id = summary.entry_id
			WHERE summary.season_id = $1
		`,
	},
	[V3_READ_MODELS.tournamentEntryEventSummaries]: {
		sourceRelations: ["reporting.tournament_entry_event_summaries", "competition.tournaments"],
		sql: `
			SELECT
				summary.tournament_id,
				summary.event_id,
				summary.entry_id,
				tournament.group_mode,
				summary.tournament_event_rank AS tournament_overall_rank,
				summary.overall_rank,
				summary.team_value,
				summary.cumulative_transfers AS cum_transfers_num,
				summary.cumulative_transfer_cost AS cum_total_costs,
				summary.cumulative_bench_points AS cum_total_bench_points,
				summary.cumulative_auto_sub_points AS cum_auto_sub_points,
				RANK() OVER (
					PARTITION BY summary.tournament_id, summary.event_id
					ORDER BY summary.team_value DESC NULLS LAST, summary.entry_id
				) AS tournament_team_value_rank,
				RANK() OVER (
					PARTITION BY summary.tournament_id, summary.event_id
					ORDER BY summary.cumulative_transfers ASC NULLS LAST, summary.entry_id
				) AS tournament_transfers_rank,
				RANK() OVER (
					PARTITION BY summary.tournament_id, summary.event_id
					ORDER BY summary.cumulative_transfer_cost ASC NULLS LAST, summary.entry_id
				) AS tournament_costs_rank,
				RANK() OVER (
					PARTITION BY summary.tournament_id, summary.event_id
					ORDER BY summary.cumulative_bench_points DESC NULLS LAST, summary.entry_id
				) AS tournament_bench_points_rank,
				RANK() OVER (
					PARTITION BY summary.tournament_id, summary.event_id
					ORDER BY summary.cumulative_auto_sub_points DESC NULLS LAST, summary.entry_id
				) AS tournament_auto_sub_rank,
				summary.cumulative_captain_points AS cum_total_captain_points
			FROM reporting.tournament_entry_event_summaries summary
			JOIN competition.tournaments tournament
			  ON tournament.season_id = summary.season_id
			 AND tournament.tournament_id = summary.tournament_id
			WHERE summary.season_id = $1
		`,
	},
};

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

const quoteIdentifier = (identifier: string): string => {
	if (!IDENTIFIER.test(identifier)) {
		throw new Error(`Invalid read-model identifier: ${identifier}`);
	}
	return `"${identifier}"`;
};

const parseProjection = (projection: string): string => {
	const trimmed = projection.trim();
	if (trimmed === "*") return "*";
	const columns = trimmed
		.split(",")
		.map((column) => column.trim())
		.filter(Boolean);
	if (columns.length === 0) throw new Error("A read-model projection cannot be empty");
	return columns.map(quoteIdentifier).join(", ");
};

export type V3ReadError = Readonly<{
	message: string;
	code?: string;
	details?: string;
}>;

export type V3ReadResult<Row> = Readonly<{
	data: Row[] | null;
	error: V3ReadError | null;
}>;

type ComparisonFilter = Readonly<{
	kind: "comparison";
	column: string;
	operator: "=" | "<>" | ">" | ">=" | "<" | "<=" | "IS" | "IS NOT" | "ANY";
	value: unknown;
}>;

type OrFilter = Readonly<{
	kind: "or";
	alternatives: readonly Readonly<{ column: string; value: string }>[];
}>;

type Filter = ComparisonFilter | OrFilter;

type Order = Readonly<{ column: string; ascending: boolean; nullsFirst?: boolean }>;

const asReadError = (error: unknown): V3ReadError => {
	if (error instanceof Error) {
		const withCode = error as Error & { code?: unknown; detail?: unknown };
		return {
			message: error.message,
			...(typeof withCode.code === "string" ? { code: withCode.code } : {}),
			...(typeof withCode.detail === "string" ? { details: withCode.detail } : {}),
		};
	}
	return { message: "Unknown PostgreSQL read failure" };
};

class V3ReadQuery<Row extends QueryResultRow = QueryResultRow> implements PromiseLike<
	V3ReadResult<Row>
> {
	private projection = "*";
	private readonly filters: Filter[] = [];
	private readonly orders: Order[] = [];
	private limitValue: number | null = null;
	private offsetValue = 0;

	constructor(
		private readonly executor: QueryExecutor,
		private readonly seasonId: number,
		private readonly definition: ReadModelDefinition
	) {}

	select(projection = "*"): this {
		this.projection = parseProjection(projection);
		return this;
	}

	eq(column: string, value: unknown): this {
		return this.addFilter(column, "=", value);
	}

	neq(column: string, value: unknown): this {
		return this.addFilter(column, "<>", value);
	}

	gt(column: string, value: unknown): this {
		return this.addFilter(column, ">", value);
	}

	gte(column: string, value: unknown): this {
		return this.addFilter(column, ">=", value);
	}

	lt(column: string, value: unknown): this {
		return this.addFilter(column, "<", value);
	}

	lte(column: string, value: unknown): this {
		return this.addFilter(column, "<=", value);
	}

	in(column: string, values: readonly unknown[]): this {
		return this.addFilter(column, "ANY", values);
	}

	is(column: string, value: null): this {
		return this.addFilter(column, "IS", value);
	}

	not(column: string, operator: "is", value: null): this {
		if (operator !== "is") throw new Error(`Unsupported read-model NOT operator: ${operator}`);
		return this.addFilter(column, "IS NOT", value);
	}

	or(expression: string): this {
		const alternatives = expression.split(",").map((candidate) => candidate.trim());
		if (alternatives.length < 2) throw new Error("Read-model OR requires at least two clauses");
		const parsed = alternatives.map((candidate) => {
			const match = candidate.match(/^([a-z_][a-z0-9_]*)\.eq\.(.+)$/);
			if (!match) throw new Error(`Unsupported read-model OR clause: ${candidate}`);
			quoteIdentifier(match[1]);
			return { column: match[1], value: match[2] };
		});
		this.filters.push({ kind: "or", alternatives: parsed });
		return this;
	}

	order(column: string, options: { ascending?: boolean; nullsFirst?: boolean } = {}): this {
		quoteIdentifier(column);
		this.orders.push({
			column,
			ascending: options.ascending !== false,
			...(options.nullsFirst === undefined ? {} : { nullsFirst: options.nullsFirst }),
		});
		return this;
	}

	limit(value: number): this {
		if (!Number.isInteger(value) || value < 0)
			throw new Error("Read-model limit must be non-negative");
		this.limitValue = value;
		return this;
	}

	range(from: number, to: number): this {
		if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from) {
			throw new Error("Invalid read-model range");
		}
		this.offsetValue = from;
		this.limitValue = to - from + 1;
		return this;
	}

	async maybeSingle(): Promise<Readonly<{ data: Row | null; error: V3ReadError | null }>> {
		const result = await this.execute();
		if (result.error || !result.data) return { data: null, error: result.error };
		if (result.data.length > 1) {
			return {
				data: null,
				error: { code: "PGRST116", message: "Expected at most one row" },
			};
		}
		return { data: result.data[0] ?? null, error: null };
	}

	then<TResult1 = V3ReadResult<Row>, TResult2 = never>(
		onfulfilled?: ((value: V3ReadResult<Row>) => TResult1 | PromiseLike<TResult1>) | null,
		onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
	): PromiseLike<TResult1 | TResult2> {
		return this.execute().then(onfulfilled, onrejected);
	}

	private addFilter(column: string, operator: ComparisonFilter["operator"], value: unknown): this {
		quoteIdentifier(column);
		this.filters.push({ kind: "comparison", column, operator, value });
		return this;
	}

	private async execute(): Promise<V3ReadResult<Row>> {
		const values: unknown[] = [this.seasonId];
		const where: string[] = [];
		for (const filter of this.filters) {
			if (filter.kind === "or") {
				const alternatives = filter.alternatives.map(({ column, value }) => {
					values.push(value);
					return `${quoteIdentifier(column)} = $${values.length}`;
				});
				where.push(`(${alternatives.join(" OR ")})`);
				continue;
			}
			const column = quoteIdentifier(filter.column);
			if (filter.operator === "IS" || filter.operator === "IS NOT") {
				where.push(`${column} ${filter.operator} NULL`);
				continue;
			}
			values.push(filter.value);
			where.push(
				filter.operator === "ANY"
					? `${column} = ANY($${values.length})`
					: `${column} ${filter.operator} $${values.length}`
			);
		}

		const orderSql = this.orders.length
			? ` ORDER BY ${this.orders
					.map(
						(order) =>
							`${quoteIdentifier(order.column)} ${order.ascending ? "ASC" : "DESC"}${
								order.nullsFirst === undefined
									? ""
									: order.nullsFirst
										? " NULLS FIRST"
										: " NULLS LAST"
							}`
					)
					.join(", ")}`
			: "";
		const limitSql = this.limitValue === null ? "" : ` LIMIT ${this.limitValue}`;
		const offsetSql = this.offsetValue === 0 ? "" : ` OFFSET ${this.offsetValue}`;
		const sql = `
			SELECT ${this.projection}
			FROM (${this.definition.sql}) AS read_model
			${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
			${orderSql}${limitSql}${offsetSql}
		`;

		try {
			const result = await this.executor.query<Row>(sql, values);
			return { data: result.rows, error: null };
		} catch (error) {
			return { data: null, error: asReadError(error) };
		}
	}
}

export class V3ReadClient {
	constructor(
		private readonly executor: QueryExecutor,
		readonly currentSeason: CurrentSeason
	) {}

	read<Row extends QueryResultRow = QueryResultRow>(model: V3ReadModel): V3ReadQuery<Row> {
		const definition = READ_MODEL_DEFINITIONS[model];
		if (!definition) throw new Error(`Unknown Data Platform v3 read model: ${String(model)}`);
		return new V3ReadQuery<Row>(this.executor, this.currentSeason.seasonId, definition);
	}

	async probe(): Promise<void> {
		for (const [model, definition] of Object.entries(READ_MODEL_DEFINITIONS)) {
			try {
				await this.executor.query(`SELECT * FROM (${definition.sql}) AS read_model LIMIT 0`, [
					this.currentSeason.seasonId,
				]);
			} catch (error) {
				throw new Error(`Data Platform v3 read model is unavailable: ${model}`, { cause: error });
			}
		}
	}

	static sourceRelations(): readonly string[] {
		return [
			...new Set(
				Object.values(READ_MODEL_DEFINITIONS).flatMap((definition) => definition.sourceRelations)
			),
		].sort();
	}
}
