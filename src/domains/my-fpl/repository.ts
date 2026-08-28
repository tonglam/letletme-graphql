import { GraphQLError } from "graphql";
import type { QueryResultRow } from "pg";
import type { DataSqlContractProbe } from "../../contracts/data-sql-contract";
import {
	GRAPHQL_DATA_CONTRACT_LEAGUE_ONLY_TOURNAMENT_ID,
	GRAPHQL_DATA_CONTRACT_TOURNAMENT_ID,
} from "../../contracts/data-fixture-identities";
import type { GraphQLContext } from "../../graphql/context";
import { viewerEntryIdForPrincipal } from "../../graphql/authorization";
import { gqlCacheKey } from "../../infra/cache-key";
import { getCoreEventSnapshot } from "../../infra/data-snapshot";
import { QUERY_CACHE_TTL_SECONDS, writeQueryCache } from "../../infra/query-cache";
import { entriesService } from "../entries/service";
import {
	GroupMode,
	TournamentSetupStatus,
	tournamentsRepository,
	type TournamentInfo,
} from "../tournaments/repository";

export const MY_FPL_EVENT_LIFECYCLE_SQL = `
	SELECT event_id, finished, data_checked, live_snapshot_finalized_at
	FROM fpl.events
	WHERE season_id = $1
	ORDER BY event_id
`;

export const MY_FPL_ACTIVE_PUBLICATIONS_SQL = `
	SELECT season_id, event_id, revision, snapshot_date, source_checked_at,
		published_at, kind, expected_entry_count, ready_entry_count,
		empty_entry_count, expected_tournament_count,
		ready_tournament_count, content_sha256, score_source,
		live_publication_id, live_revision, algorithm_version,
		source_min_checked_at, source_max_checked_at
	FROM competition.my_fpl_snapshot_publications
	WHERE season_id = $1 AND active
	ORDER BY event_id
`;

export const MY_FPL_PUBLICATION_BY_EVENT_REVISION_SQL = `
	SELECT season_id, event_id, revision, snapshot_date, source_checked_at,
		published_at, kind, expected_entry_count, ready_entry_count,
		empty_entry_count, expected_tournament_count,
		ready_tournament_count, content_sha256, score_source,
		live_publication_id, live_revision, algorithm_version,
		source_min_checked_at, source_max_checked_at
	FROM competition.my_fpl_snapshot_publications
	WHERE season_id = $1
		AND event_id = $2
		AND revision = $3::bigint
	LIMIT 1
`;

export const MY_FPL_PUBLICATION_BY_REVISION_SQL = `
	SELECT season_id, event_id, revision, snapshot_date, source_checked_at,
		published_at, kind, expected_entry_count, ready_entry_count,
		empty_entry_count, expected_tournament_count,
		ready_tournament_count, content_sha256, score_source,
		live_publication_id, live_revision, algorithm_version,
		source_min_checked_at, source_max_checked_at
	FROM competition.my_fpl_snapshot_publications
	WHERE season_id = $1
		AND revision = $2::bigint
	ORDER BY event_id
	LIMIT 1
`;

export const MY_FPL_SNAPSHOT_ENTRY_SQL = `
	SELECT
		(SELECT count(*)::integer
			FROM competition.my_fpl_snapshot_entries all_entries
			WHERE all_entries.season_id = publication.season_id
				AND all_entries.event_id = publication.event_id
				AND all_entries.revision = publication.revision) AS entry_row_count,
		(SELECT count(*)::integer
			FROM competition.my_fpl_snapshot_tournament_aggregates all_aggregates
			WHERE all_aggregates.season_id = publication.season_id
				AND all_aggregates.event_id = publication.event_id
				AND all_aggregates.revision = publication.revision) AS aggregate_row_count,
		snapshot.payload, snapshot.is_empty, snapshot.picks_count
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
		runtime: "must-return-row",
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
export type MyFplSnapshotFreshness = "CURRENT" | "GENERATING" | "STALE";
export type MyFplScoreSource = "FPL_EVENT_LIVE" | "FPL_FINAL_RESULT";
export type MyFplSnapshotMeta = {
	revision: string;
	eventId: number;
	snapshotDate: string;
	sourceCheckedAt: string;
	publishedAt: string;
	kind: MyFplSnapshotKind;
	freshness: MyFplSnapshotFreshness;
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

const loadCurrentEntryNames = async (
	context: GraphQLContext,
	entryIds: readonly number[]
): Promise<Map<number, string>> => {
	const uniqueEntryIds = [
		...new Set(entryIds.filter((entryId) => Number.isSafeInteger(entryId) && entryId > 0)),
	];
	if (uniqueEntryIds.length === 0) return new Map();

	const entries = await dependenciesFor(context).getEntriesByIds(context, uniqueEntryIds);
	const names = new Map<number, string>();
	for (const entryId of uniqueEntryIds) {
		const entry = entries.get(entryId);
		if (entry) names.set(entryId, entry.entryName);
	}
	return names;
};

type LoadedReviewContext = {
	value: MyFplReviewContext;
	finalizedEventIds: Set<number>;
	settledEventIds: Set<number>;
	publications: Map<number, MyFplSnapshotPublication>;
};

type MyFplSnapshotPublication = MyFplSnapshotMeta & {
	expectedEntryCount: number;
	readyEntryCount: number;
	emptyEntryCount: number;
	expectedTournamentCount: number;
	readyTournamentCount: number;
	contentSha256: string;
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

export type MyFplTeamHistoryRow = {
	eventId: number;
	eventPoints: number;
	eventRank: number | null;
	overallPoints: number;
	overallRank: number;
	eventTransfers: number;
	eventTransfersCost: number;
	eventNetPoints: number;
	eventBenchPoints: number;
	eventChip: string;
	eventCaptainPoints: number;
	captainWebName: string | null;
	captainTeamShortName: string | null;
	teamValue: number | null;
	bank: number | null;
};

export type MyFplPastSeason = {
	season: string;
	totalPoints: number;
	overallRank: number;
};

export type MyFplTeamPick = {
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

export type MyFplTeamGameweekResult = {
	eventId: number;
	eventPoints: number;
	overallPoints: number;
	overallRank: number;
	eventTransfers: number;
	eventTransfersCost: number;
	eventNetPoints: number;
	eventBenchPoints: number;
	eventChip: string;
	eventCaptainPoints: number;
	playedCaptainWebName: string | null;
	teamValue: number | null;
	bank: number | null;
	picks: MyFplTeamPick[];
};

export type MyFplTeamGameweek = {
	state: MyFplReviewState;
	context: MyFplReviewContext;
	eventId: number;
	entry: MyFplEntryIdentity | null;
	result: MyFplTeamGameweekResult | null;
	snapshotMeta?: MyFplSnapshotMeta | null;
};

export type MyFplTeamDesk = {
	state: MyFplReviewState;
	context: MyFplReviewContext;
	entry: MyFplEntryIdentity | null;
	history: MyFplTeamHistoryRow[];
	pastSeasons: MyFplPastSeason[];
	pastSeasonsState: MyFplReviewState;
	selectedEventId: number | null;
	gameweek: MyFplTeamGameweek | null;
	snapshotMeta: MyFplSnapshotMeta | null;
};

export type MyFplTransferMove = {
	eventId: number;
	elementInWebName: string;
	elementInTypeName: string;
	elementInTeamShortName: string;
	elementInCost: number;
	elementOutWebName: string;
	elementOutTypeName: string;
	elementOutTeamShortName: string;
	elementOutCost: number;
	time: string;
};

export type MyFplTransferGameweek = {
	eventId: number;
	eventTransfers: number;
	eventTransfersCost: number;
	transfers: MyFplTransferMove[];
};

export type MyFplTeamTransfers = {
	state: MyFplReviewState;
	context: MyFplReviewContext;
	gameweeks: MyFplTransferGameweek[];
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

const applyCurrentEntryName = (
	entry: MyFplEntryIdentity | null,
	currentEntryName: string
): MyFplEntryIdentity | null => (entry ? { ...entry, entryName: currentEntryName } : null);

const applyCurrentEntryNamesToBoardPage = async (
	context: GraphQLContext,
	page: MyFplCompetitionBoardPage
): Promise<MyFplCompetitionBoardPage> => {
	const entryIds = [
		...page.rows.map((row) => row.entryId),
		...(page.viewerRow ? [page.viewerRow.entryId] : []),
	];
	const names = await loadCurrentEntryNames(context, entryIds);
	const applyRowName = (row: MyFplCompetitionBoardRow | null): MyFplCompetitionBoardRow | null => {
		if (!row) return null;
		const currentEntryName = names.get(row.entryId);
		return currentEntryName === undefined ? row : { ...row, entryName: currentEntryName };
	};
	return {
		...page,
		rows: page.rows
			.map(applyRowName)
			.filter((row): row is MyFplCompetitionBoardRow => row !== null),
		viewerRow: applyRowName(page.viewerRow),
	};
};

const applyCurrentEntryNamesToAggregate = async (
	context: GraphQLContext,
	aggregate: MyFplCompetitionAggregate
): Promise<MyFplCompetitionAggregate> => {
	const entryIds = [
		...aggregate.metrics.map((metric) => metric.leaderEntryId),
		...aggregate.topPerformers.map((performance) => performance.entryId),
		...aggregate.risers.map((performance) => performance.entryId),
		...aggregate.fallers.map((performance) => performance.entryId),
	].filter(
		(entryId): entryId is number =>
			typeof entryId === "number" && Number.isSafeInteger(entryId) && entryId > 0
	);
	const names = await loadCurrentEntryNames(context, entryIds);
	const currentNameFor = (entryId: number, fallback: string | null): string | null =>
		names.get(entryId) ?? fallback;
	return {
		...aggregate,
		metrics: aggregate.metrics.map((metric) => {
			const leaderEntryId = metric.leaderEntryId;
			return {
				...metric,
				leaderEntryName:
					leaderEntryId === null
						? metric.leaderEntryName
						: currentNameFor(leaderEntryId, metric.leaderEntryName),
			};
		}),
		topPerformers: aggregate.topPerformers.map((performance) => ({
			...performance,
			entryName: currentNameFor(performance.entryId, performance.entryName),
		})),
		risers: aggregate.risers.map((performance) => ({
			...performance,
			entryName: currentNameFor(performance.entryId, performance.entryName),
		})),
		fallers: aggregate.fallers.map((performance) => ({
			...performance,
			entryName: currentNameFor(performance.entryId, performance.entryName),
		})),
	};
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
	expected_tournament_count: number;
	ready_tournament_count: number;
	content_sha256: string;
	score_source: MyFplScoreSource | null;
	live_publication_id: string | null;
	live_revision: string | null;
	algorithm_version: string | null;
	source_min_checked_at: Date | string | null;
	source_max_checked_at: Date | string | null;
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
const PROJECTION_VERSION = "v10";
const NULLABLE_STATE_CACHE_TTL_SECONDS = 30;
// Keep OFFSET bounded for the fixed-cost board root. Page 100 is the maximum
// 10,000-row window at the maximum page size.
const MAX_COMPETITION_BOARD_PAGE = 100;
const defaultReviewEventId = (context: LoadedReviewContext): number | null =>
	context.value.latestPublishedEventId ??
	context.value.currentEventId ??
	context.value.latestFinalizedEventId;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

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

const normalizeChip = (value: string | null): string => {
	const compact = String(value ?? "NONE")
		.toUpperCase()
		.replace(/[^A-Z0-9]/g, "");
	if (["BENCHBOOST", "BBOOST", "BB"].includes(compact)) return "BENCH_BOOST";
	if (["TRIPLECAPTAIN", "3XC", "TC"].includes(compact)) return "TRIPLE_CAPTAIN";
	if (["FREEHIT", "FH"].includes(compact)) return "FREE_HIT";
	if (["WILDCARD", "WC"].includes(compact)) return "WILDCARD";
	if (["MANAGER", "AM"].includes(compact)) return "MANAGER";
	return "NONE";
};

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

const isSnapshotMeta = (value: unknown): value is MyFplSnapshotMeta =>
	isTypedRecord(value, {
		revision: (candidate) => typeof candidate === "string",
		eventId: isSafeInteger,
		snapshotDate: isCalendarDate,
		sourceCheckedAt: isIsoDateTime,
		publishedAt: isIsoDateTime,
		kind: (candidate) => candidate === "PROVISIONAL" || candidate === "FINAL",
		freshness: (candidate) =>
			candidate === "CURRENT" || candidate === "GENERATING" || candidate === "STALE",
		scoreSource: (candidate) => candidate === "FPL_EVENT_LIVE" || candidate === "FPL_FINAL_RESULT",
		livePublicationId: isNullableString,
		liveRevision: isNullableString,
		algorithmVersion: isNullableString,
		sourceMinCheckedAt: isIsoDateTime,
		sourceMaxCheckedAt: isIsoDateTime,
	});

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

const isTeamHistoryRowCache = (value: unknown): value is MyFplTeamHistoryRow =>
	isTypedRecord(value, {
		eventId: isSafeInteger,
		eventPoints: isSafeInteger,
		eventRank: isNullableSafeInteger,
		overallPoints: isSafeInteger,
		overallRank: isSafeInteger,
		eventTransfers: isSafeInteger,
		eventTransfersCost: isSafeInteger,
		eventNetPoints: isSafeInteger,
		eventBenchPoints: isSafeInteger,
		eventChip: isChip,
		eventCaptainPoints: isSafeInteger,
		captainWebName: isNullableString,
		captainTeamShortName: isNullableString,
		teamValue: isNullableSafeInteger,
		bank: isNullableSafeInteger,
	});

const isPastSeasonCache = (value: unknown): value is MyFplPastSeason =>
	isTypedRecord(value, {
		season: (candidate) => typeof candidate === "string",
		totalPoints: isSafeInteger,
		overallRank: isSafeInteger,
	});

const isTeamPickCache = (value: unknown): value is MyFplTeamPick =>
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

const isTeamGameweekResultCache = (value: unknown): value is MyFplTeamGameweekResult =>
	isTypedRecord(value, {
		eventId: isSafeInteger,
		eventPoints: isSafeInteger,
		overallPoints: isSafeInteger,
		overallRank: isSafeInteger,
		eventTransfers: isSafeInteger,
		eventTransfersCost: isSafeInteger,
		eventNetPoints: isSafeInteger,
		eventBenchPoints: isSafeInteger,
		eventChip: isChip,
		eventCaptainPoints: isSafeInteger,
		playedCaptainWebName: isNullableString,
		teamValue: isNullableSafeInteger,
		bank: isNullableSafeInteger,
		picks: (candidate) => Array.isArray(candidate) && candidate.every(isTeamPickCache),
	});

const isTeamGameweekCache = (value: unknown): value is MyFplTeamGameweek =>
	isTypedRecord(value, {
		state: isReviewState,
		context: isReviewContext,
		eventId: isSafeInteger,
		entry: (candidate) => candidate === null || isEntryIdentityCache(candidate),
		result: (candidate) => candidate === null || isTeamGameweekResultCache(candidate),
		snapshotMeta: (candidate) => candidate === null || isSnapshotMeta(candidate),
	});

const isTeamDeskCache = (value: unknown): value is MyFplTeamDesk =>
	isTypedRecord(value, {
		state: isReviewState,
		context: isReviewContext,
		entry: (candidate) => candidate === null || isEntryIdentityCache(candidate),
		history: (candidate) => Array.isArray(candidate) && candidate.every(isTeamHistoryRowCache),
		pastSeasons: (candidate) => Array.isArray(candidate) && candidate.every(isPastSeasonCache),
		pastSeasonsState: isReviewState,
		selectedEventId: isNullableSafeInteger,
		gameweek: (candidate) => candidate === null || isTeamGameweekCache(candidate),
		snapshotMeta: (candidate) => candidate === null || isSnapshotMeta(candidate),
	});

const isTransferMoveCache = (value: unknown): value is MyFplTransferMove =>
	isTypedRecord(value, {
		eventId: isSafeInteger,
		elementInWebName: (candidate) => typeof candidate === "string",
		elementInTypeName: (candidate) => typeof candidate === "string",
		elementInTeamShortName: (candidate) => typeof candidate === "string",
		elementInCost: isSafeInteger,
		elementOutWebName: (candidate) => typeof candidate === "string",
		elementOutTypeName: (candidate) => typeof candidate === "string",
		elementOutTeamShortName: (candidate) => typeof candidate === "string",
		elementOutCost: isSafeInteger,
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

const readCache = async <T>(
	context: GraphQLContext,
	key: string,
	validate: (value: unknown) => value is T
): Promise<T | undefined> => {
	let raw: string | null;
	try {
		raw = await context.redis.get(key);
	} catch (error) {
		context.logger.warn({ err: error, key }, "Failed to read My FPL cache");
		return undefined;
	}
	if (raw === null) return undefined;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (validate(parsed)) return parsed;
	} catch (error) {
		context.logger.warn({ err: error, key }, "Malformed My FPL cache");
	}
	try {
		await context.redis.del(key);
	} catch (error) {
		context.logger.warn({ err: error, key }, "Failed to evict My FPL cache");
	}
	return undefined;
};

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

const snapshotFreshness = (
	snapshotDate: string,
	kind: MyFplSnapshotKind,
	now = new Date()
): MyFplSnapshotFreshness => {
	// FINAL is immutable by normal automation. It never becomes stale merely
	// because the calendar moved on; only a still-provisional event participates
	// in the next daily obligation window.
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
	const minute = currentUtc8Minutes(now);
	if (minute < 10 * 60 + 45) return "CURRENT";
	return kind === "PROVISIONAL" && minute >= 10 * 60 + 45 && minute < 13 * 60 + 45
		? "GENERATING"
		: "STALE";
};

const SNAPSHOT_PUBLICATION_UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SNAPSHOT_ALGORITHM_VERSION = "fpl-projected-autosubs-v1";

const isValidSnapshotPublicationRow = (row: DbSnapshotPublicationRow): boolean => {
	const sourceCheckedAt = isoString(row.source_checked_at);
	const sourceMinCheckedAt = isoString(row.source_min_checked_at);
	const sourceMaxCheckedAt = isoString(row.source_max_checked_at);
	if (
		!Number.isSafeInteger(row.expected_entry_count) ||
		row.expected_entry_count < 0 ||
		!Number.isSafeInteger(row.ready_entry_count) ||
		!Number.isSafeInteger(row.empty_entry_count) ||
		row.ready_entry_count < 0 ||
		row.empty_entry_count < 0 ||
		row.ready_entry_count + row.empty_entry_count !== row.expected_entry_count ||
		!Number.isSafeInteger(row.expected_tournament_count) ||
		row.expected_tournament_count < 0 ||
		!Number.isSafeInteger(row.ready_tournament_count) ||
		row.ready_tournament_count !== row.expected_tournament_count ||
		!/^[0-9a-f]{64}$/.test(row.content_sha256) ||
		!sourceCheckedAt ||
		!sourceMinCheckedAt ||
		!sourceMaxCheckedAt ||
		Date.parse(sourceCheckedAt) !== Date.parse(sourceMinCheckedAt) ||
		Date.parse(sourceMinCheckedAt) > Date.parse(sourceMaxCheckedAt)
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
	freshness: snapshotFreshness(snapshotDateKey(row.snapshot_date), row.kind),
	scoreSource: row.score_source!,
	livePublicationId: row.live_publication_id,
	liveRevision: row.live_revision,
	algorithmVersion: row.algorithm_version,
	sourceMinCheckedAt: isoString(row.source_min_checked_at)!,
	sourceMaxCheckedAt: isoString(row.source_max_checked_at)!,
	expectedEntryCount: row.expected_entry_count,
	readyEntryCount: row.ready_entry_count,
	emptyEntryCount: row.empty_entry_count,
	expectedTournamentCount: row.expected_tournament_count,
	readyTournamentCount: row.ready_tournament_count,
	contentSha256: row.content_sha256,
});

const isSnapshotPublicationCache = (value: unknown): value is MyFplSnapshotPublication => {
	if (!isRecord(value) || !isSnapshotMeta(value)) return false;
	const candidate = value as MyFplSnapshotPublication;
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
		isSafeInteger(candidate.readyEntryCount) &&
		candidate.readyEntryCount >= 0 &&
		isSafeInteger(candidate.emptyEntryCount) &&
		candidate.emptyEntryCount >= 0 &&
		candidate.readyEntryCount + candidate.emptyEntryCount === candidate.expectedEntryCount &&
		isSafeInteger(candidate.expectedTournamentCount) &&
		candidate.expectedTournamentCount >= 0 &&
		isSafeInteger(candidate.readyTournamentCount) &&
		candidate.readyTournamentCount === candidate.expectedTournamentCount &&
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
		if (!isValidSnapshotPublicationRow(row)) continue;
		publications.set(row.event_id, publicationFromRow(row));
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
	if (row && isValidSnapshotPublicationRow(row)) return publicationFromRow(row);
	return null;
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
	if (row && isValidSnapshotPublicationRow(row)) return publicationFromRow(row);
	return null;
};

type SnapshotEntryPayload = {
	entry: MyFplEntryIdentity;
	history: MyFplTeamHistoryRow[];
	pastSeasons: MyFplPastSeason[];
	gameweek: { state: MyFplReviewState; eventId: number; result: MyFplTeamGameweekResult | null };
	transfers: MyFplTransferMove[];
};

export const parseSnapshotEntryPayload = (value: unknown): SnapshotEntryPayload | null => {
	if (!isRecord(value) || !isEntryIdentityCache(value.entry)) return null;
	if (!Array.isArray(value.history) || !value.history.every(isTeamHistoryRowCache)) return null;
	if (!Array.isArray(value.pastSeasons) || !value.pastSeasons.every(isPastSeasonCache)) return null;
	if (!isRecord(value.gameweek)) return null;
	const gameweekState = value.gameweek.state;
	const gameweekEventId = asInteger(value.gameweek.eventId);
	if (
		!isReviewState(gameweekState) ||
		gameweekEventId === null ||
		(value.gameweek.result !== null && !isTeamGameweekResultCache(value.gameweek.result))
	) {
		return null;
	}
	if (!Array.isArray(value.transfers)) return null;
	const transfers = value.transfers.filter((candidate): candidate is MyFplTransferMove =>
		isTransferMoveCache(candidate)
	);
	if (transfers.length !== value.transfers.length) return null;
	return {
		entry: value.entry,
		history: value.history,
		pastSeasons: value.pastSeasons,
		gameweek: {
			state: gameweekState,
			eventId: gameweekEventId,
			result: value.gameweek.result as MyFplTeamGameweekResult | null,
		},
		transfers,
	};
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

const parseLoadedSnapshotEntryCache = (value: unknown): LoadedSnapshotEntry | null => {
	if (!isRecord(value) || !isSnapshotPublicationCache(value.publication)) return null;
	const payload = parseSnapshotEntryPayload(value.payload);
	if (!payload || typeof value.isEmpty !== "boolean") return null;
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
	const cached = await readCache(context, cacheKey, (value): value is LoadedSnapshotEntry => {
		const parsed = parseLoadedSnapshotEntryCache(value);
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
	if (!row || row.picks_count < 0 || row.picks_count > 15) return null;
	const payload = parseSnapshotEntryPayload(row.payload);
	if (!payload) return null;
	if (payload.entry.id !== entryId) return null;
	const historyEventIds = payload.history.map((historyRow) => historyRow.eventId);
	const uniqueHistoryEventIds = new Set(historyEventIds);
	const expectedHistoryEventIds = [...loadedContext.settledEventIds].filter(
		(settledEventId) =>
			settledEventId <= eventId &&
			(payload.entry.startedEvent === null ||
				payload.entry.startedEvent === undefined ||
				settledEventId >= payload.entry.startedEvent)
	);
	if (
		uniqueHistoryEventIds.size !== historyEventIds.length ||
		historyEventIds.some((historyEventId) => historyEventId < 1 || historyEventId > eventId) ||
		(!row.is_empty &&
			expectedHistoryEventIds.some((settledEventId) => !uniqueHistoryEventIds.has(settledEventId)))
	) {
		return null;
	}
	const pickCount = payload.gameweek.result?.picks.length ?? 0;
	if (
		payload.gameweek.eventId !== eventId ||
		row.picks_count !== pickCount ||
		row.is_empty !== (payload.gameweek.state === "EMPTY") ||
		(row.is_empty && pickCount !== 0) ||
		(!row.is_empty && (payload.gameweek.state !== "READY" || pickCount !== 15))
	)
		return null;
	if (
		!Number.isSafeInteger(row.entry_row_count) ||
		row.entry_row_count !== publication.expectedEntryCount ||
		!Number.isSafeInteger(row.aggregate_row_count) ||
		row.aggregate_row_count !== publication.expectedTournamentCount
	) {
		return null;
	}
	const loaded = {
		publication,
		payload: await applyCurrentEntryNameToSnapshot(context, payload),
		isEmpty: row.is_empty,
	};
	await writeQueryCache(
		context,
		cacheKey,
		JSON.stringify(loaded),
		QUERY_CACHE_TTL_SECONDS.REPORTING
	);
	return loaded;
};

const loadTeamGameweekPrepared = async (
	context: GraphQLContext,
	loadedContext: LoadedReviewContext,
	entryId: number,
	eventId: number,
	snapshotRevision?: string | null
): Promise<MyFplTeamGameweek> => {
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
			snapshotMeta: null,
		};
	}
	const snapshotEntry = snapshot.payload.entry;
	const snapshotGameweek = snapshot.payload.gameweek;
	const result = snapshotGameweek.result;
	const base = {
		context: loadedContext.value,
		eventId,
		entry: snapshotEntry,
		snapshotMeta: snapshot.publication,
	};
	if (snapshot.isEmpty || snapshotGameweek.state === "EMPTY") {
		return { ...base, state: "EMPTY", result: null };
	}
	if (!result || result.eventId !== eventId || result.picks.length !== 15) {
		return { ...base, state: "PENDING", result: null };
	}
	const cacheKey = gqlCacheKey(
		context,
		`my-fpl:${PROJECTION_VERSION}:team-gameweek:${entryId}:${eventId}:rev:${snapshot.publication.revision}`
	);
	const cached = await readCache(
		context,
		cacheKey,
		(value): value is MyFplTeamGameweek => isTeamGameweekCache(value) && value.eventId === eventId
	);
	if (cached) {
		return {
			...cached,
			entry: applyCurrentEntryName(cached.entry, snapshotEntry.entryName),
			snapshotMeta: snapshot.publication,
		};
	}
	const payload: MyFplTeamGameweek = {
		...base,
		state: "READY",
		result: {
			...result,
		},
	};
	await writeQueryCache(
		context,
		cacheKey,
		JSON.stringify(payload),
		QUERY_CACHE_TTL_SECONDS.REPORTING
	);
	return payload;
};

const loadTeamDesk = async (
	context: GraphQLContext,
	eventId?: number | null,
	snapshotRevision?: string | null
): Promise<MyFplTeamDesk> => {
	if (eventId !== undefined && eventId !== null) validateEventId(eventId);
	const entryId = requireViewerEntryId(context);
	await dependenciesFor(context).getCoreEventSnapshot(context);
	const loadedContext = await loadReviewContext(context);
	const pinnedPublication = snapshotRevision?.trim()
		? await loadSnapshotPublicationByRevision(context, loadedContext, snapshotRevision)
		: null;
	const selectedEventId =
		eventId ?? pinnedPublication?.eventId ?? defaultReviewEventId(loadedContext);
	if (selectedEventId === null) {
		return {
			state: "PRESEASON",
			context: loadedContext.value,
			entry: null,
			history: [],
			pastSeasons: [],
			pastSeasonsState: "PENDING",
			selectedEventId,
			gameweek: null,
			snapshotMeta: null,
		};
	}
	const snapshot = await loadSnapshotEntry(
		context,
		loadedContext,
		entryId,
		selectedEventId,
		snapshotRevision
	);
	if (!snapshot) {
		return {
			state: "PENDING",
			context: loadedContext.value,
			entry: null,
			history: [],
			pastSeasons: [],
			pastSeasonsState: "PENDING",
			selectedEventId,
			gameweek: null,
			snapshotMeta: null,
		};
	}
	const cacheKey = gqlCacheKey(
		context,
		`my-fpl:${PROJECTION_VERSION}:team-desk:${entryId}:${eventId ?? "season"}:rev:${snapshot.publication.revision}`
	);
	const cached = await readCache(context, cacheKey, isTeamDeskCache);
	if (cached) {
		const currentEntryName = snapshot.payload.entry.entryName;
		return {
			...cached,
			entry: applyCurrentEntryName(cached.entry, currentEntryName),
			snapshotMeta: snapshot.publication,
			gameweek: cached.gameweek
				? {
						...cached.gameweek,
						entry: applyCurrentEntryName(cached.gameweek.entry, currentEntryName),
						snapshotMeta: snapshot.publication,
					}
				: null,
		};
	}
	const entry = snapshot.payload.entry;
	const history = snapshot.payload.history;
	const pastSeasons = snapshot.payload.pastSeasons;
	const snapshotGameweek = snapshot.payload.gameweek;
	const gameweek: MyFplTeamGameweek = {
		context: loadedContext.value,
		eventId: selectedEventId,
		entry,
		state: snapshotGameweek.state,
		result: snapshotGameweek.result,
		snapshotMeta: snapshot.publication,
	};
	const pastSeasonsState: MyFplReviewState =
		typeof entry.pastSeasonsCheckedAt === "string" &&
		Number.isFinite(Date.parse(entry.pastSeasonsCheckedAt)) &&
		typeof entry.pastSeasonsCount === "number" &&
		Number.isSafeInteger(entry.pastSeasonsCount) &&
		entry.pastSeasonsCount >= 0 &&
		entry.pastSeasonsCount === pastSeasons.length
			? "READY"
			: "PENDING";

	const payload: MyFplTeamDesk = {
		state: gameweek.state,
		context: loadedContext.value,
		entry,
		history,
		pastSeasons,
		pastSeasonsState,
		selectedEventId,
		gameweek,
		snapshotMeta: snapshot.publication,
	};
	const cacheState: MyFplReviewState =
		gameweek.state === "PENDING" || pastSeasonsState === "PENDING" ? "PENDING" : gameweek.state;
	if (cacheableState(gameweek.state)) {
		await writeQueryCache(context, cacheKey, JSON.stringify(payload), stateTtl(cacheState));
	}
	return payload;
};

const loadTeamGameweek = async (
	context: GraphQLContext,
	eventId: number,
	snapshotRevision?: string | null
): Promise<MyFplTeamGameweek> => {
	validateEventId(eventId);
	const entryId = requireViewerEntryId(context);
	const loadedContext = await loadReviewContext(context);
	return loadTeamGameweekPrepared(context, loadedContext, entryId, eventId, snapshotRevision);
};

const loadTeamTransfers = async (
	context: GraphQLContext,
	snapshotRevision?: string | null
): Promise<MyFplTeamTransfers> => {
	const entryId = requireViewerEntryId(context);
	const loadedContext = await loadReviewContext(context);
	const pinnedPublication = snapshotRevision?.trim()
		? await loadSnapshotPublicationByRevision(context, loadedContext, snapshotRevision)
		: null;
	const selectedEventId = pinnedPublication?.eventId ?? defaultReviewEventId(loadedContext);
	if (selectedEventId === null) {
		return { state: "PRESEASON", context: loadedContext.value, gameweeks: [], snapshotMeta: null };
	}
	const snapshot = await loadSnapshotEntry(
		context,
		loadedContext,
		entryId,
		selectedEventId,
		snapshotRevision
	);
	if (!snapshot) {
		return { state: "PENDING", context: loadedContext.value, gameweeks: [], snapshotMeta: null };
	}
	if (snapshot.isEmpty) {
		return {
			state: "EMPTY",
			context: loadedContext.value,
			gameweeks: [],
			snapshotMeta: snapshot.publication,
		};
	}
	const historyByEvent = new Map(snapshot.payload.history.map((row) => [row.eventId, row]));
	const transferCounts = new Map<number, number>();
	for (const move of snapshot.payload.transfers) {
		transferCounts.set(move.eventId, (transferCounts.get(move.eventId) ?? 0) + 1);
	}
	if (
		snapshot.payload.history.some(
			(row) =>
				row.eventTransfers < 0 || (transferCounts.get(row.eventId) ?? 0) !== row.eventTransfers
		) ||
		snapshot.payload.transfers.some((move) => !historyByEvent.has(move.eventId))
	) {
		return {
			state: "PENDING",
			context: loadedContext.value,
			gameweeks: [],
			snapshotMeta: snapshot.publication,
		};
	}
	const grouped = new Map<number, MyFplTransferGameweek>();
	for (const move of snapshot.payload.transfers) {
		const existing = grouped.get(move.eventId) ?? {
			eventId: move.eventId,
			eventTransfers: historyByEvent.get(move.eventId)?.eventTransfers ?? 0,
			eventTransfersCost: historyByEvent.get(move.eventId)?.eventTransfersCost ?? 0,
			transfers: [],
		};
		existing.transfers.push(move);
		grouped.set(move.eventId, existing);
	}
	return {
		state: grouped.size > 0 ? "READY" : "EMPTY",
		context: loadedContext.value,
		gameweeks: [...grouped.values()].sort((left, right) => left.eventId - right.eventId),
		snapshotMeta: snapshot.publication,
	};
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
	const cached = await readCache(
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
	const cached = await readCache(
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
	const cached = await readCache(
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
	loadTeamDesk: typeof loadTeamDesk;
	loadTeamGameweek: typeof loadTeamGameweek;
	loadTeamTransfers: typeof loadTeamTransfers;
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
		loadTeamDesk: (context, eventId, snapshotRevision) =>
			withDependencies(context, dependencies, () =>
				loadTeamDesk(context, eventId, snapshotRevision)
			),
		loadTeamGameweek: (context, eventId, snapshotRevision) =>
			withDependencies(context, dependencies, () =>
				loadTeamGameweek(context, eventId, snapshotRevision)
			),
		loadTeamTransfers: (context, snapshotRevision) =>
			withDependencies(context, dependencies, () => loadTeamTransfers(context, snapshotRevision)),
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
	snapshotFreshness,
	compareSnapshotRevisions,
};
