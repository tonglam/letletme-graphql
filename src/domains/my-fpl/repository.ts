import { GraphQLError } from "graphql";
import type { QueryResultRow } from "pg";
import type { GraphQLContext } from "../../graphql/context";
import { gqlCacheKey } from "../../infra/cache-key";
import { getCoreEventSnapshot } from "../../infra/data-snapshot";
import { QUERY_CACHE_TTL_SECONDS, writeQueryCache } from "../../infra/query-cache";
import { COMPETITION_AGGREGATE_SQL } from "./competition-aggregate-sql";
import {
	GroupMode,
	TournamentSetupStatus,
	tournamentsRepository,
	type TournamentInfo,
} from "../tournaments/repository";

export type MyFplReviewState = "PRESEASON" | "PENDING" | "READY" | "EMPTY" | "UNAVAILABLE";

export type MyFplReviewContext = {
	season: string;
	coreRevision: string;
	currentEventId: number | null;
	nextEventId: number | null;
	latestFinalizedEventId: number | null;
};

/** Internal dependency seam used by hermetic My FPL behavior tests. */
export type MyFplRepositoryDependencies = {
	getCoreEventSnapshot: typeof getCoreEventSnapshot;
	tournamentsRepository: typeof tournamentsRepository;
};

const defaultDependencies: MyFplRepositoryDependencies = {
	getCoreEventSnapshot,
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

type LoadedReviewContext = {
	value: MyFplReviewContext;
	finalizedEventIds: Set<number>;
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

type DbEntryRow = QueryResultRow & {
	entry_id: number;
	entry_name: string;
	player_name: string;
	region: string | null;
	started_event: number | null;
	overall_points: number | null;
	overall_rank: number | null;
	bank: number | null;
	team_value: number | null;
	total_transfers: number | null;
	transfers_synced_through_event_id: number | null;
	past_seasons_checked_at: Date | string | null;
	past_seasons_count: number | null;
};

type MyFplEntryIdentityRecord = MyFplEntryIdentity & {
	pastSeasonsCheckedAt: string | null;
	pastSeasonsCount: number | null;
};

type DbHistoryRow = QueryResultRow & {
	event_id: number;
	event_points: number;
	event_rank: number | null;
	overall_points: number;
	overall_rank: number;
	event_transfers: number;
	event_transfers_cost: number;
	event_net_points: number;
	event_bench_points: number | null;
	event_chip: string | null;
	captain_points: number | null;
	captain_web_name: string | null;
	captain_team_short_name: string | null;
	team_value: number | null;
	bank: number | null;
};

type DbPastSeasonRow = QueryResultRow & {
	season: string;
	total_points: number;
	overall_rank: number;
};

type DbGameweekRow = QueryResultRow & {
	event_id: number;
	event_points: number;
	overall_points: number;
	overall_rank: number;
	event_transfers: number;
	event_transfers_cost: number;
	event_net_points: number;
	event_bench_points: number | null;
	event_chip: string | null;
	captain_points: number | null;
	played_captain_web_name: string | null;
	team_value: number | null;
	bank: number | null;
	element_id: number | null;
	position: number | null;
	web_name: string | null;
	team_short_name: string | null;
	team_name: string | null;
	element_type: number | null;
	is_captain: boolean | null;
	is_vice_captain: boolean | null;
	multiplier: number | null;
	total_points: number | null;
	minutes: number | null;
	goals_scored: number | null;
	assists: number | null;
	clean_sheets: number | null;
	goals_conceded: number | null;
	yellow_cards: number | null;
	red_cards: number | null;
	saves: number | null;
	bonus: number | null;
	bps: number | null;
	expected_goals: string | number | null;
	expected_assists: string | number | null;
	expected_goal_involvements: string | number | null;
	expected_goals_conceded: string | number | null;
	against_short_name: string | null;
	was_home: string | null;
	score: string | null;
	fixture_count: number | string | null;
	automatic_substitutions: unknown;
};

type DbTransferRow = QueryResultRow & {
	event_id: number;
	event_transfers: number;
	event_transfers_cost: number;
	element_in_web_name: string | null;
	element_in_type: number | null;
	element_in_team_short_name: string | null;
	element_in_cost: number | null;
	element_out_web_name: string | null;
	element_out_type: number | null;
	element_out_team_short_name: string | null;
	element_out_cost: number | null;
	transfer_time: Date | string;
};

type DbBoardPayloadRow = QueryResultRow & { payload: unknown };

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

type DbSeasonPathRow = QueryResultRow & {
	event_id: number;
	tournament_rank: number | string | null;
	field_size: number;
	overall_points: number | null;
	leader_overall_points: number | null;
	average_overall_points: string | number | null;
	gap_to_leader: number | null;
	points_vs_average: string | number | null;
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

const PROJECTION_VERSION = "v7";
const NULLABLE_STATE_CACHE_TTL_SECONDS = 30;
// Keep OFFSET bounded for the fixed-cost board root. Page 100 is the maximum
// 10,000-row window at the maximum page size.
const MAX_COMPETITION_BOARD_PAGE = 100;

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

const requireVerifiedEntryId = (context: GraphQLContext): number => {
	const entryId = context.principal?.fplEntryId;
	if (!context.principal?.fplEntryVerifiedAt || !entryId || entryId <= 0) {
		throw new GraphQLError("A verified FPL binding is required", {
			extensions: { code: "FORBIDDEN" },
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
	[value.currentEventId, value.nextEventId, value.latestFinalizedEventId].every(
		(item) => item === null || isSafeInteger(item)
	);

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

const isTypedRecord = (
	value: unknown,
	fields: Record<string, (candidate: unknown) => boolean>
): value is Record<string, unknown> =>
	isRecord(value) &&
	Object.entries(fields).every(
		([key, predicate]) => Object.prototype.hasOwnProperty.call(value, key) && predicate(value[key])
	);

const isEntryIdentityCache = (value: unknown): value is MyFplEntryIdentity =>
	isTypedRecord(value, {
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
	});

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

const isTransferGameweekCache = (value: unknown): value is MyFplTransferGameweek =>
	isTypedRecord(value, {
		eventId: isSafeInteger,
		eventTransfers: isSafeInteger,
		eventTransfersCost: isSafeInteger,
		transfers: (candidate) => Array.isArray(candidate) && candidate.every(isTransferMoveCache),
	});

const isTeamTransfersCache = (value: unknown): value is MyFplTeamTransfers =>
	isTypedRecord(value, {
		state: isReviewState,
		context: isReviewContext,
		gameweeks: (candidate) => Array.isArray(candidate) && candidate.every(isTransferGameweekCache),
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
	});

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

const loadReviewContext = async (context: GraphQLContext): Promise<LoadedReviewContext> => {
	const snapshotPromise = dependenciesFor(context).getCoreEventSnapshot(context);
	const lifecyclePromise = context.database.query<DbEventLifecycleRow>(
		/* c8 ignore start -- SQL text is not executable application logic. */
		`SELECT event_id, finished, data_checked, live_snapshot_finalized_at
		 FROM fpl.events
		 WHERE season_id = $1
		 ORDER BY event_id`,
		/* c8 ignore stop */
		[context.currentSeason.seasonId]
	);
	const [snapshot, lifecycle] = await Promise.all([snapshotPromise, lifecyclePromise]);
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
	return {
		value: {
			season: snapshot.seasonCode,
			coreRevision: snapshot.revision,
			currentEventId,
			nextEventId,
			latestFinalizedEventId: eventIds[0] ?? null,
		},
		finalizedEventIds,
	};
};

const loadEntry = async (
	context: GraphQLContext,
	entryId: number
): Promise<MyFplEntryIdentityRecord | null> => {
	const result = await context.database.query<DbEntryRow>(
		`SELECT entry_id, entry_name, player_name, region, started_event,
				        overall_points, overall_rank, bank, team_value, total_transfers,
				        transfers_synced_through_event_id, past_seasons_checked_at,
				        past_seasons_count
		 FROM competition.entries
		 WHERE season_id = $1 AND entry_id = $2
		 LIMIT 1`,
		[context.currentSeason.seasonId, entryId]
	);
	const row = result.rows[0];
	return row
		? {
				id: row.entry_id,
				entryName: row.entry_name,
				playerName: row.player_name,
				region: row.region,
				startedEvent: row.started_event,
				overallPoints: row.overall_points,
				overallRank: row.overall_rank,
				bank: row.bank,
				teamValue: row.team_value,
				totalTransfers: row.total_transfers,
				transfersSyncedThroughEventId: row.transfers_synced_through_event_id,
				pastSeasonsCheckedAt: isoString(row.past_seasons_checked_at),
				pastSeasonsCount: row.past_seasons_count,
			}
		: null;
};

const loadTeamHistory = async (
	context: GraphQLContext,
	entryId: number
): Promise<MyFplTeamHistoryRow[]> => {
	const result = await context.database.query<DbHistoryRow>(
		`SELECT result.event_id, result.event_points, result.event_rank,
		        result.overall_points, result.overall_rank, result.event_transfers,
		        result.event_transfers_cost, result.event_net_points,
		        result.event_bench_points, result.event_chip::text,
		        result.captain_points, player.web_name AS captain_web_name,
		        team.short_name AS captain_team_short_name,
		        result.team_value, result.bank
		 FROM competition.entry_event_results result
		 JOIN fpl.events event
		   ON event.season_id = result.season_id
		  AND event.event_id = result.event_id
		  AND event.finished
		  AND event.data_checked
		  AND event.live_snapshot_finalized_at IS NOT NULL
		 LEFT JOIN fpl.players player
		   ON player.season_id = result.season_id
		  AND player.element_id = result.played_captain_element_id
		 LEFT JOIN LATERAL (
		   SELECT fixture_stats.team_id
		   FROM fpl.player_fixture_stats fixture_stats
		   WHERE fixture_stats.season_id = result.season_id
		     AND fixture_stats.event_id = result.event_id
		     AND fixture_stats.element_id = result.played_captain_element_id
		   ORDER BY fixture_stats.fixture_id
		   LIMIT 1
		 ) captain_historical_team ON TRUE
		 LEFT JOIN fpl.teams team
		   ON team.season_id = player.season_id
		  AND team.team_id = COALESCE(captain_historical_team.team_id, player.team_id)
		 WHERE result.season_id = $1
		   AND result.entry_id = $2
		   AND result.rich_synced_at IS NOT NULL
		 ORDER BY result.event_id`,
		[context.currentSeason.seasonId, entryId]
	);
	return result.rows.map((row) => ({
		eventId: row.event_id,
		eventPoints: row.event_points,
		eventRank: row.event_rank,
		overallPoints: row.overall_points,
		overallRank: row.overall_rank,
		eventTransfers: row.event_transfers,
		eventTransfersCost: row.event_transfers_cost,
		eventNetPoints: row.event_net_points,
		eventBenchPoints: row.event_bench_points ?? 0,
		eventChip: normalizeChip(row.event_chip),
		eventCaptainPoints: row.captain_points ?? 0,
		captainWebName: row.captain_web_name,
		captainTeamShortName: row.captain_team_short_name,
		teamValue: row.team_value,
		bank: row.bank,
	}));
};

const loadPastSeasons = async (
	context: GraphQLContext,
	entryId: number
): Promise<MyFplPastSeason[]> => {
	const result = await context.database.query<DbPastSeasonRow>(
		`SELECT source_season_label AS season, total_points, overall_rank
		 FROM competition.entry_past_seasons
		 WHERE entry_season_id = $1
		   AND entry_id = $2
		 ORDER BY source_season_id`,
		[context.currentSeason.seasonId, entryId]
	);
	return result.rows.map((row) => ({
		season: row.season,
		totalPoints: row.total_points,
		overallRank: row.overall_rank,
	}));
};

const officialAutoSubElements = (value: unknown): Set<number> => {
	if (!Array.isArray(value)) return new Set();
	const elements = new Set<number>();
	for (const candidate of value) {
		if (!isRecord(candidate)) continue;
		const elementIn = asInteger(candidate.element_in ?? candidate.elementIn);
		if (elementIn !== null && elementIn > 0) elements.add(elementIn);
	}
	return elements;
};

const mapGameweekPick = (
	row: DbGameweekRow,
	autoSubElements: ReadonlySet<number>
): MyFplTeamPick | null => {
	if (
		row.element_id === null ||
		row.position === null ||
		row.web_name === null ||
		row.team_short_name === null ||
		row.team_name === null
	) {
		return null;
	}
	const minutes = row.minutes ?? 0;
	const yellowCards = row.yellow_cards ?? 0;
	const redCards = row.red_cards ?? 0;
	const fixtureCount = asInteger(row.fixture_count) ?? 0;
	return {
		element: row.element_id,
		position: row.position,
		webName: row.web_name,
		teamShortName: row.team_short_name,
		teamName: row.team_name,
		elementTypeName: positionName(row.element_type),
		isCaptain: row.is_captain ?? false,
		isViceCaptain: row.is_vice_captain ?? false,
		multiplier: row.multiplier ?? 0,
		totalPoints: row.total_points ?? 0,
		minutes,
		goalsScored: row.goals_scored ?? 0,
		assists: row.assists ?? 0,
		cleanSheets: row.clean_sheets ?? 0,
		goalsConceded: row.goals_conceded ?? 0,
		yellowCards,
		redCards,
		saves: row.saves ?? 0,
		bonus: row.bonus ?? 0,
		bps: row.bps ?? 0,
		againstShortName: row.against_short_name ?? "",
		wasHome: row.was_home ?? "",
		score: row.score ?? "",
		fixtureCount,
		bgw: fixtureCount === 0,
		dgw: fixtureCount > 1,
		isPlayed: minutes > 0 || yellowCards > 0 || redCards > 0,
		autoSub: autoSubElements.has(row.element_id),
		expectedGoals: asFiniteNumber(row.expected_goals),
		expectedAssists: asFiniteNumber(row.expected_assists),
		expectedGoalInvolvements: asFiniteNumber(row.expected_goal_involvements),
		expectedGoalsConceded: asFiniteNumber(row.expected_goals_conceded),
	};
};

const loadTeamGameweekRows = async (
	context: GraphQLContext,
	entryId: number,
	eventId: number
): Promise<DbGameweekRow[]> => {
	const result = await context.database.query<DbGameweekRow>(
		`SELECT result.event_id, result.event_points, result.overall_points,
		        result.overall_rank, result.event_transfers, result.event_transfers_cost,
		        result.event_net_points, result.event_bench_points,
				result.event_chip::text, result.captain_points,
				captain.web_name AS played_captain_web_name,
				result.team_value, result.bank,
				result.automatic_substitutions,
		        pick.element_id, pick.position, player.web_name, team.short_name AS team_short_name,
		        team.name AS team_name, player.element_type, pick.is_captain,
		        pick.is_vice_captain, pick.multiplier, stats.total_points, stats.minutes,
		        stats.goals_scored, stats.assists, stats.clean_sheets, stats.goals_conceded,
		        stats.yellow_cards, stats.red_cards, stats.saves, stats.bonus, stats.bps,
		        stats.expected_goals, stats.expected_assists,
		        stats.expected_goal_involvements, stats.expected_goals_conceded,
		        fixture.against_short_name, fixture.was_home, fixture.score, fixture.fixture_count
		 FROM competition.entry_event_results result
		 LEFT JOIN fpl.players captain
		   ON captain.season_id = result.season_id
		  AND captain.element_id = result.played_captain_element_id
		 LEFT JOIN competition.entry_event_picks pick
		   ON pick.season_id = result.season_id
		  AND pick.entry_id = result.entry_id
		  AND pick.event_id = result.event_id
		 LEFT JOIN fpl.players player
		   ON player.season_id = pick.season_id
		  AND player.element_id = pick.element_id
		 LEFT JOIN LATERAL (
		   SELECT fixture_stats.team_id
		   FROM fpl.player_fixture_stats fixture_stats
		   WHERE fixture_stats.season_id = pick.season_id
		     AND fixture_stats.event_id = pick.event_id
		     AND fixture_stats.element_id = pick.element_id
		   ORDER BY fixture_stats.fixture_id
		   LIMIT 1
		 ) historical_team ON TRUE
		 LEFT JOIN fpl.teams team
		   ON team.season_id = player.season_id
		  AND team.team_id = COALESCE(historical_team.team_id, player.team_id)
		 LEFT JOIN fpl.player_gameweek_stats stats
		   ON stats.season_id = pick.season_id
		  AND stats.event_id = pick.event_id
		  AND stats.element_id = pick.element_id
		 LEFT JOIN LATERAL (
			SELECT
			  count(match.fixture_id)::integer AS fixture_count,
			  string_agg(opponent.short_name, ' / ' ORDER BY match.kickoff_time NULLS LAST, match.fixture_id) AS against_short_name,
		     string_agg(CASE WHEN match.team_h_id = COALESCE(historical_team.team_id, player.team_id) THEN 'H' ELSE 'A' END, ' / ' ORDER BY match.kickoff_time NULLS LAST, match.fixture_id) AS was_home,
		     string_agg(
		       CASE
		         WHEN match.team_h_score IS NULL OR match.team_a_score IS NULL THEN ''
		         WHEN match.team_h_id = COALESCE(historical_team.team_id, player.team_id) THEN match.team_h_score || '-' || match.team_a_score
		         ELSE match.team_a_score || '-' || match.team_h_score
		       END,
		       ' / ' ORDER BY match.kickoff_time NULLS LAST, match.fixture_id
		     ) AS score
		   FROM fpl.fixtures match
			JOIN fpl.teams opponent
			  ON opponent.season_id = match.season_id
			 AND opponent.team_id = CASE
			      WHEN match.team_h_id = COALESCE(historical_team.team_id, player.team_id) THEN match.team_a_id
			      ELSE match.team_h_id
			    END
		   WHERE match.season_id = result.season_id
		     AND match.event_id = result.event_id
		     AND COALESCE(historical_team.team_id, player.team_id) IN (match.team_h_id, match.team_a_id)
		 ) fixture ON TRUE
		 WHERE result.season_id = $1
		   AND result.entry_id = $2
		   AND result.event_id = $3
		   AND result.rich_synced_at IS NOT NULL
		 ORDER BY pick.position NULLS LAST`,
		[context.currentSeason.seasonId, entryId, eventId]
	);
	return result.rows;
};

const loadTeamGameweekPrepared = async (
	context: GraphQLContext,
	loadedContext: LoadedReviewContext,
	entryId: number,
	eventId: number,
	entry?: MyFplEntryIdentity | null
): Promise<MyFplTeamGameweek> => {
	validateEventId(eventId);
	const base = {
		context: loadedContext.value,
		eventId,
		entry: entry === undefined ? await loadEntry(context, entryId) : entry,
	};
	if (!loadedContext.finalizedEventIds.has(eventId)) {
		return { ...base, state: "PENDING", result: null };
	}
	if (!base.entry || base.entry.startedEvent === null || base.entry.startedEvent > eventId) {
		return { ...base, state: "EMPTY", result: null };
	}

	const cacheKey = gqlCacheKey(
		context,
		`my-fpl:${PROJECTION_VERSION}:team-gameweek:${entryId}:${eventId}`
	);
	const cached = await readCache(
		context,
		cacheKey,
		(value): value is MyFplTeamGameweek => isTeamGameweekCache(value) && value.eventId === eventId
	);
	if (cached) return cached;

	const rows = await loadTeamGameweekRows(context, entryId, eventId);
	if (rows.length === 0) {
		return { ...base, state: "PENDING", result: null };
	}
	const picks = rows
		.map((row) => mapGameweekPick(row, officialAutoSubElements(row.automatic_substitutions)))
		.filter((pick): pick is MyFplTeamPick => pick !== null);
	if (rows.length !== 15 || picks.length !== 15) {
		return { ...base, state: "PENDING", result: null };
	}
	const first = rows[0];
	const payload: MyFplTeamGameweek = {
		...base,
		state: "READY",
		result: {
			eventId,
			eventPoints: first.event_points,
			overallPoints: first.overall_points,
			overallRank: first.overall_rank,
			eventTransfers: first.event_transfers,
			eventTransfersCost: first.event_transfers_cost,
			eventNetPoints: first.event_net_points,
			eventBenchPoints: first.event_bench_points ?? 0,
			eventChip: normalizeChip(first.event_chip),
			eventCaptainPoints: first.captain_points ?? 0,
			playedCaptainWebName: first.played_captain_web_name,
			teamValue: first.team_value,
			bank: first.bank,
			picks,
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
	eventId?: number | null
): Promise<MyFplTeamDesk> => {
	if (eventId !== undefined && eventId !== null) validateEventId(eventId);
	const entryId = requireVerifiedEntryId(context);
	// Lightweight requests deliberately skip the full Core preload in the HTTP
	// layer. Pin the compact event snapshot before deriving a revision-scoped
	// cache key; loadReviewContext reuses this request-local promise on a miss.
	await dependenciesFor(context).getCoreEventSnapshot(context);
	const cacheKey = gqlCacheKey(
		context,
		`my-fpl:${PROJECTION_VERSION}:team-desk:${entryId}:${eventId ?? "season"}`
	);
	const cached = await readCache(context, cacheKey, isTeamDeskCache);
	if (cached) return cached;

	// All four projections are independent. On a miss, start them together so
	// event context does not serialize the durable entry reads.
	const [loadedContext, entry, history, pastSeasons] = await Promise.all([
		loadReviewContext(context),
		loadEntry(context, entryId),
		loadTeamHistory(context, entryId),
		loadPastSeasons(context, entryId),
	]);
	const gameweek =
		eventId === undefined || eventId === null
			? null
			: await loadTeamGameweekPrepared(context, loadedContext, entryId, eventId, entry);
	let state: MyFplReviewState;
	if (gameweek) state = gameweek.state;
	else if (!entry) state = "EMPTY";
	else if (loadedContext.value.latestFinalizedEventId === null) state = "PRESEASON";
	else if (
		entry.startedEvent === null ||
		entry.startedEvent > loadedContext.value.latestFinalizedEventId
	) {
		state = "EMPTY";
	} else {
		const historyEventIds = new Set(history.map((row) => row.eventId));
		const expectedHistoryEventIds = [...loadedContext.finalizedEventIds].filter(
			(finalizedEventId) => finalizedEventId >= entry.startedEvent!
		);
		const historyComplete =
			expectedHistoryEventIds.length > 0 &&
			expectedHistoryEventIds.every((finalizedEventId) => historyEventIds.has(finalizedEventId));
		state = historyComplete ? "READY" : "PENDING";
	}
	const pastSeasonsState: MyFplReviewState = !entry
		? "EMPTY"
		: entry.pastSeasonsCheckedAt !== null &&
			  entry.pastSeasonsCount !== null &&
			  entry.pastSeasonsCount === pastSeasons.length
			? "READY"
			: "PENDING";

	const payload: MyFplTeamDesk = {
		state,
		context: loadedContext.value,
		entry,
		history,
		pastSeasons,
		pastSeasonsState,
		selectedEventId: eventId ?? null,
		gameweek,
	};
	if (cacheableState(state)) {
		await writeQueryCache(context, cacheKey, JSON.stringify(payload), stateTtl(state));
	}
	return payload;
};

const loadTeamGameweek = async (
	context: GraphQLContext,
	eventId: number
): Promise<MyFplTeamGameweek> => {
	validateEventId(eventId);
	const entryId = requireVerifiedEntryId(context);
	const loadedContext = await loadReviewContext(context);
	return loadTeamGameweekPrepared(context, loadedContext, entryId, eventId);
};

const loadTeamTransfers = async (context: GraphQLContext): Promise<MyFplTeamTransfers> => {
	const entryId = requireVerifiedEntryId(context);
	const loadedContext = await loadReviewContext(context);
	if (loadedContext.value.latestFinalizedEventId === null) {
		return { state: "PRESEASON", context: loadedContext.value, gameweeks: [] };
	}
	const entry = await loadEntry(context, entryId);
	if (!entry) return { state: "EMPTY", context: loadedContext.value, gameweeks: [] };
	if (
		entry.startedEvent === null ||
		entry.startedEvent > loadedContext.value.latestFinalizedEventId
	) {
		return { state: "EMPTY", context: loadedContext.value, gameweeks: [] };
	}
	if (
		entry.transfersSyncedThroughEventId === null ||
		entry.transfersSyncedThroughEventId < loadedContext.value.latestFinalizedEventId
	) {
		return { state: "PENDING", context: loadedContext.value, gameweeks: [] };
	}
	const expectedTransferEventIds = [...loadedContext.finalizedEventIds].filter(
		(finalizedEventId) => finalizedEventId >= entry.startedEvent!
	);
	if (expectedTransferEventIds.length > 0) {
		const enrichment = await context.database.query<{ enriched_event_count: number | string }>(
			`SELECT count(DISTINCT event_id)::integer AS enriched_event_count
			 FROM competition.entry_event_results
			 WHERE season_id = $1
			   AND entry_id = $2
			   AND event_id = ANY($3::integer[])
			   AND rich_synced_at IS NOT NULL`,
			[context.currentSeason.seasonId, entryId, expectedTransferEventIds]
		);
		if (Number(enrichment.rows[0]?.enriched_event_count ?? 0) < expectedTransferEventIds.length) {
			return { state: "PENDING", context: loadedContext.value, gameweeks: [] };
		}
	}
	const cacheKey = gqlCacheKey(context, `my-fpl:${PROJECTION_VERSION}:team-transfers:${entryId}`);
	const cached = await readCache(context, cacheKey, isTeamTransfersCache);
	if (cached) return cached;

	const result = await context.database.query<DbTransferRow>(
		`SELECT transfer.event_id, result.event_transfers, result.event_transfers_cost,
		        player_in.web_name AS element_in_web_name,
		        player_in.element_type AS element_in_type,
		        team_in.short_name AS element_in_team_short_name,
		        transfer.element_in_cost,
		        player_out.web_name AS element_out_web_name,
		        player_out.element_type AS element_out_type,
		        team_out.short_name AS element_out_team_short_name,
		        transfer.element_out_cost, transfer.transfer_time
		 FROM competition.entry_event_transfers transfer
		 JOIN competition.entry_event_results result
		   ON result.season_id = transfer.season_id
		  AND result.entry_id = transfer.entry_id
		  AND result.event_id = transfer.event_id
		  AND result.rich_synced_at IS NOT NULL
		 JOIN fpl.events event
		   ON event.season_id = transfer.season_id
		  AND event.event_id = transfer.event_id
		  AND event.finished
		  AND event.data_checked
		  AND event.live_snapshot_finalized_at IS NOT NULL
		 LEFT JOIN fpl.players player_in
		   ON player_in.season_id = transfer.season_id
		  AND player_in.element_id = transfer.element_in_id
		 LEFT JOIN LATERAL (
		   SELECT fixture_stats.team_id
		   FROM fpl.player_fixture_stats fixture_stats
		   WHERE fixture_stats.season_id = transfer.season_id
		     AND fixture_stats.event_id = transfer.event_id
		     AND fixture_stats.element_id = transfer.element_in_id
		   ORDER BY fixture_stats.fixture_id
		   LIMIT 1
		 ) historical_team_in ON TRUE
		 LEFT JOIN fpl.teams team_in
		   ON team_in.season_id = player_in.season_id
		  AND team_in.team_id = COALESCE(historical_team_in.team_id, player_in.team_id)
		 LEFT JOIN fpl.players player_out
		   ON player_out.season_id = transfer.season_id
		  AND player_out.element_id = transfer.element_out_id
		 LEFT JOIN LATERAL (
		   SELECT fixture_stats.team_id
		   FROM fpl.player_fixture_stats fixture_stats
		   WHERE fixture_stats.season_id = transfer.season_id
		     AND fixture_stats.event_id = transfer.event_id
		     AND fixture_stats.element_id = transfer.element_out_id
		   ORDER BY fixture_stats.fixture_id
		   LIMIT 1
		 ) historical_team_out ON TRUE
		 LEFT JOIN fpl.teams team_out
		   ON team_out.season_id = player_out.season_id
		  AND team_out.team_id = COALESCE(historical_team_out.team_id, player_out.team_id)
		 WHERE transfer.season_id = $1 AND transfer.entry_id = $2
		 ORDER BY transfer.event_id, transfer.transfer_time, transfer.transfer_id`,
		[context.currentSeason.seasonId, entryId]
	);
	const grouped = new Map<number, MyFplTransferGameweek>();
	for (const row of result.rows) {
		const gameweek = grouped.get(row.event_id) ?? {
			eventId: row.event_id,
			eventTransfers: row.event_transfers,
			eventTransfersCost: row.event_transfers_cost,
			transfers: [],
		};
		gameweek.transfers.push({
			eventId: row.event_id,
			elementInWebName: row.element_in_web_name ?? "",
			elementInTypeName: positionName(row.element_in_type),
			elementInTeamShortName: row.element_in_team_short_name ?? "",
			elementInCost: row.element_in_cost ?? 0,
			elementOutWebName: row.element_out_web_name ?? "",
			elementOutTypeName: positionName(row.element_out_type),
			elementOutTeamShortName: row.element_out_team_short_name ?? "",
			elementOutCost: row.element_out_cost ?? 0,
			time: isoString(row.transfer_time) ?? new Date(0).toISOString(),
		});
		grouped.set(row.event_id, gameweek);
	}
	const gameweeks = [...grouped.values()].sort((left, right) => left.eventId - right.eventId);
	const payload: MyFplTeamTransfers = {
		state: gameweeks.length > 0 ? "READY" : "EMPTY",
		context: loadedContext.value,
		gameweeks,
	};
	await writeQueryCache(
		context,
		cacheKey,
		JSON.stringify(payload),
		QUERY_CACHE_TTL_SECONDS.REPORTING
	);
	return payload;
};

const assertTournamentMembership = async (
	context: GraphQLContext,
	tournamentId: number,
	entryId: number
): Promise<void> => {
	if (
		context.principal?.source === "website" &&
		context.principal.platformAdmin === true &&
		context.principal.fplEntryId === entryId &&
		Boolean(context.principal.fplEntryVerifiedAt)
	) {
		(context.authorizedTournamentMemberships ??= new Set()).add(tournamentId);
		return;
	}
	if (context.authorizedTournamentMemberships?.has(tournamentId)) return;
	const result = await context.database.query(
		`SELECT 1
		 FROM competition.tournament_entries
		 WHERE tournament_id = $1 AND season_id = $2 AND entry_id = $3
		 LIMIT 1`,
		[tournamentId, context.currentSeason.seasonId, entryId]
	);
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
	if (
		context.principal?.source === "website" &&
		context.principal.platformAdmin === true &&
		context.principal.fplEntryId === entryId &&
		Boolean(context.principal.fplEntryVerifiedAt)
	) {
		return tournaments;
	}
	const result = await context.database.query<DbTournamentMembershipRow>(
		`SELECT tournament_id
		 FROM competition.tournament_entries
		 WHERE season_id = $1
		   AND entry_id = $2
		 ORDER BY tournament_id`,
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

const parseBoardPayload = (
	value: unknown
): {
	fieldSize: number;
	totalRows: number;
	rows: MyFplCompetitionBoardRow[];
	viewerRow: MyFplCompetitionBoardRow | null;
} => {
	if (!isRecord(value)) throw new Error("Tournament board payload is malformed");
	const rows = Array.isArray(value.rows) ? value.rows : [];
	if (!rows.every(isRecord)) throw new Error("Tournament board rows are malformed");
	const viewer = value.viewerRow ?? value.viewer_row;
	return {
		fieldSize: asInteger(value.fieldSize ?? value.field_size) ?? 0,
		totalRows: asInteger(value.totalRows ?? value.total_rows) ?? 0,
		rows: (rows as DbBoardJsonRow[]).map(mapBoardJsonRow),
		viewerRow: isRecord(viewer) ? mapBoardJsonRow(viewer as DbBoardJsonRow) : null,
	};
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
	tournament?: TournamentInfo | null
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
	const empty = (state: MyFplReviewState): MyFplCompetitionBoardPage => ({
		state,
		eventId,
		page,
		pageSize,
		totalRows: 0,
		totalPages: 0,
		fieldSize: 0,
		rows: [],
		viewerRow: null,
	});
	if (!metadata) return empty("EMPTY");
	if (metadata.groupMode !== GroupMode.POINTS_RACES) return empty("UNAVAILABLE");
	if (!loadedContext.finalizedEventIds.has(eventId)) return empty("PENDING");
	if (
		metadata.setupStatus !== TournamentSetupStatus.READY ||
		!metadata.standingsReadyAt ||
		!metadata.insightsReadyAt
	) {
		return empty("PENDING");
	}

	const cacheKey = gqlCacheKey(
		context,
		`my-fpl:${PROJECTION_VERSION}:competition-board:${tournamentId}:${eventId}:${page}:${pageSize}:${normalizedSearch.toLocaleLowerCase("en-US")}:${entryId}`
	);
	const cached = await readCache(
		context,
		cacheKey,
		(value): value is MyFplCompetitionBoardPage =>
			isCompetitionBoardCache(value) && value.eventId === eventId
	);
	if (cached) return cached;

	const offset = (page - 1) * pageSize;
	const result = await context.database.query<DbBoardPayloadRow>(
		`WITH board AS MATERIALIZED (
		   SELECT summary.event_id,
		          group_result.group_id,
		          summary.entry_id,
		          entry.entry_name,
		          entry.player_name,
		          COALESCE(group_result.event_group_rank, summary.tournament_event_rank)::integer AS rank,
		          COALESCE(previous_group.event_group_rank, previous_summary.tournament_event_rank)::integer AS previous_rank,
		          CASE
		            WHEN summary.overall_points IS NULL THEN NULL
		            ELSE ROW_NUMBER() OVER (
		              ORDER BY summary.overall_points DESC NULLS LAST,
		                       summary.overall_rank ASC NULLS LAST,
		                       summary.entry_id
		            )::integer
		          END AS field_rank,
		          summary.event_points,
		          summary.event_transfers_cost AS event_cost,
		          summary.event_net_points,
		          summary.event_rank,
		          summary.overall_points,
		          summary.overall_rank,
		          summary.event_chip::text,
		          summary.played_captain_element_id AS captain_id,
		          captain.web_name AS captain_web_name,
		          captain_team.short_name AS captain_team_short_name,
		          summary.captain_points,
		          summary.team_value,
		          summary.bank
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
		     WHERE fixture_stats.season_id = summary.season_id
		       AND fixture_stats.event_id = summary.event_id
		       AND fixture_stats.element_id = summary.played_captain_element_id
		     ORDER BY fixture_stats.fixture_id
		     LIMIT 1
		   ) captain_historical_team ON TRUE
		   LEFT JOIN fpl.teams captain_team
		     ON captain_team.season_id = captain.season_id
		    AND captain_team.team_id = COALESCE(captain_historical_team.team_id, captain.team_id)
		   WHERE summary.season_id = $1
		     AND summary.tournament_id = $2
		     AND summary.event_id = $3
		 ), filtered AS MATERIALIZED (
		   SELECT * FROM board
		   WHERE $4 = ''
		      OR entry_name ILIKE '%' || $4 || '%'
		      OR player_name ILIKE '%' || $4 || '%'
		 ), paged AS (
		   SELECT * FROM filtered
		   ORDER BY group_id NULLS LAST, rank NULLS LAST, entry_id
		   LIMIT $5 OFFSET $6
		 )
		 SELECT jsonb_build_object(
		   'fieldSize', (SELECT count(*)::integer FROM board),
		   'totalRows', (SELECT count(*)::integer FROM filtered),
		   'rows', COALESCE((SELECT jsonb_agg(to_jsonb(paged) ORDER BY group_id NULLS LAST, rank NULLS LAST, entry_id) FROM paged), '[]'::jsonb),
		   'viewerRow', (SELECT to_jsonb(board) FROM board WHERE entry_id = $7 LIMIT 1)
		 ) AS payload`,
		[
			context.currentSeason.seasonId,
			tournamentId,
			eventId,
			normalizedSearch,
			pageSize,
			offset,
			entryId,
		]
	);
	const parsed = parseBoardPayload(result.rows[0]?.payload);
	const state: MyFplReviewState =
		parsed.fieldSize > 0 && parsed.viewerRow !== null ? "READY" : "PENDING";
	const payload: MyFplCompetitionBoardPage = {
		state,
		eventId,
		page,
		pageSize,
		totalRows: parsed.totalRows,
		totalPages: parsed.totalRows === 0 ? 0 : Math.ceil(parsed.totalRows / pageSize),
		fieldSize: parsed.fieldSize,
		rows: parsed.rows,
		viewerRow: parsed.viewerRow,
	};
	if (cacheableState(state)) {
		await writeQueryCache(context, cacheKey, JSON.stringify(payload), stateTtl(state));
	}
	return payload;
};

const loadCompetitionAggregate = async (
	context: GraphQLContext,
	tournamentId: number,
	eventId: number,
	entryId: number
): Promise<MyFplCompetitionAggregate | null> => {
	const cacheKey = gqlCacheKey(
		context,
		`my-fpl:${PROJECTION_VERSION}:competition-aggregate:${tournamentId}:${eventId}:${entryId}`
	);
	const cached = await readCache(
		context,
		cacheKey,
		(value): value is MyFplCompetitionAggregate =>
			isCompetitionAggregateCache(value) && value.eventId === eventId
	);
	if (cached) return cached;
	const result = await context.database.query<{ payload: unknown }>(COMPETITION_AGGREGATE_SQL, [
		context.currentSeason.seasonId,
		tournamentId,
		eventId,
		entryId,
	]);
	const payload = result.rows[0]?.payload;
	if (!isCompetitionAggregateCache(payload) || payload.eventId !== eventId) return null;
	await writeQueryCache(
		context,
		cacheKey,
		JSON.stringify(payload),
		QUERY_CACHE_TTL_SECONDS.REPORTING
	);
	return payload;
};

const loadCompetitionBoard = async (
	context: GraphQLContext,
	args: {
		tournamentId: number;
		eventId: number;
		page?: number | null;
		pageSize?: number | null;
		search?: string | null;
	}
): Promise<MyFplCompetitionBoardPage> => {
	const entryId = requireVerifiedEntryId(context);
	const loadedContext = await loadReviewContext(context);
	return loadCompetitionBoardPrepared(
		context,
		loadedContext,
		entryId,
		args.tournamentId,
		args.eventId,
		args.page ?? 1,
		args.pageSize ?? 100,
		args.search
	);
};

const loadCompetitionsDesk = async (
	context: GraphQLContext,
	tournamentId?: number | null,
	eventId?: number | null
): Promise<MyFplCompetitionsDesk> => {
	if (tournamentId !== undefined && tournamentId !== null) validateTournamentId(tournamentId);
	if (eventId !== undefined && eventId !== null) validateEventId(eventId);
	const entryId = requireVerifiedEntryId(context);
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
		};
	}
	// The catalog is revision-cached, so revalidate the selected default
	// tournament before returning even during preseason. This prevents a
	// recently revoked membership from receiving cached protected metadata.
	await assertTournamentMembership(context, selectedTournament.id, entryId);
	if (!tournaments.some((tournament) => tournament.id === selectedTournament.id)) {
		tournaments = [...tournaments, selectedTournament];
	}
	const selectedEventId = eventId ?? loadedContext.value.latestFinalizedEventId;
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
		selectedTournament
	);
	const canLoadAggregate =
		loadedContext.finalizedEventIds.has(selectedEventId) &&
		selectedTournament.groupMode === GroupMode.POINTS_RACES &&
		selectedTournament.setupStatus === TournamentSetupStatus.READY &&
		Boolean(selectedTournament.standingsReadyAt) &&
		Boolean(selectedTournament.insightsReadyAt);
	const [board, aggregateCandidate] = canLoadAggregate
		? await Promise.all([
				boardPromise,
				loadCompetitionAggregate(context, selectedTournament.id, selectedEventId, entryId),
			])
		: [await boardPromise, null];
	const aggregate = board.state === "READY" ? aggregateCandidate : null;
	return {
		state: board.state,
		context: loadedContext.value,
		tournaments,
		selectedTournamentId: selectedTournament.id,
		selectedTournament,
		eventId: selectedEventId,
		board,
		aggregate,
	};
};

const loadCompetitionSeasonPath = async (
	context: GraphQLContext,
	tournamentId: number,
	throughEventId: number
): Promise<MyFplCompetitionSeasonPath> => {
	validateTournamentId(tournamentId);
	validateEventId(throughEventId);
	const entryId = requireVerifiedEntryId(context);
	const loadedContext = await loadReviewContext(context);
	await assertTournamentMembership(context, tournamentId, entryId);
	const empty = (state: MyFplReviewState): MyFplCompetitionSeasonPath => ({
		state,
		context: loadedContext.value,
		tournamentId,
		throughEventId,
		points: [],
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
	if (!loadedContext.finalizedEventIds.has(throughEventId)) return empty("PENDING");

	const cacheKey = gqlCacheKey(
		context,
		`my-fpl:${PROJECTION_VERSION}:competition-season-path:${tournamentId}:${entryId}:${throughEventId}`
	);
	const cached = await readCache(
		context,
		cacheKey,
		(value): value is MyFplCompetitionSeasonPath =>
			isCompetitionSeasonPathCache(value) && value.throughEventId === throughEventId
	);
	if (cached) return cached;

	const result = await context.database.query<DbSeasonPathRow>(
		`WITH field AS MATERIALIZED (
		   SELECT event_id,
		          count(*)::integer AS field_size,
		          max(overall_points) AS leader_overall_points,
		          avg(overall_points)::numeric AS average_overall_points
		   FROM reporting.tournament_entry_event_summaries
		   WHERE season_id = $1
		     AND tournament_id = $2
		     AND event_id BETWEEN 1 AND $3
		   GROUP BY event_id
		 ), mine AS MATERIALIZED (
		   SELECT summary.event_id,
		          COALESCE(group_result.event_group_rank, summary.tournament_event_rank)::integer AS tournament_rank,
		          summary.overall_points
		   FROM reporting.tournament_entry_event_summaries summary
		   LEFT JOIN competition.tournament_points_group_results group_result
		     ON group_result.season_id = summary.season_id
		    AND group_result.tournament_id = summary.tournament_id
		    AND group_result.event_id = summary.event_id
		    AND group_result.entry_id = summary.entry_id
		   WHERE summary.season_id = $1
		     AND summary.tournament_id = $2
		     AND summary.entry_id = $4
		     AND summary.event_id BETWEEN 1 AND $3
		 )
		 SELECT mine.event_id, mine.tournament_rank, field.field_size,
		        mine.overall_points, field.leader_overall_points,
		        field.average_overall_points,
		        CASE WHEN mine.overall_points IS NULL OR field.leader_overall_points IS NULL
		             THEN NULL ELSE GREATEST(0, field.leader_overall_points - mine.overall_points) END AS gap_to_leader,
		        CASE WHEN mine.overall_points IS NULL OR field.average_overall_points IS NULL
		             THEN NULL ELSE mine.overall_points - field.average_overall_points END AS points_vs_average
		 FROM mine
		 JOIN field USING (event_id)
		 ORDER BY mine.event_id`,
		[context.currentSeason.seasonId, tournamentId, throughEventId, entryId]
	);
	const points = result.rows.map((row) => ({
		gameweek: row.event_id,
		tournamentRank: asInteger(row.tournament_rank),
		gapToLeader: row.gap_to_leader,
		pointsVsAverage: asFiniteNumber(row.points_vs_average),
		fieldSize: row.field_size,
		overallPoints: row.overall_points,
		leaderOverallPoints: row.leader_overall_points,
		averageOverallPoints: asFiniteNumber(row.average_overall_points),
	}));
	const hasRequestedEvent = points.some((point) => point.gameweek === throughEventId);
	const payload: MyFplCompetitionSeasonPath = {
		state: hasRequestedEvent ? "READY" : "PENDING",
		context: loadedContext.value,
		tournamentId,
		throughEventId,
		points,
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
	const entryId = requireVerifiedEntryId(context);
	await dependenciesFor(context).getCoreEventSnapshot(context);
	await assertTournamentMembership(context, tournamentId, entryId);
	const result = await context.database.query<DbSetupStatusRow>(
		`SELECT setup_status::text, setup_phase::text, setup_completed_units,
		        setup_total_units, setup_progress_updated_at, standings_ready_at,
		        insights_ready_at,
		        setup_warning_count
		 FROM competition.tournaments
		 WHERE season_id = $1 AND tournament_id = $2
		 LIMIT 1`,
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
		loadTeamDesk: (context, eventId) =>
			withDependencies(context, dependencies, () => loadTeamDesk(context, eventId)),
		loadTeamGameweek: (context, eventId) =>
			withDependencies(context, dependencies, () => loadTeamGameweek(context, eventId)),
		loadTeamTransfers: (context) =>
			withDependencies(context, dependencies, () => loadTeamTransfers(context)),
		loadCompetitionsDesk: (context, tournamentId, eventId) =>
			withDependencies(context, dependencies, () =>
				loadCompetitionsDesk(context, tournamentId, eventId)
			),
		loadCompetitionBoard: (context, args) =>
			withDependencies(context, dependencies, () => loadCompetitionBoard(context, args)),
		loadCompetitionSeasonPath: (context, tournamentId, throughEventId) =>
			withDependencies(context, dependencies, () =>
				loadCompetitionSeasonPath(context, tournamentId, throughEventId)
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
};
