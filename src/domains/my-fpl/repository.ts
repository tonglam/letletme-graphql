import { GraphQLError } from "graphql";
import type { QueryResultRow } from "pg";
import type { DataSqlContractProbe } from "../../contracts/data-sql-contract";
import {
	GRAPHQL_DATA_CONTRACT_LEAGUE_ONLY_TOURNAMENT_ID,
	GRAPHQL_DATA_CONTRACT_TOURNAMENT_ID,
} from "../../contracts/data-fixture-identities";
import { normalizeFplChip } from "../../contracts/fpl-chip";
import { isPlainRecord as isRecord } from "../../contracts/guards";
import type { GraphQLContext } from "../../graphql/context";
import { viewerEntryIdForPrincipal } from "../../graphql/authorization";
import { gqlCacheKey } from "../../infra/cache-key";
import { getCoreEventSnapshot, type CoreSelectionRules } from "../../infra/data-snapshot";
import { QUERY_CACHE_TTL_SECONDS, writeQueryCache } from "../../infra/query-cache";
import { entriesService } from "../entries/service";
import {
	GroupMode,
	TournamentSetupStatus,
	tournamentsRepository,
	type TournamentInfo,
} from "../tournaments/repository";
import { readMyFplCache } from "./cache";
import { createMyFplEntryNameProjection } from "./entry-name-projection";

export const MY_FPL_EVENT_LIFECYCLE_SQL = `
	SELECT event_id, finished, data_checked, live_snapshot_finalized_at
	FROM fpl.events
	WHERE season_id = $1
	ORDER BY event_id
`;

export const MY_FPL_ACTIVE_PUBLICATIONS_SQL = `
	SELECT publication.season_id, publication.event_id, publication.revision,
		publication.snapshot_date, publication.source_checked_at,
		publication.published_at, publication.kind, publication.expected_entry_count,
		publication.ready_entry_count, publication.empty_entry_count,
		publication.not_applicable_entry_count, publication.expected_tournament_count,
		publication.ready_tournament_count, publication.content_sha256,
		publication.entry_scope_sha256, publication.tournament_scope_sha256,
		publication.score_source, publication.live_publication_id,
		publication.live_revision, publication.algorithm_version,
		publication.source_min_checked_at, publication.source_max_checked_at,
		status.finished AS lifecycle_finished,
		status.data_checked AS lifecycle_data_checked,
		status.finalization_started_at AS finalization_started_at,
		status.finalization_due_at AS finalization_due_at,
		status.expected_entry_count AS status_expected_entry_count,
		status.observed_entry_count AS observed_entry_count,
		status.pending_correction_entry_count AS pending_correction_entry_count,
		status.expected_tournament_count AS status_expected_tournament_count,
		status.observed_tournament_count AS observed_tournament_count,
		status.coverage_state AS coverage_state,
		status.expected_entry_scope_sha256 AS expected_entry_scope_sha256,
		status.observed_entry_scope_sha256 AS observed_entry_scope_sha256,
		status.expected_tournament_scope_sha256 AS expected_tournament_scope_sha256,
		status.observed_tournament_scope_sha256 AS observed_tournament_scope_sha256
	FROM competition.my_fpl_snapshot_publications publication
	JOIN reporting.my_fpl_active_snapshot_status status
		ON status.season_id = publication.season_id
		AND status.event_id = publication.event_id
		AND status.revision = publication.revision
	LEFT JOIN fpl.events lifecycle
		ON lifecycle.season_id = publication.season_id
		AND lifecycle.event_id = publication.event_id
	WHERE publication.season_id = $1 AND publication.active
	ORDER BY publication.event_id
`;

export const MY_FPL_PUBLICATION_BY_EVENT_REVISION_SQL = `
	SELECT publication.season_id, publication.event_id, publication.revision,
		publication.snapshot_date, publication.source_checked_at,
		publication.published_at, publication.kind, publication.expected_entry_count,
		publication.ready_entry_count, publication.empty_entry_count,
		publication.not_applicable_entry_count, publication.expected_tournament_count,
		publication.ready_tournament_count, publication.content_sha256,
		publication.entry_scope_sha256, publication.tournament_scope_sha256,
		publication.score_source, publication.live_publication_id,
		publication.live_revision, publication.algorithm_version,
		publication.source_min_checked_at, publication.source_max_checked_at,
		CASE WHEN publication.active THEN status.finished
			ELSE COALESCE(status.finished, lifecycle.finished, false) END AS lifecycle_finished,
		CASE WHEN publication.active THEN status.data_checked
			ELSE COALESCE(status.data_checked, lifecycle.data_checked, false) END AS lifecycle_data_checked,
		CASE WHEN publication.active THEN status.finalization_started_at
			ELSE COALESCE(status.finalization_started_at, lifecycle.data_checked_at) END AS finalization_started_at,
		CASE WHEN publication.active THEN status.finalization_due_at
			ELSE COALESCE(
				status.finalization_due_at,
				CASE WHEN lifecycle.data_checked_at IS NULL THEN NULL
					ELSE lifecycle.data_checked_at + interval '4500 seconds' END
			) END AS finalization_due_at,
		CASE WHEN publication.active THEN status.expected_entry_count
			ELSE COALESCE(status.expected_entry_count, publication.expected_entry_count) END AS status_expected_entry_count,
		CASE WHEN publication.active THEN status.observed_entry_count
			ELSE COALESCE(status.observed_entry_count, publication.ready_entry_count + publication.empty_entry_count)
			END AS observed_entry_count,
		CASE WHEN publication.active THEN status.pending_correction_entry_count
			ELSE COALESCE(
				status.pending_correction_entry_count,
				GREATEST(publication.expected_entry_count - publication.ready_entry_count - publication.empty_entry_count, 0)
			) END AS pending_correction_entry_count,
		CASE WHEN publication.active THEN status.expected_tournament_count
			ELSE COALESCE(status.expected_tournament_count, publication.expected_tournament_count)
			END AS status_expected_tournament_count,
		CASE WHEN publication.active THEN status.observed_tournament_count
			ELSE COALESCE(status.observed_tournament_count, publication.ready_tournament_count)
			END AS observed_tournament_count,
		CASE WHEN publication.active THEN status.coverage_state
			ELSE COALESCE(
				status.coverage_state,
				CASE WHEN publication.ready_entry_count + publication.empty_entry_count = publication.expected_entry_count
					AND publication.ready_tournament_count = publication.expected_tournament_count
					THEN 'COMPLETE' ELSE 'CORRECTION_PENDING' END
			) END AS coverage_state,
		CASE WHEN publication.active THEN status.expected_entry_scope_sha256
			ELSE publication.entry_scope_sha256 END AS expected_entry_scope_sha256,
		CASE WHEN publication.active THEN status.observed_entry_scope_sha256
			ELSE publication.entry_scope_sha256 END AS observed_entry_scope_sha256,
		CASE WHEN publication.active THEN status.expected_tournament_scope_sha256
			ELSE publication.tournament_scope_sha256 END AS expected_tournament_scope_sha256,
		CASE WHEN publication.active THEN status.observed_tournament_scope_sha256
			ELSE publication.tournament_scope_sha256 END AS observed_tournament_scope_sha256
	FROM competition.my_fpl_snapshot_publications publication
	LEFT JOIN reporting.my_fpl_active_snapshot_status status
		ON status.season_id = publication.season_id
		AND status.event_id = publication.event_id
		AND status.revision = publication.revision
	LEFT JOIN fpl.events lifecycle
		ON lifecycle.season_id = publication.season_id
		AND lifecycle.event_id = publication.event_id
	WHERE publication.season_id = $1
		AND publication.event_id = $2
		AND publication.revision = $3::bigint
		AND (NOT publication.active OR status.revision IS NOT NULL)
	LIMIT 1
`;

export const MY_FPL_PUBLICATION_BY_REVISION_SQL = `
	SELECT publication.season_id, publication.event_id, publication.revision,
		publication.snapshot_date, publication.source_checked_at,
		publication.published_at, publication.kind, publication.expected_entry_count,
		publication.ready_entry_count, publication.empty_entry_count,
		publication.not_applicable_entry_count, publication.expected_tournament_count,
		publication.ready_tournament_count, publication.content_sha256,
		publication.entry_scope_sha256, publication.tournament_scope_sha256,
		publication.score_source, publication.live_publication_id,
		publication.live_revision, publication.algorithm_version,
		publication.source_min_checked_at, publication.source_max_checked_at,
		CASE WHEN publication.active THEN status.finished
			ELSE COALESCE(status.finished, lifecycle.finished, false) END AS lifecycle_finished,
		CASE WHEN publication.active THEN status.data_checked
			ELSE COALESCE(status.data_checked, lifecycle.data_checked, false) END AS lifecycle_data_checked,
		CASE WHEN publication.active THEN status.finalization_started_at
			ELSE COALESCE(status.finalization_started_at, lifecycle.data_checked_at) END AS finalization_started_at,
		CASE WHEN publication.active THEN status.finalization_due_at
			ELSE COALESCE(
				status.finalization_due_at,
				CASE WHEN lifecycle.data_checked_at IS NULL THEN NULL
					ELSE lifecycle.data_checked_at + interval '4500 seconds' END
			) END AS finalization_due_at,
		CASE WHEN publication.active THEN status.expected_entry_count
			ELSE COALESCE(status.expected_entry_count, publication.expected_entry_count) END AS status_expected_entry_count,
		CASE WHEN publication.active THEN status.observed_entry_count
			ELSE COALESCE(status.observed_entry_count, publication.ready_entry_count + publication.empty_entry_count)
			END AS observed_entry_count,
		CASE WHEN publication.active THEN status.pending_correction_entry_count
			ELSE COALESCE(
				status.pending_correction_entry_count,
				GREATEST(publication.expected_entry_count - publication.ready_entry_count - publication.empty_entry_count, 0)
			) END AS pending_correction_entry_count,
		CASE WHEN publication.active THEN status.expected_tournament_count
			ELSE COALESCE(status.expected_tournament_count, publication.expected_tournament_count)
			END AS status_expected_tournament_count,
		CASE WHEN publication.active THEN status.observed_tournament_count
			ELSE COALESCE(status.observed_tournament_count, publication.ready_tournament_count)
			END AS observed_tournament_count,
		CASE WHEN publication.active THEN status.coverage_state
			ELSE COALESCE(
				status.coverage_state,
				CASE WHEN publication.ready_entry_count + publication.empty_entry_count = publication.expected_entry_count
					AND publication.ready_tournament_count = publication.expected_tournament_count
					THEN 'COMPLETE' ELSE 'CORRECTION_PENDING' END
			) END AS coverage_state,
		CASE WHEN publication.active THEN status.expected_entry_scope_sha256
			ELSE publication.entry_scope_sha256 END AS expected_entry_scope_sha256,
		CASE WHEN publication.active THEN status.observed_entry_scope_sha256
			ELSE publication.entry_scope_sha256 END AS observed_entry_scope_sha256,
		CASE WHEN publication.active THEN status.expected_tournament_scope_sha256
			ELSE publication.tournament_scope_sha256 END AS expected_tournament_scope_sha256,
		CASE WHEN publication.active THEN status.observed_tournament_scope_sha256
			ELSE publication.tournament_scope_sha256 END AS observed_tournament_scope_sha256
	FROM competition.my_fpl_snapshot_publications publication
	LEFT JOIN reporting.my_fpl_active_snapshot_status status
		ON status.season_id = publication.season_id
		AND status.event_id = publication.event_id
		AND status.revision = publication.revision
	LEFT JOIN fpl.events lifecycle
		ON lifecycle.season_id = publication.season_id
		AND lifecycle.event_id = publication.event_id
	WHERE publication.season_id = $1
		AND publication.revision = $2::bigint
		AND (NOT publication.active OR status.revision IS NOT NULL)
	ORDER BY publication.event_id
	LIMIT 1
`;

export const MY_FPL_SNAPSHOT_ENTRY_SQL = `
	SELECT
		snapshot.payload, snapshot.is_empty, snapshot.picks_count,
		publication.expected_entry_count + publication.not_applicable_entry_count AS entry_row_count,
		publication.expected_tournament_count AS aggregate_row_count
	FROM competition.my_fpl_snapshot_publications publication
	JOIN competition.my_fpl_snapshot_entries snapshot
		ON snapshot.season_id = publication.season_id
		AND snapshot.event_id = publication.event_id
		AND snapshot.revision = publication.revision
		AND snapshot.entry_id = $2
	WHERE publication.season_id = $1
		AND publication.event_id = $3
		AND publication.revision = $4::bigint
	LIMIT 1
`;

export const MY_FPL_SNAPSHOT_TOURNAMENT_ROW_VISIBILITY_SQL = `
	SELECT payload
	FROM competition.my_fpl_snapshot_tournament_rows
	WHERE season_id = $1
		AND event_id = $2
		AND revision = $3::bigint
		AND tournament_id = $4
		AND entry_id = $5
	LIMIT 1
`;

export const MY_FPL_CURRENT_TOURNAMENT_MEMBERSHIPS_SQL = `
	SELECT tournament_id
	FROM competition.tournament_entries
	WHERE season_id = $1 AND entry_id = $2
	UNION
	SELECT tracked_tournament.tournament_id
	FROM competition.entry_leagues entry_league
	JOIN LATERAL (
		SELECT tournament.tournament_id
		FROM competition.tournaments tournament
		WHERE tournament.season_id = entry_league.season_id
			AND tournament.league_id = entry_league.league_id
			AND tournament.league_type = entry_league.league_type
		ORDER BY tournament.tournament_id
		LIMIT 1
	) tracked_tournament ON TRUE
	WHERE entry_league.season_id = $1 AND entry_league.entry_id = $2
`;

export const MY_FPL_ASSERT_TOURNAMENT_MEMBERSHIP_SQL = `
	SELECT tournament_id
	FROM (${MY_FPL_CURRENT_TOURNAMENT_MEMBERSHIPS_SQL}) membership
	WHERE tournament_id = $3
	LIMIT 1
`;

/** A direct probe for the tracked-league source, independent of roster membership. */
export const MY_FPL_LEAGUE_ONLY_MEMBERSHIP_SQL = `
	SELECT tracked_tournament.tournament_id
	FROM competition.entry_leagues entry_league
	JOIN LATERAL (
		SELECT tournament.tournament_id
		FROM competition.tournaments tournament
		WHERE tournament.season_id = entry_league.season_id
			AND tournament.league_id = entry_league.league_id
			AND tournament.league_type = entry_league.league_type
		ORDER BY tournament.tournament_id
		LIMIT 1
	) tracked_tournament ON TRUE
	WHERE entry_league.season_id = $1
		AND entry_league.entry_id = $2
		AND tracked_tournament.tournament_id = $3
	LIMIT 1
`;

export const MY_FPL_LIST_TOURNAMENT_MEMBERSHIPS_SQL = `
	SELECT tournament_id
	FROM (${MY_FPL_CURRENT_TOURNAMENT_MEMBERSHIPS_SQL}) membership
	ORDER BY tournament_id
`;

export const MY_FPL_COMPETITION_BOARD_SQL = `
	WITH board AS MATERIALIZED (
		SELECT snapshot.entry_id,
			snapshot.payload || jsonb_build_object('entryName', entry.entry_name) AS payload
		FROM competition.my_fpl_snapshot_tournament_rows snapshot
		JOIN competition.entries entry
			ON entry.season_id = snapshot.season_id
			AND entry.entry_id = snapshot.entry_id
		WHERE snapshot.season_id = $1 AND snapshot.event_id = $2
			AND snapshot.revision = $3::bigint AND snapshot.tournament_id = $4
	), filtered AS MATERIALIZED (
		SELECT * FROM board
		WHERE $5 = ''
			OR payload->>'entryName' ILIKE '%' || $5 || '%'
			OR payload->>'playerName' ILIKE '%' || $5 || '%'
	), paged AS (
		SELECT * FROM filtered
		ORDER BY CASE WHEN payload->>'groupId' ~ '^-?[0-9]+$'
			THEN CASE WHEN (payload->>'groupId')::numeric BETWEEN -2147483648 AND 2147483647
				THEN (payload->>'groupId')::integer END END NULLS LAST,
			CASE WHEN payload->>'rank' ~ '^-?[0-9]+$'
			THEN CASE WHEN (payload->>'rank')::numeric BETWEEN -2147483648 AND 2147483647
				THEN (payload->>'rank')::integer END END NULLS LAST,
			entry_id
		LIMIT $6 OFFSET $7
	)
	SELECT
		(SELECT count(*)::integer FROM board) AS field_size,
		(SELECT count(*)::integer FROM filtered) AS total_rows,
		COALESCE((SELECT jsonb_agg(payload || jsonb_build_object('__snapshotEntryId', entry_id)
			ORDER BY CASE WHEN payload->>'groupId' ~ '^-?[0-9]+$'
			THEN CASE WHEN (payload->>'groupId')::numeric BETWEEN -2147483648 AND 2147483647
				THEN (payload->>'groupId')::integer END END NULLS LAST,
			CASE WHEN payload->>'rank' ~ '^-?[0-9]+$'
			THEN CASE WHEN (payload->>'rank')::numeric BETWEEN -2147483648 AND 2147483647
				THEN (payload->>'rank')::integer END END NULLS LAST,
			entry_id) FROM paged), '[]'::jsonb) AS rows,
		(SELECT count(*)::integer FROM board
			WHERE ((payload->>'groupId') IS NOT NULL
				AND CASE WHEN payload->>'groupId' ~ '^-?[0-9]+$'
				THEN (payload->>'groupId')::numeric NOT BETWEEN -2147483648 AND 2147483647
				ELSE TRUE END)
			OR ((payload->>'rank') IS NOT NULL
				AND CASE WHEN payload->>'rank' ~ '^-?[0-9]+$'
				THEN (payload->>'rank')::numeric NOT BETWEEN -2147483648 AND 2147483647
				ELSE TRUE END)) AS invalid_row_count,
		(SELECT CASE WHEN aggregate.payload->>'entryCount' ~ '^[0-9]+$'
			THEN (aggregate.payload->>'entryCount')::integer END
		FROM competition.my_fpl_snapshot_tournament_aggregates aggregate
		WHERE aggregate.season_id = $1
			AND aggregate.event_id = $2
			AND aggregate.revision = $3::bigint
			AND aggregate.tournament_id = $4
		) AS expected_field_size,
		(SELECT payload || jsonb_build_object('__snapshotEntryId', entry_id)
			FROM board WHERE entry_id = $8 LIMIT 1) AS viewer_row
`;

export const MY_FPL_COMPETITION_AGGREGATE_SQL = `
	SELECT aggregate.payload
	FROM competition.my_fpl_snapshot_tournament_aggregates aggregate
	WHERE aggregate.season_id = $1
		AND aggregate.event_id = $2
		AND aggregate.revision = $3::bigint
		AND aggregate.tournament_id = $4
		AND EXISTS (
			SELECT 1 FROM competition.my_fpl_snapshot_publications publication
			WHERE publication.season_id = aggregate.season_id
				AND publication.event_id = aggregate.event_id
				AND publication.revision = aggregate.revision
		)
	LIMIT 1
`;

export const MY_FPL_COMPETITION_SEASON_PATH_SQL = `
	SELECT payload
	FROM competition.my_fpl_snapshot_tournament_aggregates
	WHERE season_id = $1 AND event_id = $2 AND revision = $3::bigint AND tournament_id = $4
	LIMIT 1
`;

export const MY_FPL_COMPETITION_SETUP_STATUS_SQL = `
	SELECT setup_status::text, setup_phase::text, setup_completed_units,
		setup_total_units, setup_progress_updated_at, standings_ready_at,
		insights_ready_at,
		setup_warning_count
	FROM competition.tournaments
	WHERE season_id = $1 AND tournament_id = $2
	LIMIT 1
`;

export const MY_FPL_DATA_SQL_CONTRACT: readonly DataSqlContractProbe[] = [
	{ name: "my-fpl.event-lifecycle", sql: MY_FPL_EVENT_LIFECYCLE_SQL, values: [2026] },
	{
		name: "my-fpl.active-publications",
		sql: MY_FPL_ACTIVE_PUBLICATIONS_SQL,
		values: [2026],
		runtime: "must-return-publication",
		resultTypes: [
			{
				relation: "competition.my_fpl_snapshot_publications",
				column: "season_id",
				pgType: "smallint",
			},
			{
				relation: "competition.my_fpl_snapshot_publications",
				column: "event_id",
				pgType: "integer",
				acceptedPgTypes: ["smallint"],
			},
			{
				relation: "competition.my_fpl_snapshot_publications",
				column: "revision",
				pgType: "bigint",
			},
			{
				relation: "competition.my_fpl_snapshot_publications",
				column: "snapshot_date",
				pgType: "date",
			},
			{
				relation: "competition.my_fpl_snapshot_publications",
				column: "source_checked_at",
				pgType: "timestamp with time zone",
			},
			{
				relation: "competition.my_fpl_snapshot_publications",
				column: "published_at",
				pgType: "timestamp with time zone",
			},
			{
				relation: "competition.my_fpl_snapshot_publications",
				column: "kind",
				pgType: "text",
				acceptedPgTypes: ["character varying"],
			},
			{
				relation: "competition.my_fpl_snapshot_publications",
				column: "expected_entry_count",
				pgType: "integer",
			},
			{
				relation: "competition.my_fpl_snapshot_publications",
				column: "ready_entry_count",
				pgType: "integer",
			},
			{
				relation: "competition.my_fpl_snapshot_publications",
				column: "empty_entry_count",
				pgType: "integer",
			},
			{
				relation: "competition.my_fpl_snapshot_publications",
				column: "not_applicable_entry_count",
				pgType: "integer",
			},
			{
				relation: "competition.my_fpl_snapshot_publications",
				column: "expected_tournament_count",
				pgType: "integer",
			},
			{
				relation: "competition.my_fpl_snapshot_publications",
				column: "ready_tournament_count",
				pgType: "integer",
			},
			{
				relation: "competition.my_fpl_snapshot_publications",
				column: "content_sha256",
				pgType: "text",
				acceptedPgTypes: ["character varying"],
			},
			{
				relation: "competition.my_fpl_snapshot_publications",
				column: "entry_scope_sha256",
				pgType: "text",
				acceptedPgTypes: ["character varying"],
			},
			{
				relation: "competition.my_fpl_snapshot_publications",
				column: "tournament_scope_sha256",
				pgType: "text",
				acceptedPgTypes: ["character varying"],
			},
			{
				relation: "competition.my_fpl_snapshot_publications",
				column: "score_source",
				pgType: "text",
				acceptedPgTypes: ["character varying"],
			},
			{
				relation: "competition.my_fpl_snapshot_publications",
				column: "live_publication_id",
				pgType: "uuid",
			},
			{
				relation: "competition.my_fpl_snapshot_publications",
				column: "live_revision",
				pgType: "text",
				acceptedPgTypes: ["character varying"],
			},
			{
				relation: "competition.my_fpl_snapshot_publications",
				column: "algorithm_version",
				pgType: "text",
				acceptedPgTypes: ["character varying"],
			},
			{
				relation: "competition.my_fpl_snapshot_publications",
				column: "source_min_checked_at",
				pgType: "timestamp with time zone",
			},
			{
				relation: "competition.my_fpl_snapshot_publications",
				column: "source_max_checked_at",
				pgType: "timestamp with time zone",
			},
			{
				relation: "reporting.my_fpl_active_snapshot_status",
				column: "finished",
				pgType: "boolean",
			},
			{
				relation: "reporting.my_fpl_active_snapshot_status",
				column: "data_checked",
				pgType: "boolean",
			},
			{
				relation: "reporting.my_fpl_active_snapshot_status",
				column: "finalization_started_at",
				pgType: "timestamp with time zone",
			},
			{
				relation: "reporting.my_fpl_active_snapshot_status",
				column: "finalization_due_at",
				pgType: "timestamp with time zone",
			},
			{
				relation: "reporting.my_fpl_active_snapshot_status",
				column: "expected_entry_count",
				pgType: "integer",
			},
			{
				relation: "reporting.my_fpl_active_snapshot_status",
				column: "observed_entry_count",
				pgType: "integer",
			},
			{
				relation: "reporting.my_fpl_active_snapshot_status",
				column: "pending_correction_entry_count",
				pgType: "integer",
			},
			{
				relation: "reporting.my_fpl_active_snapshot_status",
				column: "expected_tournament_count",
				pgType: "integer",
			},
			{
				relation: "reporting.my_fpl_active_snapshot_status",
				column: "observed_tournament_count",
				pgType: "integer",
			},
			{
				relation: "reporting.my_fpl_active_snapshot_status",
				column: "coverage_state",
				pgType: "text",
				acceptedPgTypes: ["character varying"],
			},
			{
				relation: "reporting.my_fpl_active_snapshot_status",
				column: "expected_entry_scope_sha256",
				pgType: "text",
				acceptedPgTypes: ["character varying"],
			},
			{
				relation: "reporting.my_fpl_active_snapshot_status",
				column: "observed_entry_scope_sha256",
				pgType: "text",
				acceptedPgTypes: ["character varying"],
			},
			{
				relation: "reporting.my_fpl_active_snapshot_status",
				column: "expected_tournament_scope_sha256",
				pgType: "text",
				acceptedPgTypes: ["character varying"],
			},
			{
				relation: "reporting.my_fpl_active_snapshot_status",
				column: "observed_tournament_scope_sha256",
				pgType: "text",
				acceptedPgTypes: ["character varying"],
			},
		],
	},
	{
		name: "my-fpl.publication-by-event-revision",
		sql: MY_FPL_PUBLICATION_BY_EVENT_REVISION_SQL,
		values: [2026, 1, "7"],
	},
	{
		name: "my-fpl.publication-by-revision",
		sql: MY_FPL_PUBLICATION_BY_REVISION_SQL,
		values: [2026, "7"],
	},
	{
		name: "my-fpl.snapshot-entry",
		sql: MY_FPL_SNAPSHOT_ENTRY_SQL,
		values: [2026, 1, 1, "7"],
		runtime: "must-return-snapshot-entry",
		resultTypes: [
			{
				relation: "competition.my_fpl_snapshot_entries",
				column: "payload",
				pgType: "jsonb",
				acceptedPgTypes: ["json", "jsonb"],
			},
		],
	},
	{
		name: "my-fpl.snapshot-tournament-row-visibility",
		sql: MY_FPL_SNAPSHOT_TOURNAMENT_ROW_VISIBILITY_SQL,
		values: [2026, 1, "7", GRAPHQL_DATA_CONTRACT_TOURNAMENT_ID, 1],
		runtime: "must-return-row",
		resultTypes: [
			{
				relation: "competition.my_fpl_snapshot_tournament_rows",
				column: "payload",
				pgType: "jsonb",
				acceptedPgTypes: ["json", "jsonb"],
			},
		],
	},
	{
		name: "my-fpl.assert-tournament-membership",
		sql: MY_FPL_ASSERT_TOURNAMENT_MEMBERSHIP_SQL,
		values: [2026, 1, GRAPHQL_DATA_CONTRACT_TOURNAMENT_ID],
		runtime: "must-return-tournament",
	},
	{
		name: "my-fpl.assert-league-only-membership",
		sql: MY_FPL_LEAGUE_ONLY_MEMBERSHIP_SQL,
		values: [2026, 1, GRAPHQL_DATA_CONTRACT_LEAGUE_ONLY_TOURNAMENT_ID],
		runtime: "must-return-tournament",
	},
	{
		name: "my-fpl.list-tournament-memberships",
		sql: MY_FPL_LIST_TOURNAMENT_MEMBERSHIPS_SQL,
		values: [2026, 1],
		runtime: "must-return-row",
	},
	{
		name: "my-fpl.competition-board",
		sql: MY_FPL_COMPETITION_BOARD_SQL,
		values: [2026, 1, "7", GRAPHQL_DATA_CONTRACT_TOURNAMENT_ID, "", 100, 0, 1],
		runtime: "must-return-board",
		resultTypes: [
			{
				relation: "competition.my_fpl_snapshot_tournament_rows",
				column: "payload",
				pgType: "jsonb",
				acceptedPgTypes: ["json", "jsonb"],
			},
			{
				relation: "competition.my_fpl_snapshot_tournament_aggregates",
				column: "payload",
				pgType: "jsonb",
				acceptedPgTypes: ["json", "jsonb"],
			},
		],
	},
	{
		name: "my-fpl.competition-aggregate",
		sql: MY_FPL_COMPETITION_AGGREGATE_SQL,
		values: [2026, 1, "7", GRAPHQL_DATA_CONTRACT_TOURNAMENT_ID],
		runtime: "must-return-competition-aggregate",
		resultTypes: [
			{
				relation: "competition.my_fpl_snapshot_tournament_aggregates",
				column: "payload",
				pgType: "jsonb",
				acceptedPgTypes: ["json", "jsonb"],
			},
		],
	},
	{
		name: "my-fpl.competition-season-path",
		sql: MY_FPL_COMPETITION_SEASON_PATH_SQL,
		values: [2026, 1, "7", GRAPHQL_DATA_CONTRACT_TOURNAMENT_ID],
		runtime: "must-return-season-path",
		resultTypes: [
			{
				relation: "competition.my_fpl_snapshot_tournament_aggregates",
				column: "payload",
				pgType: "jsonb",
				acceptedPgTypes: ["json", "jsonb"],
			},
		],
	},
	{
		name: "my-fpl.competition-setup-status",
		sql: MY_FPL_COMPETITION_SETUP_STATUS_SQL,
		values: [2026, GRAPHQL_DATA_CONTRACT_TOURNAMENT_ID],
		runtime: "must-return-setup-status",
		resultTypes: [
			{
				relation: "competition.tournaments",
				column: "setup_progress_updated_at",
				pgType: "timestamp with time zone",
			},
			{
				relation: "competition.tournaments",
				column: "standings_ready_at",
				pgType: "timestamp with time zone",
			},
			{
				relation: "competition.tournaments",
				column: "insights_ready_at",
				pgType: "timestamp with time zone",
			},
		],
	},
];

export type MyFplReviewState = "PRESEASON" | "PENDING" | "READY" | "EMPTY" | "UNAVAILABLE";

export type MyFplReviewContext = {
	season: string;
	coreRevision: string;
	currentEventId: number | null;
	nextEventId: number | null;
	latestFinalizedEventId: number | null;
	latestPublishedEventId: number | null;
};

export type MyFplSnapshotKind = "PROVISIONAL" | "FINAL";
export type MyFplTimelineStatus = MyFplSnapshotKind;
export type MyFplSettlementState = "PROVISIONAL" | "FINALIZING" | "FINAL" | "DELAYED";
export type MyFplCoverageState = "COMPLETE" | "CORRECTION_PENDING";
export type MyFplTimelinessState = "CURRENT" | "STALE";
export type MyFplScoreSource = "FPL_EVENT_LIVE" | "FPL_FINAL_RESULT";
export type MyFplSnapshotMeta = {
	revision: string;
	eventId: number;
	snapshotDate: string;
	sourceCheckedAt: string;
	publishedAt: string;
	settlementState: MyFplSettlementState;
	coverageState: MyFplCoverageState;
	timelinessState: MyFplTimelinessState;
	expectedEntryCount: number;
	observedEntryCount: number;
	finalizationStartedAt: string | null;
	finalizationDueAt: string | null;
	scoreSource: MyFplScoreSource;
	livePublicationId: string | null;
	liveRevision: string | null;
	algorithmVersion: string | null;
	sourceMinCheckedAt: string;
	sourceMaxCheckedAt: string;
};

/** Internal dependency seam used by hermetic My FPL behavior tests. */
export type MyFplRepositoryDependencies = {
	getCoreEventSnapshot: typeof getCoreEventSnapshot;
	getEntriesByIds: typeof entriesService.getEntriesByIds;
	tournamentsRepository: typeof tournamentsRepository;
};

const defaultDependencies: MyFplRepositoryDependencies = {
	getCoreEventSnapshot,
	getEntriesByIds: entriesService.getEntriesByIds,
	tournamentsRepository,
};

const dependencyOverrides = new WeakMap<object, MyFplRepositoryDependencies>();

const dependenciesFor = (context: GraphQLContext): MyFplRepositoryDependencies =>
	dependencyOverrides.get(context) ?? defaultDependencies;

const {
	loadCurrentEntryNames,
	applyCurrentEntryName,
	applyCurrentEntryNamesToBoardPage,
	applyCurrentEntryNamesToAggregate,
} = createMyFplEntryNameProjection((context, entryIds) =>
	dependenciesFor(context).getEntriesByIds(context, [...entryIds])
);

const withDependencies = async <T>(
	context: GraphQLContext,
	dependencies: MyFplRepositoryDependencies,
	operation: () => Promise<T>
): Promise<T> => {
	const previous = dependencyOverrides.get(context);
	dependencyOverrides.set(context, dependencies);
	try {
		return await operation();
	} finally {
		if (previous) dependencyOverrides.set(context, previous);
		else dependencyOverrides.delete(context);
	}
};

type LoadedReviewContext = {
	value: MyFplReviewContext;
	selectionRules: CoreSelectionRules | null;
	finalizedEventIds: Set<number>;
	settledEventIds: Set<number>;
	publications: Map<number, MyFplSnapshotPublication>;
};

export type MyFplSnapshotPublication = MyFplSnapshotMeta & {
	/** Internal producer kind. It is intentionally not exposed by GraphQL. */
	kind: MyFplSnapshotKind;
	/** Counts captured by this immutable revision, distinct from today's canonical scope. */
	capturedExpectedEntryCount: number;
	capturedExpectedTournamentCount: number;
	/** Internal canonical/observed scope evidence used by cache validation. */
	expectedEntryScopeSha256: string;
	expectedTournamentScopeSha256: string;
	expectedEntryCount: number;
	readyEntryCount: number;
	emptyEntryCount: number;
	notApplicableEntryCount: number;
	expectedTournamentCount: number;
	readyTournamentCount: number;
	contentSha256: string;
	entryScopeSha256: string;
	tournamentScopeSha256: string;
};

export type MyFplEntryIdentity = {
	id: number;
	entryName: string;
	playerName: string;
	region: string | null;
	startedEvent: number | null;
	overallPoints: number | null;
	overallRank: number | null;
	bank: number | null;
	teamValue: number | null;
	totalTransfers: number | null;
	transfersSyncedThroughEventId: number | null;
	/** Internal checkpoint fields used to distinguish READY from not-yet-synced history. */
	pastSeasonsCheckedAt?: string | null;
	pastSeasonsCount?: number | null;
};

export type MyFplManagerPositionPoints = {
	goalkeeper: number;
	defender: number;
	midfielder: number;
	forward: number;
	assistantManager: number;
	total: number;
};

export type MyFplManagerCaptainReview = {
	captainElement: number | null;
	captainWebName: string | null;
	captainTeamShortName: string | null;
	captainBasePoints: number;
	captainBlank: boolean;
	captainContribution: number;
	viceCaptainElement: number | null;
	viceCaptainWebName: string | null;
	viceCaptainBasePoints: number;
	bestSquadElement: number | null;
	bestSquadWebName: string | null;
	bestSquadPoints: number;
	regretPoints: number | null;
};

export type MyFplManagerAutomaticSubstitution = {
	elementIn: number;
	elementInWebName: string;
	elementOut: number;
	elementOutWebName: string;
	pointsGained: number;
};

export type MyFplManagerGameweekReview = {
	formation: string;
	lineupBasePoints: number;
	bestElevenPoints: number;
	benchRegretPoints: number | null;
	positionPoints: MyFplManagerPositionPoints;
	captain: MyFplManagerCaptainReview;
	automaticSubstitutions: MyFplManagerAutomaticSubstitution[];
};

export type MyFplManagerTimelineRow = {
	eventId: number;
	status: MyFplTimelineStatus;
	eventPoints: number;
	eventRank: number | null;
	overallPoints: number;
	overallRank: number | null;
	overallRankDelta: number | null;
	eventTransfers: number;
	eventTransfersCost: number;
	eventNetPoints: number;
	eventBenchPoints: number;
	eventAutoSubPoints: number;
	eventChip: string;
	eventCaptainPoints: number;
	captainWebName: string | null;
	captainTeamShortName: string | null;
	teamValue: number | null;
	bank: number | null;
	review: MyFplManagerGameweekReview;
};

export type MyFplPastSeason = {
	season: string;
	totalPoints: number;
	overallRank: number;
};

export type MyFplManagerPick = {
	element: number;
	position: number;
	webName: string;
	teamShortName: string;
	teamName: string;
	elementTypeName: string;
	isCaptain: boolean;
	isViceCaptain: boolean;
	multiplier: number;
	totalPoints: number;
	minutes: number;
	goalsScored: number;
	assists: number;
	cleanSheets: number;
	goalsConceded: number;
	yellowCards: number;
	redCards: number;
	saves: number;
	bonus: number;
	bps: number;
	againstShortName: string;
	wasHome: string;
	score: string;
	fixtureCount: number;
	bgw: boolean;
	dgw: boolean;
	isPlayed: boolean;
	autoSub: boolean;
	expectedGoals: number | null;
	expectedAssists: number | null;
	expectedGoalInvolvements: number | null;
	expectedGoalsConceded: number | null;
};

export type MyFplManagerGameweekResult = {
	eventId: number;
	eventPoints: number;
	eventRank: number | null;
	overallPoints: number;
	overallRank: number | null;
	eventTransfers: number;
	eventTransfersCost: number;
	eventNetPoints: number;
	eventBenchPoints: number;
	eventAutoSubPoints: number;
	eventChip: string;
	eventCaptainPoints: number;
	playedCaptainWebName: string | null;
	playedCaptainTeamShortName: string | null;
	teamValue: number | null;
	bank: number | null;
	picks: MyFplManagerPick[];
};

export type MyFplManagerGameweek = {
	state: MyFplReviewState;
	context: MyFplReviewContext;
	eventId: number;
	entry: MyFplEntryIdentity | null;
	result: MyFplManagerGameweekResult | null;
	review: MyFplManagerGameweekReview | null;
	snapshotMeta?: MyFplSnapshotMeta | null;
};

export type MyFplManagerFormationCount = {
	formation: string;
	gameweeks: number;
};

export type MyFplManagerChipReview = {
	chip: string;
	eventId: number;
	status: MyFplTimelineStatus;
	eventNetPoints: number;
	otherGameweeksAverageNetPoints: number | null;
	differenceFromOtherGameweeks: number | null;
	overallRankDelta: number | null;
};

export type MyFplManagerSeasonSummary = {
	gameweeksReviewed: number;
	provisionalGameweeks: number;
	totalNetPoints: number;
	averageNetPoints: number;
	medianNetPoints: number;
	bestGameweekId: number | null;
	bestNetPoints: number | null;
	worstGameweekId: number | null;
	worstNetPoints: number | null;
	totalHitPoints: number;
	hitGameweeks: number;
	totalBenchPoints: number;
	averageBenchPoints: number;
	zeroBenchGameweeks: number;
	highBenchGameweeks: number;
	totalAutoSubPoints: number;
	autoSubGameweeks: number;
	totalCaptainPoints: number;
	uniqueCaptains: number;
	captainBlankGameweeks: number;
	topCaptainWebName: string | null;
	topCaptainGameweeks: number;
	topCaptainRate: number;
	bestOverallRank: number | null;
	worstOverallRank: number | null;
	overallRankChange: number | null;
	currentImprovementStreak: number;
	longestImprovementStreak: number;
	formations: MyFplManagerFormationCount[];
	positionPoints: MyFplManagerPositionPoints;
	chips: MyFplManagerChipReview[];
};

export type MyFplManagerHoldingPeriod = {
	element: number;
	webName: string;
	teamShortName: string;
	elementTypeName: string;
	startedEventId: number;
	endedEventId: number | null;
	gameweeksHeld: number;
	starts: number;
	captaincies: number;
	pointsWhileOwned: number;
	scoringContribution: number;
};

export type MyFplTransferMove = {
	eventId: number;
	elementIn: number | null;
	elementInWebName: string;
	elementInTypeName: string;
	elementInTeamShortName: string;
	elementInCost: number;
	elementInPoints: number | null;
	elementInPlayed: boolean | null;
	elementOut: number | null;
	elementOutWebName: string;
	elementOutTypeName: string;
	elementOutTeamShortName: string;
	elementOutCost: number;
	elementOutPoints: number | null;
	sameGameweekGain: number | null;
	threeGameweekGain: number | null;
	fiveGameweekGain: number | null;
	evaluatedThroughEventId: number | null;
	time: string;
};

export type MyFplTransferGameweek = {
	eventId: number;
	eventTransfers: number;
	eventTransfersCost: number;
	transfers: MyFplTransferMove[];
};

export type MyFplManagerReview = {
	state: MyFplReviewState;
	context: MyFplReviewContext;
	entry: MyFplEntryIdentity | null;
	throughEventId: number | null;
	timeline: MyFplManagerTimelineRow[];
	summary: MyFplManagerSeasonSummary | null;
	holdings: MyFplManagerHoldingPeriod[];
	transfers: MyFplTransferGameweek[];
	pastSeasons: MyFplPastSeason[];
	pastSeasonsState: MyFplReviewState;
	currentGameweek: MyFplManagerGameweek | null;
	rules: CoreSelectionRules | null;
	snapshotMeta: MyFplSnapshotMeta | null;
};

export type MyFplCompetitionBoardRow = {
	eventId: number;
	groupId: number | null;
	entryId: number;
	entryName: string | null;
	playerName: string | null;
	rank: number | null;
	previousRank: number | null;
	fieldRank: number | null;
	eventPoints: number | null;
	eventCost: number | null;
	eventNetPoints: number | null;
	eventRank: number | null;
	overallPoints: number | null;
	overallRank: number | null;
	eventChip: string | null;
	captainId: number | null;
	captainWebName: string | null;
	captainTeamShortName: string | null;
	captainPoints: number | null;
	teamValue: number | null;
	bank: number | null;
};

export type MyFplCompetitionBoardPage = {
	state: MyFplReviewState;
	eventId: number;
	page: number;
	pageSize: number;
	totalRows: number;
	totalPages: number;
	fieldSize: number;
	rows: MyFplCompetitionBoardRow[];
	viewerRow: MyFplCompetitionBoardRow | null;
	snapshotMeta: MyFplSnapshotMeta | null;
};

export type MyFplCompetitionMetricKey =
	| "OVERALL_POINTS"
	| "TEAM_VALUE"
	| "TRANSFERS"
	| "TOTAL_COSTS"
	| "BENCH_POINTS"
	| "AUTO_SUB_POINTS";

export type MyFplCompetitionMetric = {
	key: MyFplCompetitionMetricKey;
	leaderValue: number | null;
	leaderEntryId: number | null;
	leaderEntryName: string | null;
	leaderPlayerName: string | null;
	averageValue: number | null;
	higherIsBetter: boolean;
};

export type MyFplCompetitionViewerSummary = {
	entryId: number;
	overallRank: number | null;
	tournamentOverallRank: number | null;
	teamValue: number | null;
	tournamentTeamValueRank: number | null;
	transfersNum: number | null;
	tournamentTransfersRank: number | null;
	totalCosts: number | null;
	tournamentCostsRank: number | null;
	totalBenchPoints: number | null;
	tournamentBenchPointsRank: number | null;
	autoSubPoints: number | null;
	tournamentAutoSubRank: number | null;
	overallPoints: number | null;
	leaderOverallPoints: number | null;
	gapToLeader: number | null;
	pointsBehindNext: number | null;
	pointsAheadOfPrev: number | null;
};

export type MyFplCompetitionPerformance = {
	entryId: number;
	entryName: string | null;
	playerName: string | null;
	eventPoints: number;
	eventNetPoints: number;
	rank: number | null;
	previousRank: number | null;
	captainId: number | null;
	captainWebName: string | null;
	captainTeamShortName: string | null;
	captainPoints: number | null;
};

export type MyFplCompetitionDistribution = {
	key: string;
	label: string;
	teamShortName: string | null;
	count: number;
	percentage: number;
	averagePoints: number;
};

export type MyFplCompetitionAggregate = {
	eventId: number;
	entryCount: number;
	leaderOverallPoints: number | null;
	secondOverallPoints: number | null;
	gapFirstSecond: number | null;
	averageOverallPoints: number | null;
	metrics: MyFplCompetitionMetric[];
	viewer: MyFplCompetitionViewerSummary | null;
	topPerformers: MyFplCompetitionPerformance[];
	risers: MyFplCompetitionPerformance[];
	fallers: MyFplCompetitionPerformance[];
	captainDistribution: MyFplCompetitionDistribution[];
	chipDistribution: MyFplCompetitionDistribution[];
	snapshotMeta?: MyFplSnapshotMeta | null;
};

export type MyFplCompetitionsDesk = {
	state: MyFplReviewState;
	context: MyFplReviewContext;
	tournaments: TournamentInfo[];
	selectedTournamentId: number | null;
	selectedTournament: TournamentInfo | null;
	eventId: number | null;
	board: MyFplCompetitionBoardPage | null;
	aggregate: MyFplCompetitionAggregate | null;
	snapshotMeta: MyFplSnapshotMeta | null;
};

export type MyFplCompetitionSeasonPathPoint = {
	gameweek: number;
	tournamentRank: number | null;
	gapToLeader: number | null;
	pointsVsAverage: number | null;
	fieldSize: number;
	overallPoints: number | null;
	leaderOverallPoints: number | null;
	averageOverallPoints: number | null;
};

export type MyFplCompetitionSeasonPath = {
	state: MyFplReviewState;
	context: MyFplReviewContext;
	tournamentId: number;
	throughEventId: number;
	points: MyFplCompetitionSeasonPathPoint[];
	snapshotMeta: MyFplSnapshotMeta | null;
};

export type MyFplCompetitionSetupStatus = {
	tournamentId: number;
	setupStatus: string;
	setupPhase: string;
	setupCompletedUnits: number;
	setupTotalUnits: number;
	setupProgressUpdatedAt: string | null;
	standingsReadyAt: string | null;
	insightsReadyAt: string | null;
	setupHasWarnings: boolean;
	ready: boolean;
};

type DbEventLifecycleRow = QueryResultRow & {
	event_id: number;
	finished: boolean;
	data_checked: boolean;
	live_snapshot_finalized_at: Date | string | null;
};

type DbSnapshotPublicationRow = QueryResultRow & {
	season_id: number;
	event_id: number;
	revision: string | number;
	snapshot_date: string | Date;
	source_checked_at: Date | string;
	published_at: Date | string;
	kind: MyFplSnapshotKind;
	expected_entry_count: number;
	ready_entry_count: number;
	empty_entry_count: number;
	not_applicable_entry_count: number;
	expected_tournament_count: number;
	ready_tournament_count: number;
	content_sha256: string;
	entry_scope_sha256: string | null;
	tournament_scope_sha256: string | null;
	score_source: MyFplScoreSource | null;
	live_publication_id: string | null;
	live_revision: string | null;
	algorithm_version: string | null;
	source_min_checked_at: Date | string | null;
	source_max_checked_at: Date | string | null;
	lifecycle_finished: boolean;
	lifecycle_data_checked: boolean;
	finalization_started_at: Date | string | null;
	finalization_due_at: Date | string | null;
	status_expected_entry_count: number;
	observed_entry_count: number;
	pending_correction_entry_count: number;
	status_expected_tournament_count: number;
	observed_tournament_count: number;
	coverage_state: string;
	expected_entry_scope_sha256: string | null;
	observed_entry_scope_sha256: string | null;
	expected_tournament_scope_sha256: string | null;
	observed_tournament_scope_sha256: string | null;
};

type DbBoardJsonRow = {
	event_id: number;
	group_id: number | null;
	entry_id: number;
	entry_name: string | null;
	player_name: string | null;
	rank: number | string | null;
	previous_rank: number | string | null;
	field_rank: number | string | null;
	event_points: number | null;
	event_cost: number | null;
	event_net_points: number | null;
	event_rank: number | null;
	overall_points: number | null;
	overall_rank: number | null;
	event_chip: string | null;
	captain_id: number | null;
	captain_web_name: string | null;
	captain_team_short_name: string | null;
	captain_points: number | null;
	team_value: number | null;
	bank: number | null;
};

type DbSetupStatusRow = QueryResultRow & {
	setup_status?: string | null;
	setup_phase?: string | null;
	setup_completed_units?: number | null;
	setup_total_units?: number | null;
	setup_progress_updated_at: Date | string | null;
	standings_ready_at: Date | string | null;
	insights_ready_at?: Date | string | null;
	setup_warning_count?: number | null;
};

// Snapshot revision is part of every snapshot-backed key below.
// The snapshot metadata contract is a hard cut: old cache envelopes contain
// `kind`/`freshness` and must never be read as the new settlement contract.
const PROJECTION_VERSION = "v12";
const NULLABLE_STATE_CACHE_TTL_SECONDS = 30;
// Keep OFFSET bounded for the fixed-cost board root. Page 100 is the maximum
// 10,000-row window at the maximum page size.
const MAX_COMPETITION_BOARD_PAGE = 100;
const defaultReviewEventId = (context: LoadedReviewContext): number | null =>
	context.value.latestPublishedEventId ??
	context.value.currentEventId ??
	context.value.latestFinalizedEventId;

const asFiniteNumber = (value: unknown): number | null => {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : null;
	}
	return null;
};

const asInteger = (value: unknown): number | null => {
	const parsed = asFiniteNumber(value);
	return parsed !== null && Number.isSafeInteger(parsed) ? parsed : null;
};

const isSafeInteger = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value);

const isNonNegativeSafeInteger = (value: unknown): value is number =>
	isSafeInteger(value) && value >= 0;

const isPositiveSafeInteger = (value: unknown): value is number =>
	isSafeInteger(value) && value > 0;

const isoString = (value: Date | string | null): string | null => {
	if (value === null) return null;
	const date = new Date(value);
	return Number.isFinite(date.getTime()) ? date.toISOString() : null;
};

const currentUtc8DateKey = (now = new Date()): string =>
	new Intl.DateTimeFormat("en-CA", {
		timeZone: "Asia/Shanghai",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).format(now);

const MAX_POSTGRES_BIGINT = "9223372036854775807";

const normalizeSnapshotRevision = (value: string | null | undefined): string | null => {
	const candidate = value?.trim();
	if (!candidate || !/^[0-9]+$/.test(candidate)) return null;
	const normalized = candidate.replace(/^0+(?=\d)/, "");
	if (
		normalized.length > MAX_POSTGRES_BIGINT.length ||
		(normalized.length === MAX_POSTGRES_BIGINT.length && normalized > MAX_POSTGRES_BIGINT)
	) {
		return null;
	}
	return normalized;
};

const compareSnapshotRevisions = (left: string, right: string): number => {
	const normalizedLeft = normalizeSnapshotRevision(left);
	const normalizedRight = normalizeSnapshotRevision(right);
	if (!normalizedLeft || !normalizedRight) return 0;
	if (normalizedLeft.length !== normalizedRight.length) {
		return normalizedLeft.length > normalizedRight.length ? 1 : -1;
	}
	return normalizedLeft === normalizedRight ? 0 : normalizedLeft > normalizedRight ? 1 : -1;
};

const normalizeChip = (value: string | null): string => normalizeFplChip(value, "NONE") ?? "NONE";

const normalizeNullableChip = (value: string | null): string | null =>
	value === null ? null : normalizeChip(value);

const positionName = (value: number | null): string => {
	switch (value) {
		case 1:
			return "GKP";
		case 2:
			return "DEF";
		case 3:
			return "MID";
		case 4:
			return "FWD";
		default:
			return "";
	}
};

const requireViewerEntryId = (context: GraphQLContext): number => {
	const entryId = context.principal ? viewerEntryIdForPrincipal(context.principal) : null;
	if (!entryId || entryId <= 0) {
		throw new GraphQLError("A viewed FPL team is required", {
			extensions: { code: "VIEWER_ENTRY_REQUIRED", http: { status: 403 } },
		});
	}
	return entryId;
};

const validateEventId = (eventId: number): void => {
	if (!Number.isSafeInteger(eventId) || eventId < 1 || eventId > 38) {
		throw new GraphQLError("eventId must be an integer between 1 and 38", {
			extensions: { code: "BAD_USER_INPUT" },
		});
	}
};

const validateTournamentId = (tournamentId: number): void => {
	if (!Number.isSafeInteger(tournamentId) || tournamentId <= 0) {
		throw new GraphQLError("tournamentId must be a positive integer", {
			extensions: { code: "BAD_USER_INPUT" },
		});
	}
};

const isReviewState = (value: unknown): value is MyFplReviewState =>
	typeof value === "string" &&
	["PRESEASON", "PENDING", "READY", "EMPTY", "UNAVAILABLE"].includes(value);

const isReviewContext = (value: unknown): value is MyFplReviewContext =>
	isRecord(value) &&
	typeof value.season === "string" &&
	typeof value.coreRevision === "string" &&
	[
		value.currentEventId,
		value.nextEventId,
		value.latestFinalizedEventId,
		value.latestPublishedEventId,
	].every((item) => item === null || isSafeInteger(item));

const isSnapshotMeta = (value: unknown): value is MyFplSnapshotMeta => {
	if (
		!isTypedRecord(value, {
			revision: (candidate) => typeof candidate === "string",
			eventId: isSafeInteger,
			snapshotDate: isCalendarDate,
			sourceCheckedAt: isIsoDateTime,
			publishedAt: isIsoDateTime,
			settlementState: (candidate) =>
				candidate === "PROVISIONAL" ||
				candidate === "FINALIZING" ||
				candidate === "FINAL" ||
				candidate === "DELAYED",
			coverageState: (candidate) => candidate === "COMPLETE" || candidate === "CORRECTION_PENDING",
			timelinessState: (candidate) => candidate === "CURRENT" || candidate === "STALE",
			expectedEntryCount: (candidate) => isSafeInteger(candidate) && candidate >= 0,
			observedEntryCount: (candidate) => isSafeInteger(candidate) && candidate >= 0,
			finalizationStartedAt: (candidate) => candidate === null || isIsoDateTime(candidate),
			finalizationDueAt: (candidate) => candidate === null || isIsoDateTime(candidate),
			scoreSource: (candidate) =>
				candidate === "FPL_EVENT_LIVE" || candidate === "FPL_FINAL_RESULT",
			livePublicationId: isNullableString,
			liveRevision: isNullableString,
			algorithmVersion: isNullableString,
			sourceMinCheckedAt: isIsoDateTime,
			sourceMaxCheckedAt: isIsoDateTime,
		})
	) {
		return false;
	}
	const candidate = value as MyFplSnapshotMeta;
	if (candidate.observedEntryCount > candidate.expectedEntryCount) return false;
	const startedAt = candidate.finalizationStartedAt;
	const dueAt = candidate.finalizationDueAt;
	if ((startedAt === null) !== (dueAt === null)) return false;
	if (
		startedAt !== null &&
		dueAt !== null &&
		Date.parse(dueAt) !== Date.parse(startedAt) + 4_500_000
	) {
		return false;
	}
	if (candidate.settlementState === "FINAL" && candidate.coverageState !== "COMPLETE") {
		return false;
	}
	return true;
};

const isNullableSafeInteger = (value: unknown): value is number | null =>
	value === null || isSafeInteger(value);

const isFiniteNumber = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value);

const isNullableFiniteNumber = (value: unknown): value is number | null =>
	value === null || isFiniteNumber(value);

const isNullableString = (value: unknown): value is string | null =>
	value === null || typeof value === "string";

const isChip = (value: unknown): value is string =>
	typeof value === "string" &&
	["NONE", "BENCH_BOOST", "FREE_HIT", "TRIPLE_CAPTAIN", "WILDCARD", "MANAGER"].includes(value);

const isNullableChip = (value: unknown): value is string | null => value === null || isChip(value);

const isIsoDateTime = (value: unknown): value is string =>
	typeof value === "string" && Number.isFinite(Date.parse(value));

const isCalendarDate = (value: unknown): value is string =>
	typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);

const isTypedRecord = (
	value: unknown,
	fields: Record<string, (candidate: unknown) => boolean>
): value is Record<string, unknown> =>
	isRecord(value) &&
	Object.entries(fields).every(
		([key, predicate]) => Object.prototype.hasOwnProperty.call(value, key) && predicate(value[key])
	);

const isEntryIdentityCache = (value: unknown): value is MyFplEntryIdentity => {
	if (
		!isTypedRecord(value, {
			id: isSafeInteger,
			entryName: (candidate) => typeof candidate === "string",
			playerName: (candidate) => typeof candidate === "string",
			region: isNullableString,
			startedEvent: isNullableSafeInteger,
			overallPoints: isNullableSafeInteger,
			overallRank: isNullableSafeInteger,
			bank: isNullableSafeInteger,
			teamValue: isNullableSafeInteger,
			totalTransfers: isNullableSafeInteger,
			transfersSyncedThroughEventId: isNullableSafeInteger,
		})
	) {
		return false;
	}
	const candidate = value as Record<string, unknown>;
	if (
		Object.prototype.hasOwnProperty.call(candidate, "pastSeasonsCheckedAt") &&
		candidate.pastSeasonsCheckedAt !== null &&
		!isIsoDateTime(candidate.pastSeasonsCheckedAt)
	) {
		return false;
	}
	if (
		Object.prototype.hasOwnProperty.call(candidate, "pastSeasonsCount") &&
		candidate.pastSeasonsCount !== null &&
		!isSafeInteger(candidate.pastSeasonsCount)
	) {
		return false;
	}
	return true;
};

const isSnapshotKind = (value: unknown): value is MyFplSnapshotKind =>
	value === "PROVISIONAL" || value === "FINAL";

const isManagerPositionPoints = (value: unknown): value is MyFplManagerPositionPoints =>
	isTypedRecord(value, {
		goalkeeper: isSafeInteger,
		defender: isSafeInteger,
		midfielder: isSafeInteger,
		forward: isSafeInteger,
		assistantManager: isSafeInteger,
		total: isSafeInteger,
	});

const isManagerCaptainReview = (value: unknown): value is MyFplManagerCaptainReview =>
	isTypedRecord(value, {
		captainElement: isNullableSafeInteger,
		captainWebName: isNullableString,
		captainTeamShortName: isNullableString,
		captainBasePoints: isSafeInteger,
		captainBlank: (candidate) => typeof candidate === "boolean",
		captainContribution: isSafeInteger,
		viceCaptainElement: isNullableSafeInteger,
		viceCaptainWebName: isNullableString,
		viceCaptainBasePoints: isSafeInteger,
		bestSquadElement: isNullableSafeInteger,
		bestSquadWebName: isNullableString,
		bestSquadPoints: isSafeInteger,
		regretPoints: isNullableSafeInteger,
	});

const isManagerAutomaticSubstitution = (
	value: unknown
): value is MyFplManagerAutomaticSubstitution =>
	isTypedRecord(value, {
		elementIn: isSafeInteger,
		elementInWebName: (candidate) => typeof candidate === "string",
		elementOut: isSafeInteger,
		elementOutWebName: (candidate) => typeof candidate === "string",
		pointsGained: isSafeInteger,
	});

const isManagerGameweekReview = (value: unknown): value is MyFplManagerGameweekReview =>
	isTypedRecord(value, {
		formation: (candidate) => typeof candidate === "string",
		lineupBasePoints: isSafeInteger,
		bestElevenPoints: isSafeInteger,
		benchRegretPoints: isNullableSafeInteger,
		positionPoints: isManagerPositionPoints,
		captain: isManagerCaptainReview,
		automaticSubstitutions: (candidate) =>
			Array.isArray(candidate) && candidate.every(isManagerAutomaticSubstitution),
	});

const isManagerTimelineRow = (value: unknown): value is MyFplManagerTimelineRow =>
	isTypedRecord(value, {
		eventId: isSafeInteger,
		status: isSnapshotKind,
		eventPoints: isSafeInteger,
		eventRank: isNullableSafeInteger,
		overallPoints: isSafeInteger,
		overallRank: isNullableSafeInteger,
		overallRankDelta: isNullableSafeInteger,
		eventTransfers: isSafeInteger,
		eventTransfersCost: isSafeInteger,
		eventNetPoints: isSafeInteger,
		eventBenchPoints: isSafeInteger,
		eventAutoSubPoints: isSafeInteger,
		eventChip: isChip,
		eventCaptainPoints: isSafeInteger,
		captainWebName: isNullableString,
		captainTeamShortName: isNullableString,
		teamValue: isNullableSafeInteger,
		bank: isNullableSafeInteger,
		review: isManagerGameweekReview,
	});

const isPastSeasonCache = (value: unknown): value is MyFplPastSeason =>
	isTypedRecord(value, {
		season: (candidate) => typeof candidate === "string",
		totalPoints: isSafeInteger,
		overallRank: isSafeInteger,
	});

const isManagerPickCache = (value: unknown): value is MyFplManagerPick =>
	isTypedRecord(value, {
		element: isSafeInteger,
		position: isSafeInteger,
		webName: (candidate) => typeof candidate === "string",
		teamShortName: (candidate) => typeof candidate === "string",
		teamName: (candidate) => typeof candidate === "string",
		elementTypeName: (candidate) => typeof candidate === "string",
		isCaptain: (candidate) => typeof candidate === "boolean",
		isViceCaptain: (candidate) => typeof candidate === "boolean",
		multiplier: isSafeInteger,
		totalPoints: isSafeInteger,
		minutes: isSafeInteger,
		goalsScored: isSafeInteger,
		assists: isSafeInteger,
		cleanSheets: isSafeInteger,
		goalsConceded: isSafeInteger,
		yellowCards: isSafeInteger,
		redCards: isSafeInteger,
		saves: isSafeInteger,
		bonus: isSafeInteger,
		bps: isSafeInteger,
		againstShortName: (candidate) => typeof candidate === "string",
		wasHome: (candidate) => typeof candidate === "string",
		score: (candidate) => typeof candidate === "string",
		fixtureCount: isSafeInteger,
		bgw: (candidate) => typeof candidate === "boolean",
		dgw: (candidate) => typeof candidate === "boolean",
		isPlayed: (candidate) => typeof candidate === "boolean",
		autoSub: (candidate) => typeof candidate === "boolean",
		expectedGoals: isNullableFiniteNumber,
		expectedAssists: isNullableFiniteNumber,
		expectedGoalInvolvements: isNullableFiniteNumber,
		expectedGoalsConceded: isNullableFiniteNumber,
	});

const isManagerGameweekResultCache = (value: unknown): value is MyFplManagerGameweekResult =>
	isTypedRecord(value, {
		eventId: isSafeInteger,
		eventPoints: isSafeInteger,
		eventRank: isNullableSafeInteger,
		overallPoints: isSafeInteger,
		overallRank: isNullableSafeInteger,
		eventTransfers: isSafeInteger,
		eventTransfersCost: isSafeInteger,
		eventNetPoints: isSafeInteger,
		eventBenchPoints: isSafeInteger,
		eventAutoSubPoints: isSafeInteger,
		eventChip: isChip,
		eventCaptainPoints: isSafeInteger,
		playedCaptainWebName: isNullableString,
		playedCaptainTeamShortName: isNullableString,
		teamValue: isNullableSafeInteger,
		bank: isNullableSafeInteger,
		picks: (candidate) => Array.isArray(candidate) && candidate.every(isManagerPickCache),
	});

const isManagerGameweekCache = (value: unknown): value is MyFplManagerGameweek =>
	isTypedRecord(value, {
		state: isReviewState,
		context: isReviewContext,
		eventId: isSafeInteger,
		entry: (candidate) => candidate === null || isEntryIdentityCache(candidate),
		result: (candidate) => candidate === null || isManagerGameweekResultCache(candidate),
		review: (candidate) => candidate === null || isManagerGameweekReview(candidate),
		snapshotMeta: (candidate) => candidate === null || isSnapshotMeta(candidate),
	});

const isManagerFormationCount = (value: unknown): value is MyFplManagerFormationCount =>
	isTypedRecord(value, {
		formation: (candidate) => typeof candidate === "string",
		gameweeks: isSafeInteger,
	});

const isManagerChipReview = (value: unknown): value is MyFplManagerChipReview =>
	isTypedRecord(value, {
		chip: isChip,
		eventId: isSafeInteger,
		status: isSnapshotKind,
		eventNetPoints: isSafeInteger,
		otherGameweeksAverageNetPoints: isNullableFiniteNumber,
		differenceFromOtherGameweeks: isNullableFiniteNumber,
		overallRankDelta: isNullableSafeInteger,
	});

const isManagerSeasonSummary = (value: unknown): value is MyFplManagerSeasonSummary =>
	isTypedRecord(value, {
		gameweeksReviewed: isSafeInteger,
		provisionalGameweeks: isSafeInteger,
		totalNetPoints: isSafeInteger,
		averageNetPoints: isFiniteNumber,
		medianNetPoints: isFiniteNumber,
		bestGameweekId: isNullableSafeInteger,
		bestNetPoints: isNullableSafeInteger,
		worstGameweekId: isNullableSafeInteger,
		worstNetPoints: isNullableSafeInteger,
		totalHitPoints: isSafeInteger,
		hitGameweeks: isSafeInteger,
		totalBenchPoints: isSafeInteger,
		averageBenchPoints: isFiniteNumber,
		zeroBenchGameweeks: isSafeInteger,
		highBenchGameweeks: isSafeInteger,
		totalAutoSubPoints: isSafeInteger,
		autoSubGameweeks: isSafeInteger,
		totalCaptainPoints: isSafeInteger,
		uniqueCaptains: isSafeInteger,
		captainBlankGameweeks: isSafeInteger,
		topCaptainWebName: isNullableString,
		topCaptainGameweeks: isSafeInteger,
		topCaptainRate: isFiniteNumber,
		bestOverallRank: isNullableSafeInteger,
		worstOverallRank: isNullableSafeInteger,
		overallRankChange: isNullableSafeInteger,
		currentImprovementStreak: isSafeInteger,
		longestImprovementStreak: isSafeInteger,
		formations: (candidate) => Array.isArray(candidate) && candidate.every(isManagerFormationCount),
		positionPoints: isManagerPositionPoints,
		chips: (candidate) => Array.isArray(candidate) && candidate.every(isManagerChipReview),
	});

const isManagerHoldingPeriod = (value: unknown): value is MyFplManagerHoldingPeriod =>
	isTypedRecord(value, {
		element: isSafeInteger,
		webName: (candidate) => typeof candidate === "string",
		teamShortName: (candidate) => typeof candidate === "string",
		elementTypeName: (candidate) => typeof candidate === "string",
		startedEventId: isSafeInteger,
		endedEventId: isNullableSafeInteger,
		gameweeksHeld: isSafeInteger,
		starts: isSafeInteger,
		captaincies: isSafeInteger,
		pointsWhileOwned: isSafeInteger,
		scoringContribution: isSafeInteger,
	});

const isTransferMoveCache = (value: unknown): value is MyFplTransferMove =>
	isTypedRecord(value, {
		eventId: isSafeInteger,
		elementIn: isNullableSafeInteger,
		elementInWebName: (candidate) => typeof candidate === "string",
		elementInTypeName: (candidate) => typeof candidate === "string",
		elementInTeamShortName: (candidate) => typeof candidate === "string",
		elementInCost: isSafeInteger,
		elementInPoints: isNullableSafeInteger,
		elementInPlayed: (candidate) => candidate === null || typeof candidate === "boolean",
		elementOut: isNullableSafeInteger,
		elementOutWebName: (candidate) => typeof candidate === "string",
		elementOutTypeName: (candidate) => typeof candidate === "string",
		elementOutTeamShortName: (candidate) => typeof candidate === "string",
		elementOutCost: isSafeInteger,
		elementOutPoints: isNullableSafeInteger,
		sameGameweekGain: isNullableSafeInteger,
		threeGameweekGain: isNullableSafeInteger,
		fiveGameweekGain: isNullableSafeInteger,
		evaluatedThroughEventId: isNullableSafeInteger,
		time: isIsoDateTime,
	});

const isCompetitionBoardRowCache = (value: unknown): value is MyFplCompetitionBoardRow =>
	isTypedRecord(value, {
		eventId: isSafeInteger,
		groupId: isNullableSafeInteger,
		entryId: isSafeInteger,
		entryName: isNullableString,
		playerName: isNullableString,
		rank: isNullableSafeInteger,
		previousRank: isNullableSafeInteger,
		fieldRank: isNullableSafeInteger,
		captainId: isNullableSafeInteger,
		captainWebName: isNullableString,
		captainTeamShortName: isNullableString,
		captainPoints: isNullableSafeInteger,
		eventPoints: isNullableSafeInteger,
		eventCost: isNullableSafeInteger,
		eventNetPoints: isNullableSafeInteger,
		eventRank: isNullableSafeInteger,
		overallPoints: isNullableSafeInteger,
		overallRank: isNullableSafeInteger,
		eventChip: isNullableChip,
		teamValue: isNullableSafeInteger,
		bank: isNullableSafeInteger,
	});

const isCompetitionBoardCache = (value: unknown): value is MyFplCompetitionBoardPage =>
	isTypedRecord(value, {
		state: isReviewState,
		eventId: isSafeInteger,
		page: isSafeInteger,
		pageSize: isSafeInteger,
		totalRows: isSafeInteger,
		totalPages: isSafeInteger,
		fieldSize: isSafeInteger,
		rows: (candidate) => Array.isArray(candidate) && candidate.every(isCompetitionBoardRowCache),
		viewerRow: (candidate) => candidate === null || isCompetitionBoardRowCache(candidate),
		snapshotMeta: (candidate) => candidate === null || isSnapshotMeta(candidate),
	});

const isCompetitionMetricCache = (value: unknown): value is MyFplCompetitionMetric =>
	isTypedRecord(value, {
		key: (candidate) =>
			typeof candidate === "string" &&
			[
				"OVERALL_POINTS",
				"TEAM_VALUE",
				"TRANSFERS",
				"TOTAL_COSTS",
				"BENCH_POINTS",
				"AUTO_SUB_POINTS",
			].includes(candidate),
		leaderValue: isNullableFiniteNumber,
		leaderEntryId: isNullableSafeInteger,
		leaderEntryName: isNullableString,
		leaderPlayerName: isNullableString,
		averageValue: isNullableFiniteNumber,
		higherIsBetter: (candidate) => typeof candidate === "boolean",
	});

const isCompetitionViewerCache = (value: unknown): value is MyFplCompetitionViewerSummary =>
	isTypedRecord(value, {
		entryId: isSafeInteger,
		overallRank: isNullableSafeInteger,
		tournamentOverallRank: isNullableSafeInteger,
		teamValue: isNullableSafeInteger,
		tournamentTeamValueRank: isNullableSafeInteger,
		transfersNum: isNullableSafeInteger,
		tournamentTransfersRank: isNullableSafeInteger,
		totalCosts: isNullableSafeInteger,
		tournamentCostsRank: isNullableSafeInteger,
		totalBenchPoints: isNullableSafeInteger,
		tournamentBenchPointsRank: isNullableSafeInteger,
		autoSubPoints: isNullableSafeInteger,
		tournamentAutoSubRank: isNullableSafeInteger,
		overallPoints: isNullableSafeInteger,
		leaderOverallPoints: isNullableSafeInteger,
		gapToLeader: isNullableSafeInteger,
		pointsBehindNext: isNullableSafeInteger,
		pointsAheadOfPrev: isNullableSafeInteger,
	});

const isCompetitionPerformanceCache = (value: unknown): value is MyFplCompetitionPerformance =>
	isTypedRecord(value, {
		entryId: isSafeInteger,
		entryName: isNullableString,
		playerName: isNullableString,
		eventPoints: isSafeInteger,
		eventNetPoints: isSafeInteger,
		rank: isNullableSafeInteger,
		previousRank: isNullableSafeInteger,
		captainId: isNullableSafeInteger,
		captainWebName: isNullableString,
		captainTeamShortName: isNullableString,
		captainPoints: isNullableSafeInteger,
	});

const isCompetitionDistributionCache = (value: unknown): value is MyFplCompetitionDistribution =>
	isTypedRecord(value, {
		key: (candidate) => typeof candidate === "string",
		label: (candidate) => typeof candidate === "string",
		teamShortName: isNullableString,
		count: isSafeInteger,
		percentage: isFiniteNumber,
		averagePoints: isFiniteNumber,
	});

const isCompetitionAggregateCache = (value: unknown): value is MyFplCompetitionAggregate =>
	isTypedRecord(value, {
		eventId: isSafeInteger,
		entryCount: isSafeInteger,
		leaderOverallPoints: isNullableSafeInteger,
		secondOverallPoints: isNullableSafeInteger,
		gapFirstSecond: isNullableSafeInteger,
		averageOverallPoints: isNullableSafeInteger,
		metrics: (candidate) => Array.isArray(candidate) && candidate.every(isCompetitionMetricCache),
		viewer: (candidate) => candidate === null || isCompetitionViewerCache(candidate),
		topPerformers: (candidate) =>
			Array.isArray(candidate) && candidate.every(isCompetitionPerformanceCache),
		risers: (candidate) =>
			Array.isArray(candidate) && candidate.every(isCompetitionPerformanceCache),
		fallers: (candidate) =>
			Array.isArray(candidate) && candidate.every(isCompetitionPerformanceCache),
		captainDistribution: (candidate) =>
			Array.isArray(candidate) && candidate.every(isCompetitionDistributionCache),
		chipDistribution: (candidate) =>
			Array.isArray(candidate) && candidate.every(isCompetitionDistributionCache),
		snapshotMeta: (candidate) => candidate === null || isSnapshotMeta(candidate),
	});

/**
 * Decode the producer-owned aggregate payload exactly as the PostgreSQL
 * reader does. The durable payload stores viewer summaries under `viewers`;
 * the request's entry id selects one summary before the cache shape is
 * validated. Contract checks call this same decoder so a nested payload drift
 * cannot pass merely because the SQL returned a non-empty JSON object.
 */
export const parseCompetitionAggregatePayload = (
	value: unknown,
	entryId: number
): MyFplCompetitionAggregate | null => {
	if (!isRecord(value) || !Number.isSafeInteger(entryId) || entryId <= 0) return null;
	const viewers = isRecord(value.viewers) ? value.viewers : {};
	const viewer = viewers[String(entryId)] ?? null;
	if (!isRecord(viewer) || viewer.entryId !== entryId) return null;
	const { viewers: _viewers, ...aggregatePayload } = value;
	void _viewers;
	const normalized = { ...aggregatePayload, viewer, snapshotMeta: null };
	return isCompetitionAggregateCache(normalized) ? normalized : null;
};

const isCompetitionSeasonPathPointCache = (
	value: unknown
): value is MyFplCompetitionSeasonPathPoint =>
	isTypedRecord(value, {
		gameweek: isSafeInteger,
		tournamentRank: isNullableSafeInteger,
		gapToLeader: isNullableSafeInteger,
		pointsVsAverage: isNullableFiniteNumber,
		fieldSize: isSafeInteger,
		overallPoints: isNullableSafeInteger,
		leaderOverallPoints: isNullableSafeInteger,
		averageOverallPoints: isNullableFiniteNumber,
	});

const isCompetitionSeasonPathCache = (value: unknown): value is MyFplCompetitionSeasonPath =>
	isTypedRecord(value, {
		state: isReviewState,
		context: isReviewContext,
		tournamentId: isSafeInteger,
		throughEventId: isSafeInteger,
		points: (candidate) =>
			Array.isArray(candidate) && candidate.every(isCompetitionSeasonPathPointCache),
		snapshotMeta: (candidate) => candidate === null || isSnapshotMeta(candidate),
	});

const cacheableState = (state: MyFplReviewState): boolean => state !== "UNAVAILABLE";

const stateTtl = (state: MyFplReviewState): number =>
	state === "PENDING" ? NULLABLE_STATE_CACHE_TTL_SECONDS : QUERY_CACHE_TTL_SECONDS.REPORTING;

const snapshotDateKey = (value: string | Date): string => {
	if (!(value instanceof Date)) return String(value).slice(0, 10);
	return new Intl.DateTimeFormat("en-CA", {
		timeZone: "Asia/Shanghai",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).format(value);
};

const utcDateOrdinal = (value: string): number | null => {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
	if (!match) return null;
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	const timestamp = Date.UTC(year, month - 1, day);
	const normalized = new Date(timestamp).toISOString().slice(0, 10);
	return normalized === value ? Math.floor(timestamp / 86_400_000) : null;
};

const currentUtc8Minutes = (now = new Date()): number => {
	const parts = new Intl.DateTimeFormat("en-GB", {
		timeZone: "Asia/Shanghai",
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
	}).formatToParts(now);
	const hour = Number(parts.find((part) => part.type === "hour")?.value ?? 0);
	const minute = Number(parts.find((part) => part.type === "minute")?.value ?? 0);
	return hour * 60 + minute;
};

const snapshotTimeliness = (
	snapshotDate: string,
	kind: MyFplSnapshotKind,
	now = new Date()
): MyFplTimelinessState => {
	// A final revision is immutable and therefore remains current even when a
	// later calendar day starts. A provisional revision is current for the
	// capture day and through the daily 12:00 UTC+8 completion boundary on the
	// following day; after that boundary consumers must call it stale.
	if (kind === "FINAL" || snapshotDate === currentUtc8DateKey(now)) return "CURRENT";
	const snapshotOrdinal = utcDateOrdinal(snapshotDate);
	const currentOrdinal = utcDateOrdinal(currentUtc8DateKey(now));
	if (
		snapshotOrdinal === null ||
		currentOrdinal === null ||
		currentOrdinal - snapshotOrdinal !== 1
	) {
		return "STALE";
	}
	return currentUtc8Minutes(now) < 12 * 60 ? "CURRENT" : "STALE";
};

const settlementStateFromRow = (row: DbSnapshotPublicationRow): MyFplSettlementState => {
	if (!row.lifecycle_data_checked) return "PROVISIONAL";
	const expected = row.status_expected_entry_count;
	const observed = row.observed_entry_count;
	const complete =
		row.kind === "FINAL" &&
		row.coverage_state === "COMPLETE" &&
		Number.isSafeInteger(expected) &&
		Number.isSafeInteger(observed) &&
		expected === observed &&
		row.status_expected_tournament_count === row.observed_tournament_count &&
		row.expected_entry_scope_sha256 === row.observed_entry_scope_sha256 &&
		row.expected_tournament_scope_sha256 === row.observed_tournament_scope_sha256;
	if (complete) return "FINAL";
	const dueAt = isoString(row.finalization_due_at);
	if (dueAt && Date.now() >= Date.parse(dueAt)) return "DELAYED";
	return "FINALIZING";
};

const SNAPSHOT_PUBLICATION_UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// My FPL daily snapshots are produced by the Live Points V2 projection. This
// is a hard contract: accepting the legacy projection marker would allow a
// publication from a different producer algorithm onto the review surface.
const SNAPSHOT_ALGORITHM_VERSION = "live-points-v2-algorithm-1";

const isValidSnapshotPublicationRow = (row: DbSnapshotPublicationRow): boolean => {
	const sourceCheckedAt = isoString(row.source_checked_at);
	const sourceMinCheckedAt = isoString(row.source_min_checked_at);
	const sourceMaxCheckedAt = isoString(row.source_max_checked_at);
	const finalizationStartedAt = isoString(row.finalization_started_at);
	const finalizationDueAt = isoString(row.finalization_due_at);
	if (
		!Number.isSafeInteger(row.expected_entry_count) ||
		row.expected_entry_count < 0 ||
		!Number.isSafeInteger(row.ready_entry_count) ||
		!Number.isSafeInteger(row.empty_entry_count) ||
		row.ready_entry_count < 0 ||
		row.empty_entry_count < 0 ||
		!Number.isSafeInteger(row.not_applicable_entry_count) ||
		row.not_applicable_entry_count < 0 ||
		row.ready_entry_count + row.empty_entry_count !== row.expected_entry_count ||
		row.observed_entry_count !== row.expected_entry_count ||
		!Number.isSafeInteger(row.expected_tournament_count) ||
		row.expected_tournament_count < 0 ||
		!Number.isSafeInteger(row.ready_tournament_count) ||
		row.ready_tournament_count !== row.expected_tournament_count ||
		row.observed_tournament_count !== row.ready_tournament_count ||
		!Number.isSafeInteger(row.status_expected_entry_count) ||
		row.status_expected_entry_count < 0 ||
		row.status_expected_entry_count < row.expected_entry_count ||
		!Number.isSafeInteger(row.observed_entry_count) ||
		row.observed_entry_count < 0 ||
		row.observed_entry_count > row.status_expected_entry_count ||
		!Number.isSafeInteger(row.pending_correction_entry_count) ||
		row.pending_correction_entry_count !==
			row.status_expected_entry_count - row.observed_entry_count ||
		!Number.isSafeInteger(row.status_expected_tournament_count) ||
		row.status_expected_tournament_count < 0 ||
		row.status_expected_tournament_count < row.expected_tournament_count ||
		!Number.isSafeInteger(row.observed_tournament_count) ||
		row.observed_tournament_count < 0 ||
		row.observed_tournament_count > row.status_expected_tournament_count ||
		(row.status_expected_entry_count !== row.observed_entry_count &&
			row.expected_entry_scope_sha256 === row.observed_entry_scope_sha256) ||
		(row.status_expected_tournament_count !== row.observed_tournament_count &&
			row.expected_tournament_scope_sha256 === row.observed_tournament_scope_sha256) ||
		(row.coverage_state === "COMPLETE" &&
			(row.pending_correction_entry_count !== 0 ||
				row.status_expected_entry_count !== row.observed_entry_count ||
				row.status_expected_tournament_count !== row.observed_tournament_count ||
				row.expected_entry_scope_sha256 !== row.observed_entry_scope_sha256 ||
				row.expected_tournament_scope_sha256 !== row.observed_tournament_scope_sha256)) ||
		typeof row.lifecycle_finished !== "boolean" ||
		typeof row.lifecycle_data_checked !== "boolean" ||
		(row.lifecycle_data_checked
			? !finalizationStartedAt ||
				!finalizationDueAt ||
				Date.parse(finalizationDueAt) !== Date.parse(finalizationStartedAt) + 4_500_000
			: finalizationStartedAt !== null || finalizationDueAt !== null) ||
		(row.lifecycle_data_checked && !row.lifecycle_finished) ||
		typeof row.entry_scope_sha256 !== "string" ||
		!/^[0-9a-f]{64}$/.test(row.entry_scope_sha256) ||
		typeof row.tournament_scope_sha256 !== "string" ||
		!/^[0-9a-f]{64}$/.test(row.tournament_scope_sha256) ||
		typeof row.expected_entry_scope_sha256 !== "string" ||
		!/^[0-9a-f]{64}$/.test(row.expected_entry_scope_sha256) ||
		typeof row.observed_entry_scope_sha256 !== "string" ||
		!/^[0-9a-f]{64}$/.test(row.observed_entry_scope_sha256) ||
		typeof row.expected_tournament_scope_sha256 !== "string" ||
		!/^[0-9a-f]{64}$/.test(row.expected_tournament_scope_sha256) ||
		typeof row.observed_tournament_scope_sha256 !== "string" ||
		!/^[0-9a-f]{64}$/.test(row.observed_tournament_scope_sha256) ||
		!/^[0-9a-f]{64}$/.test(row.content_sha256) ||
		!sourceCheckedAt ||
		!sourceMinCheckedAt ||
		!sourceMaxCheckedAt ||
		(row.coverage_state !== "COMPLETE" && row.coverage_state !== "CORRECTION_PENDING") ||
		row.entry_scope_sha256 !== row.observed_entry_scope_sha256 ||
		row.tournament_scope_sha256 !== row.observed_tournament_scope_sha256 ||
		Date.parse(sourceCheckedAt) !== Date.parse(sourceMinCheckedAt) ||
		Date.parse(sourceMinCheckedAt) > Date.parse(sourceMaxCheckedAt)
	) {
		return false;
	}
	if (
		row.kind === "FINAL" &&
		(!row.lifecycle_finished ||
			!row.lifecycle_data_checked ||
			row.coverage_state !== "COMPLETE" ||
			row.status_expected_entry_count !== row.observed_entry_count ||
			row.status_expected_tournament_count !== row.observed_tournament_count ||
			row.pending_correction_entry_count !== 0 ||
			row.expected_entry_scope_sha256 !== row.observed_entry_scope_sha256 ||
			row.expected_tournament_scope_sha256 !== row.observed_tournament_scope_sha256)
	) {
		return false;
	}
	if (row.kind === "PROVISIONAL") {
		return (
			row.score_source === "FPL_EVENT_LIVE" &&
			typeof row.live_publication_id === "string" &&
			SNAPSHOT_PUBLICATION_UUID_RE.test(row.live_publication_id) &&
			typeof row.live_revision === "string" &&
			row.live_revision.trim() !== "" &&
			typeof row.algorithm_version === "string" &&
			row.algorithm_version === SNAPSHOT_ALGORITHM_VERSION
		);
	}
	return (
		row.kind === "FINAL" &&
		row.score_source === "FPL_FINAL_RESULT" &&
		row.live_publication_id === null &&
		row.live_revision === null &&
		row.algorithm_version === null
	);
};

const publicationFromRow = (row: DbSnapshotPublicationRow): MyFplSnapshotPublication => ({
	revision: String(row.revision),
	eventId: row.event_id,
	snapshotDate: snapshotDateKey(row.snapshot_date),
	sourceCheckedAt: isoString(row.source_checked_at) ?? new Date(0).toISOString(),
	publishedAt: isoString(row.published_at) ?? new Date(0).toISOString(),
	kind: row.kind,
	settlementState: settlementStateFromRow(row),
	coverageState:
		row.pending_correction_entry_count > 0 ||
		row.status_expected_entry_count !== row.observed_entry_count ||
		row.status_expected_tournament_count !== row.observed_tournament_count ||
		row.expected_entry_scope_sha256 !== row.observed_entry_scope_sha256 ||
		row.expected_tournament_scope_sha256 !== row.observed_tournament_scope_sha256 ||
		row.coverage_state === "CORRECTION_PENDING"
			? "CORRECTION_PENDING"
			: "COMPLETE",
	timelinessState: snapshotTimeliness(snapshotDateKey(row.snapshot_date), row.kind),
	expectedEntryCount: row.status_expected_entry_count,
	observedEntryCount: row.observed_entry_count,
	finalizationStartedAt: isoString(row.finalization_started_at),
	finalizationDueAt: isoString(row.finalization_due_at),
	scoreSource: row.score_source!,
	livePublicationId: row.live_publication_id,
	liveRevision: row.live_revision,
	algorithmVersion: row.algorithm_version,
	sourceMinCheckedAt: isoString(row.source_min_checked_at)!,
	sourceMaxCheckedAt: isoString(row.source_max_checked_at)!,
	readyEntryCount: row.ready_entry_count,
	emptyEntryCount: row.empty_entry_count,
	notApplicableEntryCount: row.not_applicable_entry_count,
	expectedTournamentCount: row.status_expected_tournament_count,
	readyTournamentCount: row.ready_tournament_count,
	capturedExpectedEntryCount: row.expected_entry_count,
	capturedExpectedTournamentCount: row.expected_tournament_count,
	contentSha256: row.content_sha256,
	entryScopeSha256: row.entry_scope_sha256!,
	tournamentScopeSha256: row.tournament_scope_sha256!,
	expectedEntryScopeSha256: row.expected_entry_scope_sha256!,
	expectedTournamentScopeSha256: row.expected_tournament_scope_sha256!,
});

/**
 * Decode the active-publication row exactly as the PostgreSQL fallback reader
 * does.  The direct Data contract uses this function rather than accepting a
 * merely non-empty row, so count, hash, timestamp, and score provenance drift
 * cannot silently turn a published My FPL review into PENDING.
 */
export const parseSnapshotPublicationRow = (row: unknown): MyFplSnapshotPublication | null => {
	if (!isRecord(row)) return null;
	return isValidSnapshotPublicationRow(row as DbSnapshotPublicationRow)
		? publicationFromRow(row as DbSnapshotPublicationRow)
		: null;
};

const isSnapshotPublicationCache = (value: unknown): value is MyFplSnapshotPublication => {
	if (!isRecord(value) || !isSnapshotMeta(value)) return false;
	const candidate = value as MyFplSnapshotPublication;
	if (!isSnapshotKind(candidate.kind)) return false;
	const sourceShapeValid =
		candidate.kind === "PROVISIONAL"
			? candidate.scoreSource === "FPL_EVENT_LIVE" &&
				candidate.livePublicationId !== null &&
				SNAPSHOT_PUBLICATION_UUID_RE.test(candidate.livePublicationId) &&
				candidate.liveRevision !== null &&
				candidate.liveRevision.trim() !== "" &&
				candidate.algorithmVersion !== null &&
				candidate.algorithmVersion === SNAPSHOT_ALGORITHM_VERSION
			: candidate.scoreSource === "FPL_FINAL_RESULT" &&
				candidate.livePublicationId === null &&
				candidate.liveRevision === null &&
				candidate.algorithmVersion === null;
	return (
		sourceShapeValid &&
		Date.parse(candidate.sourceCheckedAt) === Date.parse(candidate.sourceMinCheckedAt) &&
		Date.parse(candidate.sourceMinCheckedAt) <= Date.parse(candidate.sourceMaxCheckedAt) &&
		isSafeInteger(candidate.expectedEntryCount) &&
		candidate.expectedEntryCount >= 0 &&
		isSafeInteger(candidate.capturedExpectedEntryCount) &&
		candidate.capturedExpectedEntryCount >= 0 &&
		isSafeInteger(candidate.readyEntryCount) &&
		candidate.readyEntryCount >= 0 &&
		isSafeInteger(candidate.emptyEntryCount) &&
		candidate.emptyEntryCount >= 0 &&
		isSafeInteger(candidate.notApplicableEntryCount) &&
		candidate.notApplicableEntryCount >= 0 &&
		candidate.readyEntryCount + candidate.emptyEntryCount ===
			candidate.capturedExpectedEntryCount &&
		isSafeInteger(candidate.expectedTournamentCount) &&
		candidate.expectedTournamentCount >= 0 &&
		isSafeInteger(candidate.capturedExpectedTournamentCount) &&
		candidate.capturedExpectedTournamentCount >= 0 &&
		isSafeInteger(candidate.readyTournamentCount) &&
		candidate.readyTournamentCount >= 0 &&
		candidate.readyTournamentCount === candidate.capturedExpectedTournamentCount &&
		isSafeInteger(candidate.observedEntryCount) &&
		candidate.observedEntryCount >= 0 &&
		candidate.observedEntryCount <= candidate.expectedEntryCount &&
		candidate.observedEntryCount === candidate.capturedExpectedEntryCount &&
		(candidate.expectedEntryCount === candidate.observedEntryCount ||
			candidate.expectedEntryScopeSha256 !== candidate.entryScopeSha256) &&
		candidate.readyTournamentCount <= candidate.expectedTournamentCount &&
		(candidate.expectedTournamentCount === candidate.readyTournamentCount ||
			candidate.expectedTournamentScopeSha256 !== candidate.tournamentScopeSha256) &&
		(candidate.coverageState === "CORRECTION_PENDING"
			? candidate.kind === "PROVISIONAL"
			: candidate.coverageState ===
				(candidate.observedEntryCount === candidate.expectedEntryCount &&
				candidate.readyTournamentCount === candidate.expectedTournamentCount &&
				candidate.expectedEntryScopeSha256 === candidate.entryScopeSha256 &&
				candidate.expectedTournamentScopeSha256 === candidate.tournamentScopeSha256
					? "COMPLETE"
					: "CORRECTION_PENDING")) &&
		typeof candidate.expectedEntryScopeSha256 === "string" &&
		/^[0-9a-f]{64}$/.test(candidate.expectedEntryScopeSha256) &&
		typeof candidate.expectedTournamentScopeSha256 === "string" &&
		/^[0-9a-f]{64}$/.test(candidate.expectedTournamentScopeSha256) &&
		typeof candidate.entryScopeSha256 === "string" &&
		/^[0-9a-f]{64}$/.test(candidate.entryScopeSha256) &&
		typeof candidate.tournamentScopeSha256 === "string" &&
		/^[0-9a-f]{64}$/.test(candidate.tournamentScopeSha256) &&
		typeof candidate.contentSha256 === "string" &&
		/^[0-9a-f]{64}$/.test(candidate.contentSha256)
	);
};

const loadReviewContext = async (context: GraphQLContext): Promise<LoadedReviewContext> => {
	const snapshotPromise = dependenciesFor(context).getCoreEventSnapshot(context);
	const lifecyclePromise = context.database.query<DbEventLifecycleRow>(MY_FPL_EVENT_LIFECYCLE_SQL, [
		context.currentSeason.seasonId,
	]);
	const publicationPromise = context.database.query<DbSnapshotPublicationRow>(
		MY_FPL_ACTIVE_PUBLICATIONS_SQL,
		[context.currentSeason.seasonId]
	);
	const [snapshot, lifecycle, publicationResult] = await Promise.all([
		snapshotPromise,
		lifecyclePromise,
		publicationPromise,
	]);
	const settledEventIds = new Set(
		lifecycle.rows.filter((row) => row.finished && row.data_checked).map((row) => row.event_id)
	);
	const finalizedEventIds = new Set(
		lifecycle.rows
			.filter((row) => row.finished && row.data_checked && row.live_snapshot_finalized_at !== null)
			.map((row) => row.event_id)
	);
	const eventIds = [...finalizedEventIds].sort((left, right) => right - left);
	const sortedEvents = [...snapshot.events].sort((left, right) => left.id - right.id);
	const currentEventId =
		snapshot.currentEventId ?? sortedEvents.find((event) => event.isCurrent)?.id ?? null;
	const nextEventId =
		(currentEventId
			? sortedEvents.find((event) => event.id === currentEventId + 1)?.id
			: sortedEvents.find((event) => event.isNext)?.id) ?? null;
	const publications = new Map<number, MyFplSnapshotPublication>();
	for (const row of publicationResult.rows) {
		const publication = parseSnapshotPublicationRow(row);
		if (!publication) continue;
		publications.set(row.event_id, publication);
	}
	const latestPublishedEventId =
		[...publications.keys()]
			.filter((eventId) => Number.isSafeInteger(eventId) && eventId > 0)
			.sort((left, right) => right - left)[0] ?? null;
	return {
		value: {
			season: snapshot.seasonCode,
			coreRevision: snapshot.revision,
			currentEventId,
			nextEventId,
			latestFinalizedEventId: eventIds[0] ?? null,
			latestPublishedEventId,
		},
		selectionRules: snapshot.selectionRules ?? null,
		finalizedEventIds,
		settledEventIds,
		publications,
	};
};

const loadSnapshotPublication = async (
	context: GraphQLContext,
	loadedContext: LoadedReviewContext,
	eventId: number,
	revision: string | null | undefined
): Promise<MyFplSnapshotPublication | null> => {
	const pinned =
		revision === undefined || revision === null ? null : normalizeSnapshotRevision(revision);
	if (revision?.trim() && !pinned) return null;
	const active = loadedContext.publications.get(eventId);
	if (!pinned) return active ?? null;
	if (active?.revision === pinned) return active;
	const result = await context.database.query<DbSnapshotPublicationRow>(
		MY_FPL_PUBLICATION_BY_EVENT_REVISION_SQL,
		[context.currentSeason.seasonId, eventId, pinned]
	);
	const row = result.rows[0];
	return row ? parseSnapshotPublicationRow(row) : null;
};

const loadSnapshotPublicationByRevision = async (
	context: GraphQLContext,
	loadedContext: LoadedReviewContext,
	revision: string | null | undefined
): Promise<MyFplSnapshotPublication | null> => {
	const pinned = normalizeSnapshotRevision(revision);
	if (!pinned) return null;
	for (const publication of loadedContext.publications.values()) {
		if (publication.revision === pinned) return publication;
	}
	const result = await context.database.query<DbSnapshotPublicationRow>(
		MY_FPL_PUBLICATION_BY_REVISION_SQL,
		[context.currentSeason.seasonId, pinned]
	);
	const row = result.rows[0];
	return row ? parseSnapshotPublicationRow(row) : null;
};

type SnapshotEntryPayload = {
	contractVersion: 2;
	entry: MyFplEntryIdentity;
	pastSeasons: MyFplPastSeason[];
	gameweek: { state: MyFplReviewState; eventId: number; result: MyFplManagerGameweekResult | null };
	review: {
		throughEventId: number;
		timeline: MyFplManagerTimelineRow[];
		summary: MyFplManagerSeasonSummary;
		holdings: MyFplManagerHoldingPeriod[];
		transfers: MyFplTransferMove[];
	};
};

export const parseSnapshotEntryPayload = (value: unknown): SnapshotEntryPayload | null => {
	if (!isRecord(value) || value.contractVersion !== 2 || !isEntryIdentityCache(value.entry)) {
		return null;
	}
	if (!Array.isArray(value.pastSeasons) || !value.pastSeasons.every(isPastSeasonCache)) return null;
	if (!isRecord(value.gameweek)) return null;
	const gameweekState = value.gameweek.state;
	const gameweekEventId = asInteger(value.gameweek.eventId);
	if (
		!isReviewState(gameweekState) ||
		gameweekEventId === null ||
		(value.gameweek.result !== null && !isManagerGameweekResultCache(value.gameweek.result)) ||
		(isRecord(value.gameweek.result) && value.gameweek.result.eventId !== gameweekEventId) ||
		(gameweekState === "READY" && value.gameweek.result === null) ||
		(gameweekState === "EMPTY" && value.gameweek.result !== null)
	) {
		return null;
	}
	if (!isRecord(value.review)) return null;
	const throughEventId = asInteger(value.review.throughEventId);
	if (
		throughEventId === null ||
		throughEventId !== gameweekEventId ||
		!Array.isArray(value.review.timeline) ||
		!value.review.timeline.every(isManagerTimelineRow) ||
		!isManagerSeasonSummary(value.review.summary) ||
		!Array.isArray(value.review.holdings) ||
		!value.review.holdings.every(isManagerHoldingPeriod) ||
		!Array.isArray(value.review.transfers)
	) {
		return null;
	}
	const transfers = value.review.transfers.filter((candidate): candidate is MyFplTransferMove =>
		isTransferMoveCache(candidate)
	);
	if (transfers.length !== value.review.transfers.length) return null;
	const timeline = value.review.timeline as MyFplManagerTimelineRow[];
	const eventIds = timeline.map((row) => row.eventId);
	if (
		new Set(eventIds).size !== eventIds.length ||
		eventIds.some((eventId) => eventId < 1 || eventId > throughEventId) ||
		eventIds.some((eventId, index) => index > 0 && eventId <= eventIds[index - 1]!) ||
		timeline.some(
			(row) =>
				row.status === "PROVISIONAL" &&
				(row.eventId !== throughEventId ||
					row.overallRankDelta !== null ||
					row.review.benchRegretPoints !== null ||
					row.review.captain.regretPoints !== null)
		) ||
		value.review.summary.gameweeksReviewed !== timeline.length ||
		value.review.summary.provisionalGameweeks !==
			timeline.filter((row) => row.status === "PROVISIONAL").length ||
		value.review.summary.chips.some(
			(chip) =>
				chip.status === "PROVISIONAL" &&
				(chip.differenceFromOtherGameweeks !== null || chip.overallRankDelta !== null)
		)
	) {
		return null;
	}
	return {
		contractVersion: 2,
		entry: value.entry,
		pastSeasons: value.pastSeasons,
		gameweek: {
			state: gameweekState,
			eventId: gameweekEventId,
			result: value.gameweek.result as MyFplManagerGameweekResult | null,
		},
		review: {
			throughEventId,
			timeline,
			summary: value.review.summary,
			holdings: value.review.holdings as MyFplManagerHoldingPeriod[],
			transfers,
		},
	};
};

const isAuthoritativeFinalUnrankedFirstEvent = (payload: SnapshotEntryPayload): boolean => {
	const result = payload.gameweek.result;
	const firstScoringEvent = Math.max(1, payload.entry.startedEvent ?? 1);
	return (
		result !== null &&
		result.eventId === firstScoringEvent &&
		payload.entry.overallPoints === 0 &&
		result.overallPoints === 0 &&
		payload.entry.overallRank === 0 &&
		!payload.review.timeline.some((row) => row.eventId < result.eventId) &&
		payload.review.timeline.every((row) => row.overallPoints === 0)
	);
};

const isFinalManagerGameweekCacheValid = (
	value: MyFplManagerGameweek,
	settlementState: MyFplSettlementState,
	eventId: number,
	authoritativePayload: SnapshotEntryPayload
): boolean => {
	// This cache is reached only after the pinned snapshot has proved that the
	// gameweek is READY and non-empty. Any other cached state is contradictory
	// and must fall through to the authoritative PostgreSQL snapshot.
	const authoritativeResult = authoritativePayload.gameweek.result;
	if (
		value.state !== "READY" ||
		!value.entry ||
		!value.result ||
		!value.review ||
		authoritativePayload.gameweek.state !== "READY" ||
		!authoritativeResult ||
		!authoritativePayload.review.timeline.some((row) => row.eventId === eventId)
	) {
		return false;
	}
	if (settlementState !== "FINAL") return true;
	// Never infer the first-event unranked exception from cache-controlled
	// fields. The exception belongs to the already validated pinned snapshot.
	const allowUnrankedFirstEvent = isAuthoritativeFinalUnrankedFirstEvent(authoritativePayload);
	const rankIsValid = (rank: unknown): boolean =>
		allowUnrankedFirstEvent ? isNonNegativeSafeInteger(rank) : isPositiveSafeInteger(rank);
	return (
		value.entry.id === authoritativePayload.entry.id &&
		value.entry.overallPoints === authoritativePayload.entry.overallPoints &&
		value.entry.overallRank === authoritativePayload.entry.overallRank &&
		value.result.eventId === authoritativeResult.eventId &&
		value.result.overallPoints === authoritativeResult.overallPoints &&
		value.result.eventRank === authoritativeResult.eventRank &&
		value.result.overallRank === authoritativeResult.overallRank &&
		rankIsValid(value.entry.overallRank) &&
		rankIsValid(value.result.eventRank) &&
		rankIsValid(value.result.overallRank)
	);
};

const isFinalSnapshotEntryPayloadValid = (
	payload: SnapshotEntryPayload,
	settlementState: MyFplSettlementState
): boolean => {
	if (settlementState !== "FINAL" || payload.gameweek.state === "EMPTY") return true;
	const allowUnrankedFirstEvent = isAuthoritativeFinalUnrankedFirstEvent(payload);
	const gameweekResult = payload.gameweek.result;
	const rankIsValid = (rank: unknown, allowZero: boolean): boolean =>
		allowZero ? isNonNegativeSafeInteger(rank) : isPositiveSafeInteger(rank);
	return (
		payload.entry.overallRank !== null &&
		rankIsValid(payload.entry.overallRank, allowUnrankedFirstEvent) &&
		rankIsValid(
			gameweekResult?.eventRank ?? null,
			allowUnrankedFirstEvent && gameweekResult?.eventId === payload.gameweek.eventId
		) &&
		rankIsValid(
			gameweekResult?.overallRank ?? null,
			allowUnrankedFirstEvent && gameweekResult?.eventId === payload.gameweek.eventId
		) &&
		payload.review.timeline.every(
			(row) =>
				row.status === "FINAL" &&
				rankIsValid(
					row.eventRank,
					allowUnrankedFirstEvent && row.eventId === payload.gameweek.eventId
				) &&
				rankIsValid(
					row.overallRank,
					allowUnrankedFirstEvent && row.eventId === payload.gameweek.eventId
				)
		)
	);
};

export type SnapshotEntryContractRow = Readonly<{
	payload: SnapshotEntryPayload;
	isEmpty: boolean;
	picksCount: number;
	entryRowCount: number;
	aggregateRowCount: number;
}>;

/**
 * Decode the complete snapshot-entry envelope consumed by the PostgreSQL
 * reader. The payload codec alone cannot detect a producer count or empty
 * sentinel drift, so contract probes and runtime reads share this guard.
 */
export const parseSnapshotEntryContractRow = (
	value: unknown,
	publication: Pick<
		MyFplSnapshotPublication,
		| "expectedEntryCount"
		| "notApplicableEntryCount"
		| "expectedTournamentCount"
		| "capturedExpectedEntryCount"
		| "capturedExpectedTournamentCount"
		| "settlementState"
	>,
	entryId: number,
	eventId: number
): SnapshotEntryContractRow | null => {
	if (!isRecord(value)) return null;
	const payload = parseSnapshotEntryPayload(value.payload);
	const isEmpty = value.is_empty;
	const picksCount = asInteger(value.picks_count);
	const entryRowCount = asInteger(value.entry_row_count);
	const aggregateRowCount = asInteger(value.aggregate_row_count);
	if (
		!payload ||
		typeof isEmpty !== "boolean" ||
		picksCount === null ||
		picksCount < 0 ||
		picksCount > 15 ||
		entryRowCount === null ||
		aggregateRowCount === null ||
		payload.entry.id !== entryId ||
		payload.gameweek.eventId !== eventId ||
		picksCount !== (payload.gameweek.result?.picks.length ?? 0) ||
		isEmpty !== (payload.gameweek.state === "EMPTY") ||
		(isEmpty && picksCount !== 0) ||
		(!isEmpty && (payload.gameweek.state !== "READY" || picksCount !== 15)) ||
		entryRowCount !==
			publication.capturedExpectedEntryCount + publication.notApplicableEntryCount ||
		aggregateRowCount !== publication.capturedExpectedTournamentCount ||
		!isFinalSnapshotEntryPayloadValid(payload, publication.settlementState)
	) {
		return null;
	}
	return { payload, isEmpty, picksCount, entryRowCount, aggregateRowCount };
};

const applyCurrentEntryNameToSnapshot = async (
	context: GraphQLContext,
	payload: SnapshotEntryPayload
): Promise<SnapshotEntryPayload> => {
	const currentEntryName = (await loadCurrentEntryNames(context, [payload.entry.id])).get(
		payload.entry.id
	);
	if (currentEntryName === undefined) return payload;
	return { ...payload, entry: applyCurrentEntryName(payload.entry, currentEntryName)! };
};

type LoadedSnapshotEntry = {
	publication: MyFplSnapshotPublication;
	payload: SnapshotEntryPayload;
	isEmpty: boolean;
};

const parseLoadedSnapshotEntryCache = (
	value: unknown,
	authoritativeSettlementState: MyFplSettlementState
): LoadedSnapshotEntry | null => {
	if (!isRecord(value) || !isSnapshotPublicationCache(value.publication)) return null;
	const payload = parseSnapshotEntryPayload(value.payload);
	if (!payload || typeof value.isEmpty !== "boolean") return null;
	if (!isFinalSnapshotEntryPayloadValid(payload, authoritativeSettlementState)) return null;
	if (
		value.isEmpty !== (payload.gameweek.state === "EMPTY") ||
		payload.gameweek.eventId !== payload.review.throughEventId ||
		payload.gameweek.eventId !== value.publication.eventId ||
		(value.isEmpty
			? payload.review.timeline.length !== 0
			: (payload.review.timeline.at(-1)?.eventId ?? null) !== payload.review.throughEventId)
	) {
		return null;
	}
	return { publication: value.publication, payload, isEmpty: value.isEmpty };
};

const loadSnapshotEntry = async (
	context: GraphQLContext,
	loadedContext: LoadedReviewContext,
	entryId: number,
	eventId: number,
	snapshotRevision?: string | null
): Promise<LoadedSnapshotEntry | null> => {
	const publication = await loadSnapshotPublication(
		context,
		loadedContext,
		eventId,
		snapshotRevision
	);
	if (!publication) return null;
	const pinned = publication.revision;
	const cacheKey = gqlCacheKey(
		context,
		`my-fpl:${PROJECTION_VERSION}:snapshot-entry:${eventId}:${pinned}:${requireViewerEntryId(context)}`
	);
	const cached = await readMyFplCache(context, cacheKey, (value): value is LoadedSnapshotEntry => {
		const parsed = parseLoadedSnapshotEntryCache(value, publication.settlementState);
		return Boolean(
			parsed &&
			parsed.publication.revision === publication.revision &&
			parsed.publication.eventId === eventId &&
			parsed.payload.entry.id === requireViewerEntryId(context) &&
			parsed.payload.gameweek.eventId === eventId
		);
	});
	if (cached) {
		return {
			...cached,
			publication,
			payload: await applyCurrentEntryNameToSnapshot(context, cached.payload),
		};
	}
	const result = await context.database.query<
		QueryResultRow & {
			payload: unknown;
			is_empty: boolean;
			picks_count: number;
			entry_row_count: number;
			aggregate_row_count: number;
		}
	>(MY_FPL_SNAPSHOT_ENTRY_SQL, [context.currentSeason.seasonId, entryId, eventId, pinned]);
	const row = result.rows[0];
	const envelope = parseSnapshotEntryContractRow(row, publication, entryId, eventId);
	if (!envelope) return null;
	const { payload } = envelope;
	const timelineEventIds = payload.review.timeline.map((timelineRow) => timelineRow.eventId);
	const uniqueTimelineEventIds = new Set(timelineEventIds);
	const expectedHistoryEventIds = [...loadedContext.settledEventIds].filter(
		(settledEventId) =>
			settledEventId <= eventId &&
			(payload.entry.startedEvent === null ||
				payload.entry.startedEvent === undefined ||
				settledEventId >= payload.entry.startedEvent)
	);
	if (
		uniqueTimelineEventIds.size !== timelineEventIds.length ||
		timelineEventIds.some((timelineEventId) => timelineEventId < 1 || timelineEventId > eventId) ||
		(!row.is_empty && timelineEventIds.at(-1) !== eventId) ||
		(!row.is_empty && payload.review.timeline.at(-1)?.status !== publication.kind) ||
		(row.is_empty && timelineEventIds.length !== 0) ||
		(!row.is_empty &&
			expectedHistoryEventIds.some((settledEventId) => !uniqueTimelineEventIds.has(settledEventId)))
	) {
		return null;
	}
	const loaded = {
		publication,
		payload: await applyCurrentEntryNameToSnapshot(context, payload),
		isEmpty: envelope.isEmpty,
	};
	await writeQueryCache(
		context,
		cacheKey,
		JSON.stringify(loaded),
		QUERY_CACHE_TTL_SECONDS.REPORTING
	);
	return loaded;
};

const gameweekReviewFor = (
	snapshot: LoadedSnapshotEntry,
	eventId: number
): MyFplManagerGameweekReview | null =>
	snapshot.payload.review.timeline.find((row) => row.eventId === eventId)?.review ?? null;

const loadManagerGameweekPrepared = async (
	context: GraphQLContext,
	loadedContext: LoadedReviewContext,
	entryId: number,
	eventId: number,
	snapshotRevision?: string | null
): Promise<MyFplManagerGameweek> => {
	validateEventId(eventId);
	const snapshot = await loadSnapshotEntry(
		context,
		loadedContext,
		entryId,
		eventId,
		snapshotRevision
	);
	if (!snapshot) {
		return {
			context: loadedContext.value,
			eventId,
			entry: null,
			state: "PENDING",
			result: null,
			review: null,
			snapshotMeta: null,
		};
	}
	const snapshotEntry = snapshot.payload.entry;
	const snapshotGameweek = snapshot.payload.gameweek;
	const result = snapshotGameweek.result;
	const review = gameweekReviewFor(snapshot, eventId);
	const base = {
		context: loadedContext.value,
		eventId,
		entry: snapshotEntry,
		snapshotMeta: snapshot.publication,
	};
	if (snapshot.isEmpty || snapshotGameweek.state === "EMPTY") {
		return { ...base, state: "EMPTY" as const, result: null, review: null };
	}
	if (!result || result.eventId !== eventId || result.picks.length !== 15 || !review) {
		return { ...base, state: "PENDING" as const, result: null, review: null };
	}
	const cacheKey = gqlCacheKey(
		context,
		`my-fpl:${PROJECTION_VERSION}:manager-gameweek:${entryId}:${eventId}:rev:${snapshot.publication.revision}`
	);
	const cached = await readMyFplCache(
		context,
		cacheKey,
		(value): value is MyFplManagerGameweek =>
			isManagerGameweekCache(value) &&
			value.eventId === eventId &&
			isFinalManagerGameweekCacheValid(
				value,
				snapshot.publication.settlementState,
				eventId,
				snapshot.payload
			)
	);
	if (cached) {
		return {
			...cached,
			entry: applyCurrentEntryName(cached.entry, snapshotEntry.entryName),
			snapshotMeta: snapshot.publication,
		};
	}
	const payload: MyFplManagerGameweek = {
		...base,
		state: "READY",
		result,
		review,
	};
	await writeQueryCache(
		context,
		cacheKey,
		JSON.stringify(payload),
		QUERY_CACHE_TTL_SECONDS.REPORTING
	);
	return payload;
};

const groupManagerTransfers = (snapshot: LoadedSnapshotEntry): MyFplTransferGameweek[] | null => {
	const timelineByEvent = new Map(
		snapshot.payload.review.timeline.map((row) => [row.eventId, row] as const)
	);
	const transferCounts = new Map<number, number>();
	for (const move of snapshot.payload.review.transfers) {
		transferCounts.set(move.eventId, (transferCounts.get(move.eventId) ?? 0) + 1);
	}
	if (
		snapshot.payload.review.timeline.some(
			(row) =>
				row.eventTransfers < 0 || (transferCounts.get(row.eventId) ?? 0) !== row.eventTransfers
		) ||
		snapshot.payload.review.transfers.some((move) => !timelineByEvent.has(move.eventId))
	) {
		return null;
	}
	const grouped = new Map<number, MyFplTransferGameweek>();
	for (const move of snapshot.payload.review.transfers) {
		const timeline = timelineByEvent.get(move.eventId)!;
		const existing = grouped.get(move.eventId) ?? {
			eventId: move.eventId,
			eventTransfers: timeline.eventTransfers,
			eventTransfersCost: timeline.eventTransfersCost,
			transfers: [],
		};
		existing.transfers.push(move);
		grouped.set(move.eventId, existing);
	}
	return [...grouped.values()].sort((left, right) => left.eventId - right.eventId);
};

const emptyManagerReview = (
	state: MyFplReviewState,
	loadedContext: LoadedReviewContext,
	rules: CoreSelectionRules | null,
	throughEventId: number | null = null
): MyFplManagerReview => ({
	state,
	context: loadedContext.value,
	entry: null,
	throughEventId,
	timeline: [],
	summary: null,
	holdings: [],
	transfers: [],
	pastSeasons: [],
	pastSeasonsState: "PENDING",
	currentGameweek: null,
	rules,
	snapshotMeta: null,
});

const loadManagerReview = async (
	context: GraphQLContext,
	snapshotRevision?: string | null
): Promise<MyFplManagerReview> => {
	const entryId = requireViewerEntryId(context);
	const loadedContext = await loadReviewContext(context);
	// A historical My FPL publication does not carry a Core publication
	// revision for its rule set. Returning the current Core rules alongside a
	// pinned snapshot would make the replay non-reproducible after a rules
	// correction. Until Data records a Core revision with each publication,
	// omit rules for explicit historical pins and fail closed on that field.
	const rules = snapshotRevision?.trim() ? null : loadedContext.selectionRules;
	const pinnedPublication = snapshotRevision?.trim()
		? await loadSnapshotPublicationByRevision(context, loadedContext, snapshotRevision)
		: null;
	const throughEventId = pinnedPublication?.eventId ?? defaultReviewEventId(loadedContext);
	if (throughEventId === null) return emptyManagerReview("PRESEASON", loadedContext, rules);
	const snapshot = await loadSnapshotEntry(
		context,
		loadedContext,
		entryId,
		throughEventId,
		snapshotRevision
	);
	if (!snapshot) return emptyManagerReview("PENDING", loadedContext, rules, throughEventId);

	const transfers = groupManagerTransfers(snapshot);
	if (!transfers) return emptyManagerReview("PENDING", loadedContext, rules, throughEventId);
	const entry = snapshot.payload.entry;
	const pastSeasons = snapshot.payload.pastSeasons;
	const pastSeasonsState: MyFplReviewState =
		typeof entry.pastSeasonsCheckedAt === "string" &&
		Number.isFinite(Date.parse(entry.pastSeasonsCheckedAt)) &&
		typeof entry.pastSeasonsCount === "number" &&
		Number.isSafeInteger(entry.pastSeasonsCount) &&
		entry.pastSeasonsCount >= 0 &&
		entry.pastSeasonsCount === pastSeasons.length
			? "READY"
			: "PENDING";
	const currentGameweek: MyFplManagerGameweek = {
		state: snapshot.payload.gameweek.state,
		context: loadedContext.value,
		eventId: throughEventId,
		entry,
		result: snapshot.payload.gameweek.result,
		review: gameweekReviewFor(snapshot, throughEventId),
		snapshotMeta: snapshot.publication,
	};
	const state: MyFplReviewState = snapshot.isEmpty ? "EMPTY" : currentGameweek.state;
	return {
		state,
		context: loadedContext.value,
		entry,
		throughEventId,
		timeline: snapshot.payload.review.timeline,
		summary: snapshot.payload.review.summary,
		holdings: snapshot.payload.review.holdings,
		transfers,
		pastSeasons,
		pastSeasonsState,
		currentGameweek,
		rules,
		snapshotMeta: snapshot.publication,
	};
};

const loadManagerGameweek = async (
	context: GraphQLContext,
	eventId: number,
	snapshotRevision?: string | null
): Promise<MyFplManagerGameweek> => {
	validateEventId(eventId);
	const entryId = requireViewerEntryId(context);
	const loadedContext = await loadReviewContext(context);
	return loadManagerGameweekPrepared(context, loadedContext, entryId, eventId, snapshotRevision);
};

const assertTournamentMembership = async (
	context: GraphQLContext,
	tournamentId: number,
	entryId: number
): Promise<void> => {
	if (context.authorizedTournamentMemberships?.has(tournamentId)) return;
	const result = await context.database.query(MY_FPL_ASSERT_TOURNAMENT_MEMBERSHIP_SQL, [
		context.currentSeason.seasonId,
		entryId,
		tournamentId,
	]);
	if (result.rowCount !== 1) {
		throw new GraphQLError("User is not a member of this tournament", {
			extensions: { code: "FORBIDDEN" },
		});
	}
	(context.authorizedTournamentMemberships ??= new Set()).add(tournamentId);
};

type DbTournamentMembershipRow = QueryResultRow & { tournament_id: number };

const filterCurrentTournamentMemberships = async (
	context: GraphQLContext,
	entryId: number,
	tournaments: TournamentInfo[]
): Promise<TournamentInfo[]> => {
	const result = await context.database.query<DbTournamentMembershipRow>(
		MY_FPL_LIST_TOURNAMENT_MEMBERSHIPS_SQL,
		[context.currentSeason.seasonId, entryId]
	);
	const currentTournamentIds = result.rows.map((row) => row.tournament_id);
	const cachedById = new Map(tournaments.map((tournament) => [tournament.id, tournament]));
	const missingTournamentIds = currentTournamentIds.filter(
		(tournamentId) => !cachedById.has(tournamentId)
	);
	const uncachedTournaments = await dependenciesFor(
		context
	).tournamentsRepository.getTournamentInfosUncached(context, missingTournamentIds);
	for (const tournament of uncachedTournaments) {
		if (tournament) cachedById.set(tournament.id, tournament);
	}
	return currentTournamentIds.flatMap((tournamentId) => {
		const tournament = cachedById.get(tournamentId);
		return tournament ? [tournament] : [];
	});
};

const normalizeSearch = (value?: string | null): string => {
	const normalized = value?.trim() ?? "";
	if (normalized.length > 80) {
		throw new GraphQLError("search must contain at most 80 characters", {
			extensions: { code: "BAD_USER_INPUT" },
		});
	}
	return normalized;
};

const mapBoardJsonRow = (row: DbBoardJsonRow): MyFplCompetitionBoardRow => ({
	eventId: row.event_id,
	groupId: row.group_id,
	entryId: row.entry_id,
	entryName: row.entry_name,
	playerName: row.player_name,
	rank: asInteger(row.rank),
	previousRank: asInteger(row.previous_rank),
	fieldRank: asInteger(row.field_rank),
	eventPoints: row.event_points,
	eventCost: row.event_cost,
	eventNetPoints: row.event_net_points,
	eventRank: row.event_rank,
	overallPoints: row.overall_points,
	overallRank: row.overall_rank,
	eventChip: normalizeNullableChip(row.event_chip),
	captainId: row.captain_id,
	captainWebName: row.captain_web_name,
	captainTeamShortName: row.captain_team_short_name,
	captainPoints: row.captain_points,
	teamValue: row.team_value,
	bank: row.bank,
});

export const mapSnapshotBoardRow = (
	value: unknown,
	expectedEventId: number
): MyFplCompetitionBoardRow | null => {
	if (!isRecord(value)) return null;
	const integerOrNull = (candidate: unknown): number | null =>
		candidate === null || candidate === undefined ? null : asInteger(candidate);
	const textOrNull = (candidate: unknown): string | null =>
		candidate === null || candidate === undefined ? null : String(candidate);
	const eventId = asInteger(value.eventId);
	const entryId = asInteger(value.entryId);
	const storedEntryId = asInteger(value.__snapshotEntryId);
	if (
		eventId === null ||
		eventId !== expectedEventId ||
		entryId === null ||
		storedEntryId === null ||
		storedEntryId !== entryId
	) {
		return null;
	}
	return {
		eventId,
		groupId: integerOrNull(value.groupId),
		entryId,
		entryName: textOrNull(value.entryName),
		playerName: textOrNull(value.playerName),
		rank: integerOrNull(value.rank),
		previousRank: integerOrNull(value.previousRank),
		fieldRank: integerOrNull(value.fieldRank),
		eventPoints: integerOrNull(value.eventPoints),
		eventCost: integerOrNull(value.eventCost),
		eventNetPoints: integerOrNull(value.eventNetPoints),
		eventRank: integerOrNull(value.eventRank),
		overallPoints: integerOrNull(value.overallPoints),
		overallRank: integerOrNull(value.overallRank),
		eventChip:
			value.eventChip === null || value.eventChip === undefined
				? null
				: normalizeNullableChip(String(value.eventChip)),
		captainId: integerOrNull(value.captainId),
		captainWebName: textOrNull(value.captainWebName),
		captainTeamShortName: textOrNull(value.captainTeamShortName),
		captainPoints: integerOrNull(value.captainPoints),
		teamValue: integerOrNull(value.teamValue),
		bank: integerOrNull(value.bank),
	};
};

export type CompetitionBoardProbe = Readonly<{
	fieldSize: number;
	totalRows: number;
	expectedFieldSize: number;
	invalidRowCount: number;
	rows: MyFplCompetitionBoardRow[];
	viewerRow: MyFplCompetitionBoardRow;
}>;

/**
 * Decode and validate the complete board SQL result used by the production
 * reader.  A non-empty field alone is not sufficient: every returned JSON
 * row, the aggregate field-size fence, and the viewer row must agree before
 * the board can be served or accepted by the Data contract probe.
 */
export const parseCompetitionBoardProbe = (
	value: unknown,
	expectedEventId: number
): CompetitionBoardProbe | null => {
	if (!isRecord(value)) return null;
	const fieldSize = asInteger(value.field_size);
	const totalRows = asInteger(value.total_rows);
	const expectedFieldSize = asInteger(value.expected_field_size);
	const invalidRowCount = asInteger(value.invalid_row_count);
	const rawRows = Array.isArray(value.rows) ? value.rows : [];
	const rows = rawRows
		.map((row) => mapSnapshotBoardRow(row, expectedEventId))
		.filter((row): row is MyFplCompetitionBoardRow => row !== null);
	const viewerRow = mapSnapshotBoardRow(value.viewer_row, expectedEventId);
	if (
		fieldSize === null ||
		totalRows === null ||
		expectedFieldSize === null ||
		invalidRowCount === null ||
		viewerRow === null ||
		fieldSize < 0 ||
		totalRows < 0 ||
		totalRows > fieldSize ||
		invalidRowCount !== 0 ||
		expectedFieldSize <= 0 ||
		fieldSize !== expectedFieldSize ||
		rawRows.length !== rows.length ||
		fieldSize === 0
	) {
		return null;
	}
	return { fieldSize, totalRows, expectedFieldSize, invalidRowCount, rows, viewerRow };
};

const loadCompetitionBoardPrepared = async (
	context: GraphQLContext,
	loadedContext: LoadedReviewContext,
	entryId: number,
	tournamentId: number,
	eventId: number,
	page: number,
	pageSize: number,
	search?: string | null,
	tournament?: TournamentInfo | null,
	snapshotRevision?: string | null
): Promise<MyFplCompetitionBoardPage> => {
	validateTournamentId(tournamentId);
	validateEventId(eventId);
	if (!Number.isSafeInteger(page) || page < 1 || page > MAX_COMPETITION_BOARD_PAGE) {
		throw new GraphQLError("page must be an integer between 1 and 100", {
			extensions: { code: "BAD_USER_INPUT" },
		});
	}
	if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
		throw new GraphQLError("pageSize must be an integer between 1 and 100", {
			extensions: { code: "BAD_USER_INPUT" },
		});
	}
	const normalizedSearch = normalizeSearch(search);
	await assertTournamentMembership(context, tournamentId, entryId);
	const metadata =
		tournament ??
		(await dependenciesFor(context).tournamentsRepository.getTournamentInfoUncached(
			context,
			tournamentId
		));
	const empty = (
		state: MyFplReviewState,
		snapshotMeta: MyFplSnapshotMeta | null = null
	): MyFplCompetitionBoardPage => ({
		state,
		eventId,
		page,
		pageSize,
		totalRows: 0,
		totalPages: 0,
		fieldSize: 0,
		rows: [],
		viewerRow: null,
		snapshotMeta,
	});
	if (!metadata) return empty("EMPTY");
	if (metadata.groupMode !== GroupMode.POINTS_RACES) return empty("UNAVAILABLE");
	const snapshot = await loadSnapshotEntry(
		context,
		loadedContext,
		entryId,
		eventId,
		snapshotRevision
	);
	if (!snapshot) return empty("PENDING");
	const revision = snapshot.publication.revision;
	const cacheKey = gqlCacheKey(
		context,
		`my-fpl:${PROJECTION_VERSION}:competition-board:${tournamentId}:${eventId}:${page}:${pageSize}:${normalizedSearch.toLocaleLowerCase("en-US")}:${entryId}:rev:${revision}`
	);
	const cached = await readMyFplCache(
		context,
		cacheKey,
		(value): value is MyFplCompetitionBoardPage =>
			isCompetitionBoardCache(value) && value.eventId === eventId
	);
	if (cached) {
		return {
			...(await applyCurrentEntryNamesToBoardPage(context, cached)),
			snapshotMeta: snapshot.publication,
		};
	}
	const offset = (page - 1) * pageSize;
	const result = await context.database.query<{
		field_size: number;
		total_rows: number;
		expected_field_size: number | null;
		invalid_row_count: number;
		rows: unknown;
		viewer_row: unknown;
	}>(MY_FPL_COMPETITION_BOARD_SQL, [
		context.currentSeason.seasonId,
		eventId,
		revision,
		tournamentId,
		normalizedSearch,
		pageSize,
		offset,
		entryId,
	]);
	const board = parseCompetitionBoardProbe(result.rows[0], eventId);
	if (!board) {
		return empty("PENDING", snapshot.publication);
	}
	const { fieldSize, totalRows, rows, viewerRow } = board;
	const payload: MyFplCompetitionBoardPage = await applyCurrentEntryNamesToBoardPage(context, {
		state: "READY",
		eventId,
		page,
		pageSize,
		totalRows,
		totalPages: totalRows === 0 ? 0 : Math.ceil(totalRows / pageSize),
		fieldSize,
		rows,
		viewerRow,
		snapshotMeta: snapshot.publication,
	});
	if (cacheableState(payload.state)) {
		await writeQueryCache(context, cacheKey, JSON.stringify(payload), stateTtl(payload.state));
	}
	return payload;
};

const loadCompetitionAggregateSnapshot = async (
	context: GraphQLContext,
	loadedContext: LoadedReviewContext,
	tournamentId: number,
	eventId: number,
	entryId: number,
	snapshotRevision?: string | null
): Promise<MyFplCompetitionAggregate | null> => {
	const snapshot = await loadSnapshotPublication(context, loadedContext, eventId, snapshotRevision);
	const revision = snapshot?.revision;
	if (!revision || !normalizeSnapshotRevision(revision)) return null;
	const cacheKey = gqlCacheKey(
		context,
		`my-fpl:${PROJECTION_VERSION}:competition-aggregate:${tournamentId}:${eventId}:${entryId}:rev:${revision}`
	);
	const cached = await readMyFplCache(
		context,
		cacheKey,
		(value): value is MyFplCompetitionAggregate =>
			isCompetitionAggregateCache(value) && value.eventId === eventId
	);
	if (cached) {
		return {
			...(await applyCurrentEntryNamesToAggregate(context, cached)),
			snapshotMeta: snapshot,
		};
	}
	const result = await context.database.query<{ payload: unknown }>(
		MY_FPL_COMPETITION_AGGREGATE_SQL,
		[context.currentSeason.seasonId, eventId, revision, tournamentId]
	);
	const raw = result.rows[0]?.payload;
	const normalized = parseCompetitionAggregatePayload(raw, entryId);
	if (!normalized || normalized.eventId !== eventId) return null;
	const current = await applyCurrentEntryNamesToAggregate(context, {
		...normalized,
		snapshotMeta: snapshot,
	});
	await writeQueryCache(
		context,
		cacheKey,
		JSON.stringify(current),
		QUERY_CACHE_TTL_SECONDS.REPORTING
	);
	return current;
};

export const parseCompetitionSeasonPathPoints = (
	value: unknown
): MyFplCompetitionSeasonPathPoint[] | null => {
	if (!Array.isArray(value)) return null;
	const points: MyFplCompetitionSeasonPathPoint[] = [];
	for (const candidate of value) {
		if (!isRecord(candidate)) return null;
		const nullableInteger = (key: string): number | null | undefined => {
			if (!Object.prototype.hasOwnProperty.call(candidate, key)) return undefined;
			if (candidate[key] === null) return null;
			return asInteger(candidate[key]);
		};
		const nullableNumber = (key: string): number | null | undefined => {
			if (!Object.prototype.hasOwnProperty.call(candidate, key)) return undefined;
			if (candidate[key] === null) return null;
			return asFiniteNumber(candidate[key]);
		};
		const gameweek = asInteger(candidate.gameweek);
		const fieldSize = asInteger(candidate.fieldSize);
		const tournamentRank = nullableInteger("tournamentRank");
		const gapToLeader = nullableInteger("gapToLeader");
		const pointsVsAverage = nullableNumber("pointsVsAverage");
		const overallPoints = nullableInteger("overallPoints");
		const leaderOverallPoints = nullableInteger("leaderOverallPoints");
		const averageOverallPoints = nullableNumber("averageOverallPoints");
		if (
			gameweek === null ||
			fieldSize === null ||
			fieldSize < 0 ||
			tournamentRank === undefined ||
			gapToLeader === undefined ||
			pointsVsAverage === undefined ||
			overallPoints === undefined ||
			leaderOverallPoints === undefined ||
			averageOverallPoints === undefined
		) {
			return null;
		}
		points.push({
			gameweek,
			tournamentRank,
			gapToLeader,
			pointsVsAverage,
			fieldSize,
			overallPoints,
			leaderOverallPoints,
			averageOverallPoints,
		});
	}
	return points;
};

const loadCompetitionBoard = async (
	context: GraphQLContext,
	args: {
		tournamentId: number;
		eventId: number;
		page?: number | null;
		pageSize?: number | null;
		search?: string | null;
		snapshotRevision?: string | null;
	}
): Promise<MyFplCompetitionBoardPage> => {
	const entryId = requireViewerEntryId(context);
	const loadedContext = await loadReviewContext(context);
	return loadCompetitionBoardPrepared(
		context,
		loadedContext,
		entryId,
		args.tournamentId,
		args.eventId,
		args.page ?? 1,
		args.pageSize ?? 100,
		args.search,
		undefined,
		args.snapshotRevision
	);
};

const loadCompetitionsDesk = async (
	context: GraphQLContext,
	tournamentId?: number | null,
	eventId?: number | null,
	snapshotRevision?: string | null
): Promise<MyFplCompetitionsDesk> => {
	if (tournamentId !== undefined && tournamentId !== null) validateTournamentId(tournamentId);
	if (eventId !== undefined && eventId !== null) validateEventId(eventId);
	const entryId = requireViewerEntryId(context);
	// getEntryTournaments derives its cache key synchronously. Pin the compact
	// Core revision first, then overlap the remaining lifecycle SQL and catalog
	// read without ever creating an unversioned cache path.
	await dependenciesFor(context).getCoreEventSnapshot(context);
	const requestedTournamentPromise = tournamentId
		? dependenciesFor(context).tournamentsRepository.getTournamentInfoUncached(
				context,
				tournamentId
			)
		: Promise.resolve(null);
	const [loadedContext, cachedTournaments, requestedTournament] = await Promise.all([
		loadReviewContext(context),
		dependenciesFor(context).tournamentsRepository.getEntryTournaments(context, entryId),
		requestedTournamentPromise,
	]);
	let tournaments = await filterCurrentTournamentMemberships(context, entryId, cachedTournaments);
	const selectedTournament = (tournamentId ? requestedTournament : tournaments[0]) ?? null;
	if (tournamentId && !selectedTournament) {
		throw new GraphQLError("User is not a member of this tournament", {
			extensions: { code: "FORBIDDEN" },
		});
	}
	if (!selectedTournament) {
		return {
			state: tournaments.length === 0 ? "EMPTY" : "UNAVAILABLE",
			context: loadedContext.value,
			tournaments,
			selectedTournamentId: null,
			selectedTournament: null,
			eventId: null,
			board: null,
			aggregate: null,
			snapshotMeta: null,
		};
	}
	// The catalog is revision-cached, so revalidate the selected default
	// tournament before returning even during preseason. This prevents a
	// recently revoked membership from receiving cached protected metadata.
	await assertTournamentMembership(context, selectedTournament.id, entryId);
	if (!tournaments.some((tournament) => tournament.id === selectedTournament.id)) {
		tournaments = [...tournaments, selectedTournament];
	}
	const pinnedPublication = snapshotRevision?.trim()
		? await loadSnapshotPublicationByRevision(context, loadedContext, snapshotRevision)
		: null;
	const selectedEventId =
		eventId ?? pinnedPublication?.eventId ?? defaultReviewEventId(loadedContext);
	if (selectedEventId === null) {
		return {
			state: "PRESEASON",
			context: loadedContext.value,
			tournaments,
			selectedTournamentId: selectedTournament.id,
			selectedTournament,
			eventId: null,
			board: null,
			aggregate: null,
			snapshotMeta: null,
		};
	}
	const boardPromise = loadCompetitionBoardPrepared(
		context,
		loadedContext,
		entryId,
		selectedTournament.id,
		selectedEventId,
		1,
		100,
		null,
		selectedTournament,
		snapshotRevision
	);
	const hasSnapshot =
		loadedContext.publications.has(selectedEventId) || Boolean(snapshotRevision?.trim());
	const canLoadAggregate =
		hasSnapshot &&
		selectedTournament.groupMode === GroupMode.POINTS_RACES &&
		selectedTournament.setupStatus === TournamentSetupStatus.READY &&
		Boolean(selectedTournament.standingsReadyAt) &&
		Boolean(selectedTournament.insightsReadyAt);
	const [board, aggregateCandidate] = canLoadAggregate
		? await Promise.all([
				boardPromise,
				loadCompetitionAggregateSnapshot(
					context,
					loadedContext,
					selectedTournament.id,
					selectedEventId,
					entryId,
					snapshotRevision
				),
			])
		: [await boardPromise, null];
	const aggregate = board.state === "READY" ? aggregateCandidate : null;
	const aggregateInvalid = board.state === "READY" && canLoadAggregate && aggregate === null;
	const deskState = aggregateInvalid ? "PENDING" : board.state;
	return {
		state: deskState,
		context: loadedContext.value,
		tournaments,
		selectedTournamentId: selectedTournament.id,
		selectedTournament,
		eventId: selectedEventId,
		board: aggregateInvalid ? null : board,
		aggregate,
		snapshotMeta: board.snapshotMeta ?? aggregate?.snapshotMeta ?? null,
	};
};

const loadCompetitionSeasonPath = async (
	context: GraphQLContext,
	tournamentId: number,
	throughEventId: number,
	snapshotRevision?: string | null
): Promise<MyFplCompetitionSeasonPath> => {
	validateTournamentId(tournamentId);
	validateEventId(throughEventId);
	const entryId = requireViewerEntryId(context);
	const loadedContext = await loadReviewContext(context);
	await assertTournamentMembership(context, tournamentId, entryId);
	const empty = (
		state: MyFplReviewState,
		snapshotMeta: MyFplSnapshotMeta | null = null
	): MyFplCompetitionSeasonPath => ({
		state,
		context: loadedContext.value,
		tournamentId,
		throughEventId,
		points: [],
		snapshotMeta,
	});
	const tournament = await dependenciesFor(context).tournamentsRepository.getTournamentInfoUncached(
		context,
		tournamentId
	);
	if (!tournament) return empty("UNAVAILABLE");
	if (tournament.groupMode !== GroupMode.POINTS_RACES) return empty("UNAVAILABLE");
	if (
		tournament.setupStatus !== TournamentSetupStatus.READY ||
		!tournament.standingsReadyAt ||
		!tournament.insightsReadyAt
	) {
		return empty("PENDING");
	}
	const snapshot = await loadSnapshotEntry(
		context,
		loadedContext,
		entryId,
		throughEventId,
		snapshotRevision
	);
	if (!snapshot) return empty("PENDING");
	const revision = snapshot.publication.revision;
	const cacheKey = gqlCacheKey(
		context,
		`my-fpl:${PROJECTION_VERSION}:competition-season-path:${tournamentId}:${entryId}:${throughEventId}:rev:${revision}`
	);
	const cached = await readMyFplCache(
		context,
		cacheKey,
		(value): value is MyFplCompetitionSeasonPath =>
			isCompetitionSeasonPathCache(value) && value.throughEventId === throughEventId
	);
	if (cached) return { ...cached, snapshotMeta: snapshot.publication };
	const result = await context.database.query<{ payload: unknown }>(
		MY_FPL_COMPETITION_SEASON_PATH_SQL,
		[context.currentSeason.seasonId, throughEventId, revision, tournamentId]
	);
	const raw = result.rows[0]?.payload;
	const rawPoints =
		isRecord(raw) && isRecord(raw.seasonPaths)
			? raw.seasonPaths[String(entryId)]
			: isRecord(raw)
				? raw.seasonPath
				: null;
	const points = parseCompetitionSeasonPathPoints(rawPoints);
	if (points === null) return empty("PENDING", snapshot.publication);
	const payload: MyFplCompetitionSeasonPath = {
		state: points.some((point) => point.gameweek === throughEventId) ? "READY" : "PENDING",
		context: loadedContext.value,
		tournamentId,
		throughEventId,
		points,
		snapshotMeta: snapshot.publication,
	};
	if (cacheableState(payload.state)) {
		await writeQueryCache(context, cacheKey, JSON.stringify(payload), stateTtl(payload.state));
	}
	return payload;
};

const loadCompetitionSetupStatus = async (
	context: GraphQLContext,
	tournamentId: number
): Promise<MyFplCompetitionSetupStatus> => {
	validateTournamentId(tournamentId);
	const entryId = requireViewerEntryId(context);
	await dependenciesFor(context).getCoreEventSnapshot(context);
	await assertTournamentMembership(context, tournamentId, entryId);
	const result = await context.database.query<DbSetupStatusRow>(
		MY_FPL_COMPETITION_SETUP_STATUS_SQL,
		[context.currentSeason.seasonId, tournamentId]
	);
	const row = result.rows[0];
	if (!row) {
		throw new GraphQLError("Tournament not found", {
			extensions: { code: "NOT_FOUND" },
		});
	}
	return {
		tournamentId,
		setupStatus: (row.setup_status ?? TournamentSetupStatus.PENDING).toUpperCase(),
		setupPhase: (row.setup_phase ?? "queued").toUpperCase(),
		setupCompletedUnits: row.setup_completed_units ?? 0,
		setupTotalUnits: row.setup_total_units ?? 0,
		setupProgressUpdatedAt: isoString(row.setup_progress_updated_at),
		standingsReadyAt: isoString(row.standings_ready_at),
		insightsReadyAt: isoString(row.insights_ready_at ?? null),
		setupHasWarnings: (row.setup_warning_count ?? 0) > 0,
		ready:
			row.setup_status === TournamentSetupStatus.READY &&
			row.setup_phase === "ready" &&
			row.standings_ready_at !== null &&
			row.insights_ready_at !== null,
	};
};

export type MyFplRepository = {
	loadManagerReview: typeof loadManagerReview;
	loadManagerGameweek: typeof loadManagerGameweek;
	loadCompetitionsDesk: typeof loadCompetitionsDesk;
	loadCompetitionBoard: typeof loadCompetitionBoard;
	loadCompetitionSeasonPath: typeof loadCompetitionSeasonPath;
	loadCompetitionSetupStatus: typeof loadCompetitionSetupStatus;
};

export const createMyFplRepository = (
	overrides: Partial<MyFplRepositoryDependencies> = {}
): MyFplRepository => {
	const dependencies: MyFplRepositoryDependencies = { ...defaultDependencies, ...overrides };
	return {
		loadManagerReview: (context, snapshotRevision) =>
			withDependencies(context, dependencies, () => loadManagerReview(context, snapshotRevision)),
		loadManagerGameweek: (context, eventId, snapshotRevision) =>
			withDependencies(context, dependencies, () =>
				loadManagerGameweek(context, eventId, snapshotRevision)
			),
		loadCompetitionsDesk: (context, tournamentId, eventId, snapshotRevision) =>
			withDependencies(context, dependencies, () =>
				loadCompetitionsDesk(context, tournamentId, eventId, snapshotRevision)
			),
		loadCompetitionBoard: (context, args) =>
			withDependencies(context, dependencies, () => loadCompetitionBoard(context, args)),
		loadCompetitionSeasonPath: (context, tournamentId, throughEventId, snapshotRevision) =>
			withDependencies(context, dependencies, () =>
				loadCompetitionSeasonPath(context, tournamentId, throughEventId, snapshotRevision)
			),
		loadCompetitionSetupStatus: (context, tournamentId) =>
			withDependencies(context, dependencies, () =>
				loadCompetitionSetupStatus(context, tournamentId)
			),
	};
};

export const myFplRepository = createMyFplRepository();

export const myFplTestables = {
	normalizeSearch,
	normalizeChip,
	positionName,
	mapBoardJsonRow,
	snapshotDateKey,
	snapshotTimeliness,
	settlementStateFromRow,
	compareSnapshotRevisions,
};
