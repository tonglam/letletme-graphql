import { createHash } from "node:crypto";
import type { QueryResultRow } from "pg";
import type { DataSqlContractProbe } from "../../contracts/data-sql-contract";
import type { GraphQLContext } from "../../graphql/context";
import { gqlCacheKey } from "../../infra/cache-key";
import type { QueryExecutor as DatabaseQueryExecutor } from "../../infra/database";
import {
	getCoreDataSnapshot,
	type CoreDataSnapshot,
	type CoreFixtureData,
} from "../../infra/data-snapshot";
import {
	resolvePlayerStatsContext,
	type PlayerStatsSnapshotStatus,
} from "../players/season-stats-at-event";
import { deleteQueryCache, writeQueryCache } from "../../infra/query-cache";
import {
	assessAvailability,
	assessOutlook,
	assessOutput,
	assessReliability,
	assessRole,
	averagePercentiles,
	composePlayerState,
	expectedMetricsAvailableForSeason,
	percentile,
} from "./engine";
import { sourceCoverage, PLAYER_STATE_FRESHNESS_STALE_SECONDS } from "./coverage";
import { applyPlayerStateEvidencePolicy } from "./trend-evidence-policy";
import type {
	PlayerGameweekSample,
	PlayerRadarAxis,
	PlayerRadarProfile,
	PlayerStateBaselineSeason,
	PlayerStateCareerPoint,
	PlayerStateDimension,
	PlayerStateMetric,
	PlayerStateOutlookGameweek,
	PlayerStateProfile,
	PlayerStateSourceCoverage,
	PlayerStateAnalysisStatus,
	PlayerStateProviderMode,
	PlayerStateMappingStatus,
	PlayerSeasonPhase,
	PlayerSeasonSignal,
	PlayerSeasonSignalCode,
	PlayerSeasonTimelinePoint,
	ProcessAssessment,
} from "./types";

export const PLAYER_STATE_SUCCESS_CACHE_TTL_SECONDS = 15 * 60;
export const PLAYER_STATE_NULL_CACHE_TTL_SECONDS = 60;
const NULL_SENTINEL = "__player_state:null__";
const MINIMUM_CURRENT_GAMEWEEKS = 3;
const CURRENT_PEER_MINUTES = 900;
const HISTORY_PLAYER_MINUTES = 450;
const HISTORY_PEER_MINUTES = 900;
const PROCESS_MINIMUM_MINUTES = 180;

export type QueryExecutor = DatabaseQueryExecutor;

type PlayerStateRepositoryDependencies = Readonly<{
	executor?: QueryExecutor;
	loadCoreSnapshot?: (context: GraphQLContext) => Promise<CoreDataSnapshot>;
	resolveStatsContext?: typeof resolvePlayerStatsContext;
}>;

type MarketRow = QueryResultRow & {
	status: string;
	chance_this_round: number | null;
	captured_at: Date | string;
};

export type PlayerStateSeasonRow = QueryResultRow & {
	season_id: number;
	season_code: string;
	lifecycle_state: string;
	player_code: number;
	element_id: number;
	element_type: number;
	fpl_minutes: number;
	fpl_gameweeks: number;
	fpl_total_points: number;
	fpl_starts: number;
	fpl_clean_sheets: number;
	fpl_saves: number;
	fpl_points_per_90: number | string | null;
	fpl_return_rate: number | string | null;
	fpl_bonus_per_90: number | string | null;
	fpl_position_percentile: number | string | null;
	fpl_peer_count: number;
	expected_metrics_available: boolean;
	fpl_source_hash: string;
	fpl_source_updated_at: Date | string;
	understat_mapping_status: string;
	understat_player_id: number | null;
	understat_season_state: string | null;
	understat_minutes: number | null;
	understat_npxg_per_90: number | string | null;
	understat_xa_per_90: number | string | null;
	understat_shots_per_90: number | string | null;
	understat_key_passes_per_90: number | string | null;
	understat_xg_chain_per_90: number | string | null;
	understat_xg_buildup_per_90: number | string | null;
	understat_npxg_percentile: number | string | null;
	understat_xa_percentile: number | string | null;
	understat_shots_percentile: number | string | null;
	understat_key_passes_percentile: number | string | null;
	understat_xg_chain_percentile: number | string | null;
	understat_xg_buildup_percentile: number | string | null;
	understat_process_percentile: number | string | null;
	understat_peer_count: number;
	understat_source_hash: string | null;
	understat_source_updated_at: Date | string | null;
	refreshed_at: Date | string;
};

type DatasetRevisionRow = QueryResultRow & {
	revision: number | string;
	method_version: string;
	source_updated_at: Date | string;
	refreshed_at: Date | string;
};

type PlayerStateDatasetRevision = {
	revision: string;
	methodVersion: string;
	sourceUpdatedAt: string;
	refreshedAt: string;
};

type CurrentPeerRow = QueryResultRow & {
	element_id: number;
	total_points: number | null;
	minutes: number | null;
	bonus: number | null;
	starts: number | null;
	goals_scored: number | null;
	assists: number | null;
	clean_sheets: number | null;
	saves: number | null;
	bps: number | null;
	expected_goal_involvements: number | null;
	return_count: number | null;
	gameweeks_available: number | null;
};

type CurrentPeerGameweekRow = QueryResultRow & {
	element_id: number;
	event_id: number;
	total_points: number;
	minutes: number | null;
	started: boolean | null;
	bonus: number | null;
};

type CurrentMetricRow = {
	elementId: number;
	pointsPer90: number | null;
	returnRate: number;
	bonusPer90: number | null;
	minutes: number;
	gameweeks: number;
	starts: number | null;
	goalsScored: number | null;
	assists: number | null;
	cleanSheets: number | null;
	saves: number | null;
	bps: number | null;
	expectedGoalInvolvements: number | null;
};

type PlayerHistory = {
	baselineSeasons: PlayerStateBaselineSeason[];
	careerTrajectory: PlayerStateCareerPoint[];
	seasons: string[];
	revision: string;
	asOf: string | null;
};

type UnderstatCohortRow = QueryResultRow & {
	season: string;
	season_state: string;
	season_last_seen_at: Date | string;
	player_code: number;
	player_id: number;
	is_subject: boolean;
	minutes: number;
	position: string;
	non_penalty_xg: number | string;
	xa: number | string;
	shots: number;
	key_passes: number;
	xg_chain: number | string;
	xg_buildup: number | string;
	source_hash: string;
	updated_at: Date | string;
};

type UnderstatValues = {
	npxgPer90: number | null;
	xaPer90: number | null;
	shotsPer90: number | null;
	keyPassesPer90: number | null;
	xgChainPer90: number | null;
	xgBuildupPer90: number | null;
};

type UnderstatProcessResult = {
	assessment: ProcessAssessment;
	currentSubject: UnderstatCohortRow | null;
	historyPercentiles: Map<string, number>;
	historySeasons: string[];
};

export const PLAYER_STATE_MARKETS_SQL = `
	/* player-state:markets-batch */
	SELECT DISTINCT ON (element_id)
		status,
		chance_of_playing_this_round AS chance_this_round,
		captured_at,
		element_id
	FROM fpl.player_market_snapshots
	WHERE season_id = $1 AND element_id = ANY($2::integer[])
	ORDER BY element_id, snapshot_date DESC, captured_at DESC
`;

export const PLAYER_STATE_DATASET_REVISION_SQL = `
	/* player-state:dataset-revision */
	SELECT revision, method_version, source_updated_at, refreshed_at
	FROM reporting.player_state_dataset_metadata
	WHERE dataset_key = 'player_state'
`;

export const PLAYER_STATE_SEASON_ROWS_SQL = `
	/* player-state:season-rows */
	SELECT
		season_id,
		season_code,
		lifecycle_state,
		player_code,
		element_id,
		element_type,
		fpl_minutes,
		fpl_gameweeks,
		fpl_total_points,
		fpl_starts,
		fpl_clean_sheets,
		fpl_saves,
		fpl_points_per_90,
		fpl_return_rate,
		fpl_bonus_per_90,
		fpl_position_percentile,
		fpl_peer_count,
		expected_metrics_available,
		fpl_source_hash,
		fpl_source_updated_at,
		understat_mapping_status,
		understat_player_id,
		understat_season_state,
		understat_minutes,
		understat_npxg_per_90,
		understat_xa_per_90,
		understat_shots_per_90,
		understat_key_passes_per_90,
		understat_xg_chain_per_90,
		understat_xg_buildup_per_90,
		understat_npxg_percentile,
		understat_xa_percentile,
		understat_shots_percentile,
		understat_key_passes_percentile,
		understat_xg_chain_percentile,
		understat_xg_buildup_percentile,
		understat_process_percentile,
		understat_peer_count,
		understat_source_hash,
		understat_source_updated_at,
		refreshed_at
	FROM reporting.player_state_season_rows
	WHERE player_code = ANY($1::integer[])
	ORDER BY player_code, season_id DESC
`;

export const PLAYER_STATE_CURRENT_PEERS_SQL = `
	/* player-state:current-peers */
	SELECT
		summary.element_id,
		summary.total_points,
		summary.minutes,
		summary.bonus,
		summary.gameweeks_started AS starts,
		summary.goals_scored,
		summary.assists,
		summary.clean_sheets,
		summary.saves,
		summary.bps,
		summary.expected_goal_involvements,
		summary.return_count,
		summary.gameweeks_available
	FROM reporting.player_season_summary_rows summary
	JOIN fpl.players player
		ON player.season_id = summary.season_id
		AND player.element_id = summary.element_id
	WHERE summary.season_id = $1 AND player.element_type = $2
	ORDER BY summary.element_id
`;

export const PLAYER_STATE_CURRENT_PEER_GAMEWEEKS_SQL = `
	/* player-state:current-gameweeks */
	SELECT
		stats.element_id,
		stats.event_id,
		stats.total_points,
		stats.minutes,
		stats.starts AS started,
		stats.bonus
	FROM fpl.player_gameweek_stats stats
	JOIN fpl.players player
		ON player.season_id = stats.season_id
		AND player.element_id = stats.element_id
	WHERE stats.season_id = $1
		AND player.element_type = $2
		AND stats.event_id = ANY($3::integer[])
	ORDER BY stats.event_id, stats.element_id
`;

export const PLAYER_STATE_DATA_SQL_CONTRACT: readonly DataSqlContractProbe[] = [
	{
		name: "player-state.market-snapshots",
		sql: PLAYER_STATE_MARKETS_SQL,
		values: [2026, [1]],
	},
	{
		name: "player-state.dataset-revision",
		sql: PLAYER_STATE_DATASET_REVISION_SQL,
		values: [],
		runtime: "must-return-player-state-revision",
		resultTypes: [
			{
				relation: "reporting.player_state_dataset_metadata",
				column: "revision",
				pgType: "bigint",
			},
			{
				relation: "reporting.player_state_dataset_metadata",
				column: "method_version",
				pgType: "text",
				acceptedPgTypes: ["character varying"],
			},
			{
				relation: "reporting.player_state_dataset_metadata",
				column: "source_updated_at",
				pgType: "timestamp with time zone",
			},
			{
				relation: "reporting.player_state_dataset_metadata",
				column: "refreshed_at",
				pgType: "timestamp with time zone",
			},
		],
	},
	{
		name: "player-state.season-rows",
		sql: PLAYER_STATE_SEASON_ROWS_SQL,
		values: [[26001]],
		runtime: "must-return-player-state-row",
	},
	{
		name: "player-state.current-peers",
		sql: PLAYER_STATE_CURRENT_PEERS_SQL,
		values: [2026, 1],
	},
	{
		name: "player-state.current-gameweeks",
		sql: PLAYER_STATE_CURRENT_PEER_GAMEWEEKS_SQL,
		values: [2026, 1, [1]],
	},
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const asNumber = (value: unknown): number | null => {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : null;
	}
	return null;
};

const asSafeInteger = (value: unknown): number | null => {
	const parsed = asNumber(value);
	return parsed !== null && Number.isSafeInteger(parsed) ? parsed : null;
};

const isOptionalFiniteNumber = (value: unknown): boolean =>
	value === null || value === undefined || asNumber(value) !== null;

const isOptionalNonNegativeInteger = (value: unknown): boolean => {
	if (value === null || value === undefined) return true;
	const parsed = asSafeInteger(value);
	return parsed !== null && parsed >= 0;
};

const isValidTimestamp = (value: unknown): boolean => {
	if (value instanceof Date) return Number.isFinite(value.getTime());
	return typeof value === "string" && Number.isFinite(Date.parse(value));
};

const PLAYER_STATE_LIFECYCLE_STATES = new Set([
	"reference_only",
	"completed",
	"preseason",
	"active",
	"closed",
]);
const PLAYER_STATE_MAPPING_STATUSES = new Set([
	"VERIFIED",
	"UNVERIFIED",
	"AMBIGUOUS",
	"QUARANTINED",
	"UNAVAILABLE",
]);

/**
 * Decode a reporting season row through the shape consumed by Player State.
 * The direct Data contract calls this same decoder so an RLS-hidden or
 * partially migrated row cannot be accepted as an empty history.
 */
export const parsePlayerStateSeasonRow = (value: unknown): PlayerStateSeasonRow | null => {
	if (!isRecord(value)) return null;
	const seasonId = asSafeInteger(value.season_id);
	const playerCode = asSafeInteger(value.player_code);
	const elementId = asSafeInteger(value.element_id);
	const elementType = asSafeInteger(value.element_type);
	const fplMinutes = asSafeInteger(value.fpl_minutes);
	const fplGameweeks = asSafeInteger(value.fpl_gameweeks);
	const fplTotalPoints = asSafeInteger(value.fpl_total_points);
	const fplStarts = asSafeInteger(value.fpl_starts);
	const fplCleanSheets = asSafeInteger(value.fpl_clean_sheets);
	const fplSaves = asSafeInteger(value.fpl_saves);
	const fplPeerCount = asSafeInteger(value.fpl_peer_count);
	const understatPeerCount = asSafeInteger(value.understat_peer_count);
	const seasonCode = value.season_code;
	const lifecycleState = value.lifecycle_state;
	const expectedMetricsAvailable = value.expected_metrics_available;
	const fplSourceHash = value.fpl_source_hash;
	const mappingStatus = value.understat_mapping_status;
	if (
		seasonId === null ||
		seasonId <= 0 ||
		playerCode === null ||
		playerCode <= 0 ||
		elementId === null ||
		elementId <= 0 ||
		elementType === null ||
		elementType < 1 ||
		elementType > 4 ||
		fplMinutes === null ||
		fplMinutes < 0 ||
		fplGameweeks === null ||
		fplGameweeks < 0 ||
		fplTotalPoints === null ||
		fplStarts === null ||
		fplStarts < 0 ||
		fplCleanSheets === null ||
		fplCleanSheets < 0 ||
		fplSaves === null ||
		fplSaves < 0 ||
		fplPeerCount === null ||
		fplPeerCount < 0 ||
		understatPeerCount === null ||
		understatPeerCount < 0 ||
		typeof seasonCode !== "string" ||
		!/^[0-9]{4}$/.test(seasonCode) ||
		typeof lifecycleState !== "string" ||
		!PLAYER_STATE_LIFECYCLE_STATES.has(lifecycleState) ||
		typeof expectedMetricsAvailable !== "boolean" ||
		typeof fplSourceHash !== "string" ||
		fplSourceHash.trim() === "" ||
		!isValidTimestamp(value.fpl_source_updated_at) ||
		typeof mappingStatus !== "string" ||
		!PLAYER_STATE_MAPPING_STATUSES.has(mappingStatus) ||
		!isOptionalNonNegativeInteger(value.understat_player_id) ||
		(value.understat_season_state !== null &&
			value.understat_season_state !== undefined &&
			(typeof value.understat_season_state !== "string" ||
				value.understat_season_state.trim() === "")) ||
		!isOptionalNonNegativeInteger(value.understat_minutes) ||
		!isOptionalFiniteNumber(value.fpl_points_per_90) ||
		!isOptionalFiniteNumber(value.fpl_return_rate) ||
		!isOptionalFiniteNumber(value.fpl_bonus_per_90) ||
		!isOptionalFiniteNumber(value.fpl_position_percentile) ||
		!isOptionalFiniteNumber(value.understat_npxg_per_90) ||
		!isOptionalFiniteNumber(value.understat_xa_per_90) ||
		!isOptionalFiniteNumber(value.understat_shots_per_90) ||
		!isOptionalFiniteNumber(value.understat_key_passes_per_90) ||
		!isOptionalFiniteNumber(value.understat_xg_chain_per_90) ||
		!isOptionalFiniteNumber(value.understat_xg_buildup_per_90) ||
		!isOptionalFiniteNumber(value.understat_npxg_percentile) ||
		!isOptionalFiniteNumber(value.understat_xa_percentile) ||
		!isOptionalFiniteNumber(value.understat_shots_percentile) ||
		!isOptionalFiniteNumber(value.understat_key_passes_percentile) ||
		!isOptionalFiniteNumber(value.understat_xg_chain_percentile) ||
		!isOptionalFiniteNumber(value.understat_xg_buildup_percentile) ||
		!isOptionalFiniteNumber(value.understat_process_percentile) ||
		(value.understat_source_hash !== null &&
			value.understat_source_hash !== undefined &&
			(typeof value.understat_source_hash !== "string" ||
				value.understat_source_hash.trim() === "")) ||
		(value.understat_source_updated_at !== null &&
			value.understat_source_updated_at !== undefined &&
			!isValidTimestamp(value.understat_source_updated_at)) ||
		!isValidTimestamp(value.refreshed_at)
	) {
		return null;
	}
	return value as PlayerStateSeasonRow;
};

const iso = (value: Date | string | null): string | null => {
	if (value === null) return null;
	const date = value instanceof Date ? value : new Date(value);
	return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

const latestIso = (values: Array<string | null>): string | null =>
	values
		.filter((value): value is string => value !== null)
		.sort()
		.at(-1) ?? null;

const freshness = (timestamp: string | null): number | null =>
	timestamp === null ? null : Math.max(0, Math.floor((Date.now() - Date.parse(timestamp)) / 1000));

const stableHash = (value: unknown): string =>
	createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 20);

const PLAYER_STATE_SOURCE_KEYS = [
	"FPL:CURRENT",
	"FPL:HISTORY",
	"UNDERSTAT:CURRENT",
	"UNDERSTAT:HISTORY",
] as const;

const PLAYER_SEASON_SIGNAL_CODES = [
	"UNDERSTAT_NPXG_PER_90",
	"UNDERSTAT_XA_PER_90",
	"UNDERSTAT_NPXG_XA_PER_90",
	"UNDERSTAT_KEY_PASSES_PER_90",
	"OFFICIAL_CLEAN_SHEET_RATE",
	"OFFICIAL_SAVES_PER_90",
] as const satisfies readonly PlayerSeasonSignalCode[];

const signalCodesForPosition = (position: number): readonly PlayerSeasonSignalCode[] => {
	switch (position) {
		case 1:
			return ["OFFICIAL_SAVES_PER_90", "OFFICIAL_CLEAN_SHEET_RATE"];
		case 2:
			return ["OFFICIAL_CLEAN_SHEET_RATE", "UNDERSTAT_NPXG_XA_PER_90"];
		case 3:
			return ["UNDERSTAT_NPXG_XA_PER_90", "UNDERSTAT_KEY_PASSES_PER_90"];
		case 4:
		default:
			return ["UNDERSTAT_NPXG_PER_90", "UNDERSTAT_XA_PER_90"];
	}
};

const signalProviderForCode = (code: PlayerSeasonSignalCode): "FPL" | "UNDERSTAT" =>
	code.startsWith("OFFICIAL_") ? "FPL" : "UNDERSTAT";

const isAnalysisStatus = (value: unknown): value is PlayerStateAnalysisStatus =>
	value === "READY" ||
	value === "PRESEASON" ||
	value === "INSUFFICIENT" ||
	value === "NOT_APPLICABLE" ||
	value === "UNAVAILABLE";

const playerSeasonSignalGuard = (value: unknown): value is PlayerSeasonSignal => {
	if (!isRecord(value)) return false;
	const code = value.code;
	const provider = value.provider;
	const signalCode = PLAYER_SEASON_SIGNAL_CODES.includes(
		code as (typeof PLAYER_SEASON_SIGNAL_CODES)[number]
	)
		? (code as PlayerSeasonSignalCode)
		: null;
	return (
		signalCode !== null &&
		provider === signalProviderForCode(signalCode) &&
		(value.value === null || (typeof value.value === "number" && Number.isFinite(value.value))) &&
		typeof value.unit === "string" &&
		value.unit.length > 0 &&
		(value.sampleMinutes === null ||
			(typeof value.sampleMinutes === "number" &&
				Number.isInteger(value.sampleMinutes) &&
				value.sampleMinutes >= 0)) &&
		isAnalysisStatus(value.analysisStatus) &&
		Array.isArray(value.reasonCodes) &&
		value.reasonCodes.every((reason) => typeof reason === "string") &&
		(value.analysisStatus !== "READY" || value.value !== null)
	);
};

const playerSeasonTimelineGuard = (
	value: unknown,
	profileSeason: string
): value is PlayerSeasonTimelinePoint[] => {
	if (!Array.isArray(value) || value.length === 0) return false;
	const seasons = value.map((point) => (isRecord(point) ? point.season : null));
	if (
		seasons[0] !== profileSeason ||
		!seasons.every((season) => typeof season === "string" && /^\d{4}$/.test(season))
	) {
		return false;
	}
	for (let index = 1; index < seasons.length; index += 1) {
		if (seasons[index - 1]! <= seasons[index]!) return false;
	}
	return value.every((point) => {
		if (!isRecord(point)) return false;
		if (
			(point.phase !== "PRESEASON" && point.phase !== "ACTIVE" && point.phase !== "COMPLETED") ||
			typeof point.position !== "number" ||
			!Number.isInteger(point.position) ||
			point.position < 1 ||
			point.position > 4 ||
			(point.fplTotalPoints !== null &&
				(typeof point.fplTotalPoints !== "number" || !Number.isInteger(point.fplTotalPoints))) ||
			!Array.isArray(point.signals) ||
			point.signals.length !== 2 ||
			!point.signals.every(playerSeasonSignalGuard)
		) {
			return false;
		}
		const expectedCodes = signalCodesForPosition(point.position);
		const codes = point.signals.map((signal) => signal.code);
		const fplRowUnavailable = point.signals.every(
			(signal) =>
				signal.analysisStatus === "UNAVAILABLE" &&
				signal.reasonCodes.includes("FPL_SEASON_ROW_UNAVAILABLE")
		);
		const fplSignals = point.signals.filter((signal) => signal.provider === "FPL");
		const understatSignals = point.signals.filter((signal) => signal.provider === "UNDERSTAT");
		const fplSourceUnavailable =
			fplSignals.length === 0 ||
			fplSignals.every(
				(signal) =>
					signal.analysisStatus === "UNAVAILABLE" &&
					signal.reasonCodes.includes("FPL_SEASON_ROW_UNAVAILABLE")
			);
		const independentSourceClock = understatSignals.length > 0 && fplSourceUnavailable;
		return (
			new Set(codes).size === 2 &&
			codes.every((code, index) => code === expectedCodes[index]) &&
			(point.phase === "PRESEASON"
				? point.fplTotalPoints === null
				: point.fplTotalPoints !== null || fplRowUnavailable || independentSourceClock)
		);
	});
};

const playerStateSourceGuard = (value: unknown): value is PlayerStateSourceCoverage => {
	if (!isRecord(value)) return false;
	if (
		(value.provider !== "FPL" && value.provider !== "UNDERSTAT") ||
		(value.scope !== "CURRENT" && value.scope !== "HISTORY") ||
		!Array.isArray(value.seasons) ||
		!value.seasons.every((season) => typeof season === "string" && /^\d{4}$/.test(season)) ||
		(value.dataStatus !== "AVAILABLE" && value.dataStatus !== "UNAVAILABLE") ||
		(value.analysisStatus !== "READY" &&
			value.analysisStatus !== "PRESEASON" &&
			value.analysisStatus !== "INSUFFICIENT" &&
			value.analysisStatus !== "NOT_APPLICABLE" &&
			value.analysisStatus !== "UNAVAILABLE") ||
		(value.mappingStatus !== "VERIFIED" &&
			value.mappingStatus !== "UNVERIFIED" &&
			value.mappingStatus !== "AMBIGUOUS" &&
			value.mappingStatus !== "QUARANTINED" &&
			value.mappingStatus !== "UNAVAILABLE" &&
			value.mappingStatus !== "NOT_APPLICABLE") ||
		!Array.isArray(value.reasonCodes) ||
		!value.reasonCodes.every((reason) => typeof reason === "string") ||
		(value.revision !== null && typeof value.revision !== "string") ||
		(value.asOf !== null && typeof value.asOf !== "string") ||
		(value.freshnessSeconds !== null &&
			(typeof value.freshnessSeconds !== "number" ||
				!Number.isInteger(value.freshnessSeconds) ||
				value.freshnessSeconds < 0)) ||
		typeof value.stale !== "boolean"
	) {
		return false;
	}
	return PLAYER_STATE_SOURCE_KEYS.includes(
		`${value.provider}:${value.scope}` as (typeof PLAYER_STATE_SOURCE_KEYS)[number]
	);
};

const profileGuard = (value: unknown): value is PlayerStateProfile =>
	isRecord(value) &&
	typeof value.playerId === "number" &&
	typeof value.playerCode === "number" &&
	typeof value.season === "string" &&
	typeof value.trend === "string" &&
	Array.isArray(value.dimensions) &&
	isRecord(value.coverage) &&
	Array.isArray(value.coverage.sources) &&
	value.coverage.sources.length === 4 &&
	value.coverage.sources.every(playerStateSourceGuard) &&
	value.coverage.sources.every(
		(source, index) => `${source.provider}:${source.scope}` === PLAYER_STATE_SOURCE_KEYS[index]
	) &&
	Array.isArray(value.coverage.metricCoverage) &&
	value.coverage.metricCoverage.every((metric) => typeof metric === "string") &&
	Array.isArray(value.coverage.limitations) &&
	value.coverage.limitations.every((limitation) => typeof limitation === "string") &&
	(value.providerMode === "FPL_ONLY" ||
		value.providerMode === "FPL_WITH_UNDERSTAT_HISTORY" ||
		value.providerMode === "FPL_WITH_UNDERSTAT_CURRENT") &&
	playerSeasonTimelineGuard(value.seasonTimeline, value.season);

const profileCacheKey = (
	context: GraphQLContext,
	stateRevision: string,
	playerId: number,
	horizon: number
): string =>
	gqlCacheKey(
		context,
		`player-state-profile:v3:${stateRevision}:${context.currentSeason.lifecycleState ?? "unknown"}:${playerId}:${horizon}`
	);

let datasetRevisionMemo: { expiresAt: number; value: PlayerStateDatasetRevision } | null = null;

const loadDatasetRevision = async (
	context: GraphQLContext,
	executor: QueryExecutor
): Promise<PlayerStateDatasetRevision> => {
	const cached = datasetRevisionMemo;
	if (cached && cached.expiresAt > Date.now()) return cached.value;
	const row = (await executor.query<DatasetRevisionRow>(PLAYER_STATE_DATASET_REVISION_SQL, []))
		.rows[0];
	if (!row) throw new Error("Player State dataset revision is unavailable");
	const value = {
		revision: String(row.revision),
		methodVersion: row.method_version,
		sourceUpdatedAt: iso(row.source_updated_at) ?? new Date(0).toISOString(),
		refreshedAt: iso(row.refreshed_at) ?? new Date(0).toISOString(),
	};
	datasetRevisionMemo = { expiresAt: Date.now() + 5_000, value };
	return value;
};

/** Shared five-second dataset revision memo used by the service singleflight key. */
export const getPlayerStateDatasetRevision = (
	context: GraphQLContext,
	executor: QueryExecutor = context.database
): Promise<PlayerStateDatasetRevision> => loadDatasetRevision(context, executor);

const profileCacheReadMemo = new WeakMap<
	object,
	Map<string, PlayerStateProfile | null | undefined>
>();

type CurrentCohort = Readonly<{
	peerRows: CurrentPeerRow[];
	gameweekRows: CurrentPeerGameweekRow[];
}>;

type SharedProfileData = Readonly<{
	seasonRowsByCode: Map<number, PlayerStateSeasonRow[]>;
	marketById: Map<number, MarketRow>;
}>;

const sharedProfileDataMemo = new WeakMap<object, Map<string, Promise<SharedProfileData>>>();
type ProfilePreload = Readonly<{
	snapshot: CoreDataSnapshot;
	shared: SharedProfileData;
	datasetRevision: PlayerStateDatasetRevision;
	executor: QueryExecutor;
}>;
const profilePreloadMemo = new WeakMap<object, Map<number, ProfilePreload>>();

const loadSharedProfileData = (
	context: GraphQLContext,
	executor: QueryExecutor,
	playerCodes: number[],
	playerIds: number[],
	seasonId: number
): Promise<SharedProfileData> => {
	const scope = context.requestScope ?? context;
	let memo = sharedProfileDataMemo.get(scope);
	if (!memo) {
		memo = new Map();
		sharedProfileDataMemo.set(scope, memo);
	}
	const codes = [...new Set(playerCodes)].sort((left, right) => left - right);
	const ids = [...new Set(playerIds)].sort((left, right) => left - right);
	const key = `${seasonId}:${codes.join(",")}:${ids.join(",")}`;
	const existing = memo.get(key);
	if (existing) return existing;
	const loading = Promise.all([
		codes.length === 0
			? Promise.resolve({ rows: [] as PlayerStateSeasonRow[] })
			: executor.query<PlayerStateSeasonRow>(PLAYER_STATE_SEASON_ROWS_SQL, [codes]),
		ids.length === 0
			? Promise.resolve({ rows: [] as MarketRow[] })
			: executor.query<MarketRow & { element_id: number }>(PLAYER_STATE_MARKETS_SQL, [
					seasonId,
					ids,
				]),
	]).then(([seasonRows, markets]) => {
		const seasonRowsByCode = new Map<number, PlayerStateSeasonRow[]>();
		for (const rawRow of seasonRows.rows) {
			const row = parsePlayerStateSeasonRow(rawRow);
			if (!row) continue;
			const rows = seasonRowsByCode.get(row.player_code) ?? [];
			rows.push(row);
			seasonRowsByCode.set(row.player_code, rows);
		}
		const marketById = new Map<number, MarketRow>();
		for (const row of markets.rows) {
			marketById.set(row.element_id, row);
		}
		return { seasonRowsByCode, marketById };
	});
	memo.set(key, loading);
	void loading.catch(() => {
		if (memo?.get(key) === loading) memo.delete(key);
	});
	return loading;
};

const currentCohortMemo = new WeakMap<object, Map<string, Promise<CurrentCohort>>>();

const loadCurrentCohort = (
	context: GraphQLContext,
	executor: QueryExecutor,
	seasonId: number,
	position: number,
	includeCurrent: boolean,
	eventIds: number[]
): Promise<CurrentCohort> => {
	const scope = context.requestScope ?? context;
	let memo = currentCohortMemo.get(scope);
	if (!memo) {
		memo = new Map();
		currentCohortMemo.set(scope, memo);
	}
	const key = `${seasonId}:${position}:${includeCurrent ? "current" : "preseason"}:${eventIds.join(",")}`;
	const existing = memo.get(key);
	if (existing) return existing;
	const loading = Promise.all([
		!includeCurrent
			? Promise.resolve({ rows: [] as CurrentPeerRow[] })
			: executor.query<CurrentPeerRow>(PLAYER_STATE_CURRENT_PEERS_SQL, [seasonId, position]),
		eventIds.length === 0
			? Promise.resolve({ rows: [] as CurrentPeerGameweekRow[] })
			: executor.query<CurrentPeerGameweekRow>(PLAYER_STATE_CURRENT_PEER_GAMEWEEKS_SQL, [
					seasonId,
					position,
					eventIds,
				]),
	]).then(([peers, gameweeks]) => ({
		peerRows: peers.rows,
		gameweekRows: gameweeks.rows,
	}));
	memo.set(key, loading);
	void loading.catch(() => {
		if (memo?.get(key) === loading) memo.delete(key);
	});
	return loading;
};

const requestProfileCacheMemo = (
	context: GraphQLContext
): Map<string, PlayerStateProfile | null | undefined> => {
	const scope = context.requestScope ?? context;
	let memo = profileCacheReadMemo.get(scope);
	if (!memo) {
		memo = new Map();
		profileCacheReadMemo.set(scope, memo);
	}
	return memo;
};

const parseProfileCacheValue = (
	raw: string | null
): PlayerStateProfile | null | undefined | "malformed" => {
	if (raw === null) return undefined;
	if (raw === NULL_SENTINEL) return null;
	try {
		const parsed: unknown = JSON.parse(raw);
		return profileGuard(parsed) ? parsed : "malformed";
	} catch {
		return "malformed";
	}
};

async function readProfileCache(
	context: GraphQLContext,
	key: string
): Promise<PlayerStateProfile | null | undefined> {
	const memo = requestProfileCacheMemo(context);
	if (memo.has(key)) return memo.get(key);
	try {
		const raw = await context.redis.get(key);
		const parsed = parseProfileCacheValue(raw);
		if (parsed !== "malformed") {
			memo.set(key, parsed);
			return parsed;
		}
		await deleteQueryCache(context, key);
	} catch (error) {
		context.logger.warn({ err: error, key }, "Failed to read player-state query cache");
	}
	memo.set(key, undefined);
	return undefined;
}

async function readProfileCaches(context: GraphQLContext, keys: string[]): Promise<void> {
	const memo = requestProfileCacheMemo(context);
	const missingKeys = keys.filter((key) => !memo.has(key));
	if (missingKeys.length === 0) return;
	let values: Array<string | null>;
	try {
		values = await context.redis.mget(...missingKeys);
	} catch (error) {
		context.logger.warn(
			{ err: error, keyCount: missingKeys.length },
			"Failed to batch-read player-state query cache"
		);
		for (const key of missingKeys) memo.set(key, undefined);
		return;
	}
	const malformedKeys: string[] = [];
	for (let index = 0; index < missingKeys.length; index += 1) {
		const key = missingKeys[index]!;
		const parsed = parseProfileCacheValue(values[index] ?? null);
		if (parsed === "malformed") {
			memo.set(key, undefined);
			malformedKeys.push(key);
		} else {
			memo.set(key, parsed);
		}
	}
	await Promise.all(malformedKeys.map((key) => deleteQueryCache(context, key)));
}

const writeNullCache = async (context: GraphQLContext, key: string): Promise<void> => {
	await writeQueryCache(context, key, NULL_SENTINEL, PLAYER_STATE_NULL_CACHE_TTL_SECONDS);
	requestProfileCacheMemo(context).set(key, null);
};

const writeProfileCache = async (
	context: GraphQLContext,
	key: string,
	profile: PlayerStateProfile
): Promise<void> => {
	await writeQueryCache(
		context,
		key,
		JSON.stringify(profile),
		PLAYER_STATE_SUCCESS_CACHE_TTL_SECONDS
	);
	requestProfileCacheMemo(context).set(key, profile);
};

const currentMetrics = (peerRows: CurrentPeerRow[]): CurrentMetricRow[] => {
	return peerRows.map((row) => {
		const minutes = row.minutes ?? 0;
		const gameweeks = row.gameweeks_available ?? 0;
		const returnCount = row.return_count ?? 0;
		return {
			elementId: row.element_id,
			pointsPer90:
				minutes > 0 && row.total_points !== null ? (row.total_points * 90) / minutes : null,
			returnRate: gameweeks === 0 ? 0 : (returnCount / gameweeks) * 100,
			bonusPer90: minutes > 0 && row.bonus !== null ? (row.bonus * 90) / minutes : null,
			minutes,
			gameweeks,
			starts: row.starts,
			goalsScored: row.goals_scored,
			assists: row.assists,
			cleanSheets: row.clean_sheets,
			saves: row.saves,
			bps: row.bps,
			expectedGoalInvolvements: asNumber(row.expected_goal_involvements),
		};
	});
};

const recentMetrics = (
	peerIds: number[],
	gameweekRows: CurrentPeerGameweekRow[],
	eventIds: number[]
): CurrentMetricRow[] => {
	const byPlayerEvent = new Map<string, CurrentPeerGameweekRow>();
	for (const row of gameweekRows) byPlayerEvent.set(`${row.element_id}:${row.event_id}`, row);
	return peerIds.map((elementId) => {
		const rows = eventIds.map((eventId) => byPlayerEvent.get(`${elementId}:${eventId}`) ?? null);
		const minutes = rows.reduce((sum, row) => sum + (row?.minutes ?? 0), 0);
		const points = rows.reduce((sum, row) => sum + (row?.total_points ?? 0), 0);
		const bonus = rows.reduce((sum, row) => sum + (row?.bonus ?? 0), 0);
		return {
			elementId,
			pointsPer90: minutes > 0 ? (points * 90) / minutes : null,
			returnRate:
				eventIds.length === 0
					? 0
					: (rows.filter((row) => (row?.total_points ?? 0) >= 5).length / eventIds.length) * 100,
			bonusPer90: minutes > 0 ? (bonus * 90) / minutes : null,
			minutes,
			gameweeks: eventIds.length,
			starts: null,
			goalsScored: null,
			assists: null,
			cleanSheets: null,
			saves: null,
			bps: null,
			expectedGoalInvolvements: null,
		};
	});
};

const metricCompositePercentile = (
	row: {
		pointsPer90: number | null;
		returnRate: number | null;
		bonusPer90: number | null;
	},
	population: Array<{
		pointsPer90: number | null;
		returnRate: number | null;
		bonusPer90: number | null;
	}>
): number | null =>
	averagePercentiles([
		percentile(
			row.pointsPer90,
			population.map((peer) => peer.pointsPer90)
		),
		percentile(
			row.returnRate,
			population.map((peer) => peer.returnRate)
		),
		percentile(
			row.bonusPer90,
			population.map((peer) => peer.bonusPer90)
		),
	]);

const metricPercentiles = (
	row: {
		pointsPer90: number | null;
		returnRate: number | null;
		bonusPer90: number | null;
	},
	population: Array<{
		pointsPer90: number | null;
		returnRate: number | null;
		bonusPer90: number | null;
	}>
): { pointsPer90: number | null; returnRate: number | null; bonusPer90: number | null } => ({
	pointsPer90: percentile(
		row.pointsPer90,
		population.map((peer) => peer.pointsPer90)
	),
	returnRate: percentile(
		row.returnRate,
		population.map((peer) => peer.returnRate)
	),
	bonusPer90: percentile(
		row.bonusPer90,
		population.map((peer) => peer.bonusPer90)
	),
});

type RadarValue = {
	value: (row: CurrentMetricRow) => number | null;
	unit: string;
	capability?: (season: string) => boolean;
};

const radarPer90 = (value: number | null, minutes: number): number | null =>
	value === null || minutes < PROCESS_MINIMUM_MINUTES ? null : (value * 90) / minutes;

const radarSpecsForPosition = (position: number): Array<{ code: string; metric: RadarValue }> => {
	const points: { code: string; metric: RadarValue } = {
		code: "FPL_POINTS_PER_90",
		metric: {
			unit: "per90",
			value: (row: CurrentMetricRow) =>
				row.minutes < PROCESS_MINIMUM_MINUTES ? null : row.pointsPer90,
		},
	};
	const cleanSheets: { code: string; metric: RadarValue } = {
		code: "FPL_CLEAN_SHEETS_PER_START",
		metric: {
			unit: "rate",
			value: (row: CurrentMetricRow) =>
				row.minutes < PROCESS_MINIMUM_MINUTES || !row.starts || row.cleanSheets === null
					? null
					: (row.cleanSheets / row.starts) * 100,
		},
	};
	const bonus: { code: string; metric: RadarValue } = {
		code: "FPL_BONUS_PER_90",
		metric: {
			unit: "per90",
			value: (row: CurrentMetricRow) =>
				row.minutes < PROCESS_MINIMUM_MINUTES ? null : row.bonusPer90,
		},
	};
	const bps: { code: string; metric: RadarValue } = {
		code: "FPL_BPS_PER_90",
		metric: {
			unit: "per90",
			value: (row: CurrentMetricRow) => radarPer90(row.bps, row.minutes),
		},
	};
	const xgi: { code: string; metric: RadarValue } = {
		code: "FPL_XGI_PER_90",
		metric: {
			unit: "per90",
			value: (row: CurrentMetricRow) => radarPer90(row.expectedGoalInvolvements, row.minutes),
			capability: expectedMetricsAvailableForSeason,
		},
	};
	if (position === 1) {
		return [
			points,
			cleanSheets,
			{
				code: "FPL_SAVES_PER_90",
				metric: {
					unit: "per90",
					value: (row: CurrentMetricRow) => radarPer90(row.saves, row.minutes),
				},
			},
			bonus,
			bps,
		];
	}
	if (position === 2) return [points, xgi, cleanSheets, bonus, bps];
	if (position === 3) {
		return [
			points,
			xgi,
			{
				code: "FPL_ATTACKING_RETURNS_PER_90",
				metric: {
					unit: "per90",
					value: (row: CurrentMetricRow) =>
						radarPer90(
							row.goalsScored === null || row.assists === null
								? null
								: row.goalsScored + row.assists,
							row.minutes
						),
				},
			},
			cleanSheets,
			bonus,
		];
	}
	return [
		points,
		xgi,
		{
			code: "FPL_GOALS_PER_90",
			metric: {
				unit: "per90",
				value: (row: CurrentMetricRow) => radarPer90(row.goalsScored, row.minutes),
			},
		},
		{
			code: "FPL_ASSISTS_PER_90",
			metric: {
				unit: "per90",
				value: (row: CurrentMetricRow) => radarPer90(row.assists, row.minutes),
			},
		},
		bonus,
	];
};

const buildPlayerRadarProfile = (
	position: number,
	season: string,
	asOfEventId: number | null,
	player: CurrentMetricRow | null,
	cohort: CurrentMetricRow[]
): PlayerRadarProfile | null => {
	if (player === null || asOfEventId === null) return null;
	const axes: PlayerRadarAxis[] = radarSpecsForPosition(position).map(({ code, metric }) => {
		const capability = metric.capability?.(season) ?? true;
		const value = capability ? metric.value(player) : null;
		const population = capability ? cohort.map((row) => metric.value(row)) : [];
		return {
			code,
			value,
			percentile: capability ? percentile(value, population) : null,
			unit: metric.unit,
			direction: "HIGHER_IS_BETTER",
			sampleMinutes: player.minutes,
			available: value !== null,
			capability,
			reasonCode:
				value !== null
					? null
					: !capability
						? "PROFILE_METRIC_CAPABILITY_UNAVAILABLE"
						: player.minutes < PROCESS_MINIMUM_MINUTES
							? "PROFILE_SAMPLE_BELOW_180_MINUTES"
							: "PROFILE_METRIC_UNAVAILABLE",
		};
	});
	return {
		source: "FPL",
		position,
		season,
		asOfEventId,
		sampleMinutes: player.minutes,
		smallSample:
			player.minutes >= PROCESS_MINIMUM_MINUTES && player.minutes < HISTORY_PLAYER_MINUTES,
		axes,
	};
};

const historyForPlayerStateRows = (
	rows: PlayerStateSeasonRow[],
	playerCode: number,
	currentSeason: string
): PlayerHistory => {
	const subjectRows = rows.filter(
		(row) => row.player_code === playerCode && row.season_code !== currentSeason
	);
	const baselineSeasons = subjectRows
		.filter(
			(row) =>
				(row.lifecycle_state === "completed" || row.lifecycle_state === "closed") &&
				row.fpl_minutes >= HISTORY_PLAYER_MINUTES
		)
		.map((row) => ({
			season: row.season_code,
			position: row.element_type,
			minutes: row.fpl_minutes,
			pointsPer90: asNumber(row.fpl_points_per_90),
			returnRate: asNumber(row.fpl_return_rate),
			bonusPer90: asNumber(row.fpl_bonus_per_90),
			positionPercentile: asNumber(row.fpl_position_percentile),
			weight: 0,
			expectedMetricsAvailable: row.expected_metrics_available,
			understatProcessPercentile: asNumber(row.understat_process_percentile),
		}));
	const careerTrajectory = baselineSeasons
		.map((season): PlayerStateCareerPoint => ({
			season: season.season,
			position: season.position,
			minutes: season.minutes,
			fplPositionPercentile: season.positionPercentile,
			understatProcessPercentile: season.understatProcessPercentile,
			expectedMetricsAvailable: season.expectedMetricsAvailable,
		}))
		.sort((left, right) => left.season.localeCompare(right.season));
	const seasons = subjectRows
		.filter((row) => row.lifecycle_state === "completed" || row.lifecycle_state === "closed")
		.map((row) => row.season_code)
		.sort()
		.reverse();
	return {
		baselineSeasons,
		careerTrajectory,
		seasons: [...new Set(seasons)],
		revision: stableHash(
			subjectRows.map((row) => [
				row.season_code,
				row.fpl_minutes,
				row.fpl_points_per_90,
				row.fpl_position_percentile,
				row.understat_process_percentile,
				row.refreshed_at,
			])
		),
		asOf: latestIso(
			subjectRows.flatMap((row) => [
				iso(row.fpl_source_updated_at),
				iso(row.understat_source_updated_at),
			])
		),
	};
};

const phaseForLifecycle = (lifecycleState: string | undefined): PlayerSeasonPhase => {
	if (lifecycleState === "preseason" || lifecycleState === "reference_only") return "PRESEASON";
	if (lifecycleState === "completed" || lifecycleState === "closed") return "COMPLETED";
	return "ACTIVE";
};

const seasonPhaseForRow = (
	row: PlayerStateSeasonRow,
	currentSeason: string,
	currentLifecycleState?: string
): PlayerSeasonPhase => {
	if (row.season_code !== currentSeason) return "COMPLETED";
	// The current-season authority is refreshed independently of the reporting
	// projection. Prefer it when both are present so a stale row cannot make a
	// newly closed or active season look like the previous phase.
	return phaseForLifecycle(currentLifecycleState ?? row.lifecycle_state);
};

const missingCurrentSeasonPhase = (lifecycleState: string | undefined): PlayerSeasonPhase => {
	return phaseForLifecycle(lifecycleState);
};

const seasonSignalUnit = (code: PlayerSeasonSignalCode): string =>
	code === "OFFICIAL_CLEAN_SHEET_RATE" ? "percent" : "per90";

const seasonSignal = (
	code: PlayerSeasonSignalCode,
	row: PlayerStateSeasonRow | null,
	phase: PlayerSeasonPhase
): PlayerSeasonSignal => {
	const provider = signalProviderForCode(code);
	const unit = seasonSignalUnit(code);
	if (phase === "PRESEASON") {
		return {
			code,
			provider,
			value: null,
			unit,
			sampleMinutes: 0,
			analysisStatus: "PRESEASON",
			reasonCodes: ["CURRENT_SEASON_PRESEASON"],
		};
	}
	if (row === null) {
		return {
			code,
			provider,
			value: null,
			unit,
			sampleMinutes: null,
			analysisStatus: "UNAVAILABLE",
			reasonCodes: ["FPL_SEASON_ROW_UNAVAILABLE"],
		};
	}
	const minimumMinutes = phase === "ACTIVE" ? PROCESS_MINIMUM_MINUTES : HISTORY_PLAYER_MINUTES;
	const isUnderstat = provider === "UNDERSTAT";
	const sampleMinutes = isUnderstat ? row.understat_minutes : row.fpl_minutes;
	if (isUnderstat && row.understat_mapping_status !== "VERIFIED") {
		return {
			code,
			provider,
			value: null,
			unit,
			sampleMinutes,
			analysisStatus: "UNAVAILABLE",
			reasonCodes: ["UNDERSTAT_MAPPING_NOT_VERIFIED"],
		};
	}
	if (
		isUnderstat &&
		(row.understat_player_id === null ||
			(row.understat_season_state !== "active" && row.understat_season_state !== "complete"))
	) {
		return {
			code,
			provider,
			value: null,
			unit,
			sampleMinutes,
			analysisStatus: "UNAVAILABLE",
			reasonCodes: ["UNDERSTAT_SEASON_DATA_UNAVAILABLE"],
		};
	}
	const sampleInsufficient = sampleMinutes === null || sampleMinutes < minimumMinutes;
	// Understat is an independent source clock.  Keep its observed per-90 values
	// visible during the small opening sample, while retaining the quality state
	// so consumers can distinguish an observation from a decision-grade sample.
	if (!isUnderstat && sampleInsufficient) {
		return {
			code,
			provider,
			value: null,
			unit,
			sampleMinutes,
			analysisStatus: "INSUFFICIENT",
			reasonCodes: [
				phase === "ACTIVE"
					? "CURRENT_SAMPLE_BELOW_180_MINUTES"
					: "HISTORY_SAMPLE_BELOW_450_MINUTES",
			],
		};
	}

	const values = understatSeasonValues(row);
	let value: number | null;
	switch (code) {
		case "UNDERSTAT_NPXG_PER_90":
			value = values.npxgPer90;
			break;
		case "UNDERSTAT_XA_PER_90":
			value = values.xaPer90;
			break;
		case "UNDERSTAT_NPXG_XA_PER_90":
			value =
				values.npxgPer90 !== null && values.xaPer90 !== null
					? values.npxgPer90 + values.xaPer90
					: null;
			break;
		case "UNDERSTAT_KEY_PASSES_PER_90":
			value = values.keyPassesPer90;
			break;
		case "OFFICIAL_CLEAN_SHEET_RATE": {
			const starts = asNumber(row.fpl_starts);
			const cleanSheets = asNumber(row.fpl_clean_sheets);
			value =
				starts !== null && starts > 0 && cleanSheets !== null ? (cleanSheets / starts) * 100 : null;
			if (value === null) {
				return {
					code,
					provider,
					value: null,
					unit,
					sampleMinutes,
					analysisStatus: "UNAVAILABLE",
					reasonCodes: ["OFFICIAL_STARTS_UNAVAILABLE"],
				};
			}
			break;
		}
		case "OFFICIAL_SAVES_PER_90": {
			const saves = asNumber(row.fpl_saves);
			value = saves !== null && row.fpl_minutes > 0 ? (saves * 90) / row.fpl_minutes : null;
			if (value === null) {
				return {
					code,
					provider,
					value: null,
					unit,
					sampleMinutes,
					analysisStatus: "UNAVAILABLE",
					reasonCodes: ["OFFICIAL_SAVES_UNAVAILABLE"],
				};
			}
			break;
		}
	}
	if (value === null) {
		return {
			code,
			provider,
			value: null,
			unit,
			sampleMinutes,
			analysisStatus: "UNAVAILABLE",
			reasonCodes: [isUnderstat ? "UNDERSTAT_METRIC_UNAVAILABLE" : "OFFICIAL_METRIC_UNAVAILABLE"],
		};
	}
	return {
		code,
		provider,
		value,
		unit,
		sampleMinutes,
		analysisStatus: sampleInsufficient ? "INSUFFICIENT" : "READY",
		reasonCodes: sampleInsufficient
			? [
					phase === "ACTIVE"
						? "CURRENT_SAMPLE_BELOW_180_MINUTES"
						: "HISTORY_SAMPLE_BELOW_450_MINUTES",
				]
			: [],
	};
};

const buildSeasonTimeline = (
	rows: PlayerStateSeasonRow[],
	playerCode: number,
	currentSeason: string,
	currentPosition: number,
	currentLifecycleState?: string
): PlayerSeasonTimelinePoint[] => {
	const subjectRows = rows.filter(
		(row) =>
			row.player_code === playerCode &&
			(row.season_code === currentSeason ||
				row.lifecycle_state === "completed" ||
				row.lifecycle_state === "closed")
	);
	const currentRow = subjectRows.find((row) => row.season_code === currentSeason) ?? null;
	const points = subjectRows.map((row): PlayerSeasonTimelinePoint => {
		const phase = seasonPhaseForRow(row, currentSeason, currentLifecycleState);
		const position = row.element_type;
		return {
			season: row.season_code,
			phase,
			position,
			fplTotalPoints: phase === "PRESEASON" ? null : (asNumber(row.fpl_total_points) ?? 0),
			signals: signalCodesForPosition(position).map((code) => seasonSignal(code, row, phase)),
		};
	});
	if (currentRow === null) {
		const phase = missingCurrentSeasonPhase(currentLifecycleState);
		points.push({
			season: currentSeason,
			phase,
			position: currentPosition,
			fplTotalPoints: null,
			signals: signalCodesForPosition(currentPosition).map((code) =>
				seasonSignal(code, null, phase)
			),
		});
	}
	return points.sort((left, right) => right.season.localeCompare(left.season));
};

const maskCurrentSeasonTimeline = (
	timeline: PlayerSeasonTimelinePoint[],
	currentSeason: string,
	status: PlayerStatsSnapshotStatus
): PlayerSeasonTimelinePoint[] => {
	if (status === "AVAILABLE") return timeline;
	const reasonCode = `FPL_CURRENT_STATS_${status}`;
	return timeline.map((point) => {
		if (point.season !== currentSeason) return point;
		return {
			...point,
			fplTotalPoints: null,
			// FPL publication status must not erase Understat observations.  The
			// providers publish on different clocks, especially while a fixture is
			// still only provisionally finished in FPL.
			signals: point.signals.map((signal) =>
				signal.provider === "UNDERSTAT"
					? signal
					: {
							...signal,
							value: null,
							analysisStatus: "UNAVAILABLE" as const,
							reasonCodes: [
								...new Set([...signal.reasonCodes, "FPL_SEASON_ROW_UNAVAILABLE", reasonCode]),
							],
						}
			),
		};
	});
};

const addUnderstatHistory = (
	history: PlayerHistory,
	processPercentiles: Map<string, number>
): PlayerHistory => {
	const baselineSeasons = history.baselineSeasons.map((season) => ({
		...season,
		understatProcessPercentile: processPercentiles.get(season.season) ?? null,
	}));
	return {
		...history,
		baselineSeasons,
		careerTrajectory: baselineSeasons
			.map((season): PlayerStateCareerPoint => ({
				season: season.season,
				position: season.position,
				minutes: season.minutes,
				fplPositionPercentile: season.positionPercentile,
				understatProcessPercentile: season.understatProcessPercentile,
				expectedMetricsAvailable: season.expectedMetricsAvailable,
			}))
			.sort((left, right) => left.season.localeCompare(right.season)),
	};
};

const toGameweekSamples = (
	eventIds: number[],
	rows: CurrentPeerGameweekRow[],
	playerId: number
): PlayerGameweekSample[] => {
	const coveredEvents = new Set(rows.map((row) => row.event_id));
	const subjectRows = new Map(
		rows.filter((row) => row.element_id === playerId).map((row) => [row.event_id, row] as const)
	);
	return [...eventIds]
		.sort((left, right) => right - left)
		.map((eventId) => {
			const row = subjectRows.get(eventId);
			const covered = coveredEvents.has(eventId);
			return {
				eventId,
				totalPoints: covered ? (row?.total_points ?? 0) : 0,
				minutes: covered ? (row?.minutes ?? 0) : 0,
				started: covered ? Boolean(row?.started) : false,
				bonus: covered ? (row?.bonus ?? 0) : 0,
				covered,
			};
		});
};

const resolveAsOfEventId = (snapshot: CoreDataSnapshot): number | null => {
	if (snapshot.currentEventId !== null) return snapshot.currentEventId;
	return (
		[...snapshot.events]
			.filter((event) => event.finished || event.isCurrent)
			.sort((left, right) => right.id - left.id)[0]?.id ?? null
	);
};

const resolveOutlookStart = (snapshot: CoreDataSnapshot, asOfEventId: number | null): number =>
	[...snapshot.events]
		.filter((event) => event.isCurrent && !event.finished)
		.sort((left, right) => left.id - right.id)[0]?.id ??
	[...snapshot.events].filter((event) => event.isNext).sort((left, right) => left.id - right.id)[0]
		?.id ??
	Math.min(38, Math.max(1, (asOfEventId ?? 0) + 1));

const buildOutlookGameweeks = (
	snapshot: CoreDataSnapshot,
	teamId: number,
	startEventId: number,
	horizon: number
): PlayerStateOutlookGameweek[] => {
	const eventIds = snapshot.events
		.map((event) => event.id)
		.filter((eventId) => eventId >= startEventId)
		.sort((left, right) => left - right)
		.slice(0, horizon);
	const teamById = new Map(snapshot.teams.map((team) => [team.id, team] as const));
	return eventIds.map((eventId) => {
		const fixtures = snapshot.fixtures
			.filter(
				(fixture) =>
					fixture.eventId === eventId && (fixture.teamHId === teamId || fixture.teamAId === teamId)
			)
			.map((fixture: CoreFixtureData) => {
				const wasHome = fixture.teamHId === teamId;
				const opponent = teamById.get(wasHome ? fixture.teamAId : fixture.teamHId);
				return {
					id: fixture.id,
					opponentTeamShortName: opponent?.shortName ?? "UNK",
					wasHome,
					difficulty: (wasHome ? fixture.teamHDifficulty : fixture.teamADifficulty) ?? 0,
					kickoffTime: fixture.kickoffTime,
				};
			});
		const difficulties = fixtures
			.map((fixture) => fixture.difficulty)
			.filter((difficulty) => difficulty >= 1 && difficulty <= 5);
		return {
			eventId,
			bgw: fixtures.length === 0,
			dgw: fixtures.length > 1,
			averageDifficulty:
				difficulties.length === 0
					? null
					: difficulties.reduce((sum, difficulty) => sum + difficulty, 0) / difficulties.length,
			fixtures,
		};
	});
};

const metric = (
	code: string,
	value: number | null,
	options: Partial<Omit<PlayerStateMetric, "code" | "value">> = {}
): PlayerStateMetric => ({
	code,
	source: options.source ?? "DERIVED",
	value,
	baseline: options.baseline ?? null,
	percentile: options.percentile ?? null,
	unit: options.unit ?? "number",
	season: options.season ?? null,
	sampleMinutes: options.sampleMinutes ?? null,
	sampleSize: options.sampleSize ?? null,
	smallSample: options.smallSample ?? false,
	capability: options.capability ?? true,
});

const unavailableProcess = (
	rating: ProcessAssessment["rating"],
	reasonCode: string
): ProcessAssessment => ({
	rating,
	direction: "UNKNOWN" as const,
	available: false,
	sampleMinutes: 0,
	smallSample: false,
	reasonCodes: [reasonCode],
	metrics: [],
});

const understatSeasonValues = (row: PlayerStateSeasonRow): UnderstatValues => ({
	npxgPer90: asNumber(row.understat_npxg_per_90),
	xaPer90: asNumber(row.understat_xa_per_90),
	shotsPer90: asNumber(row.understat_shots_per_90),
	keyPassesPer90: asNumber(row.understat_key_passes_per_90),
	xgChainPer90: asNumber(row.understat_xg_chain_per_90),
	xgBuildupPer90: asNumber(row.understat_xg_buildup_per_90),
});

const understatSeasonSubject = (row: PlayerStateSeasonRow): UnderstatCohortRow => {
	const values = understatSeasonValues(row);
	const total = (value: number | null): number =>
		value === null || row.understat_minutes === null ? 0 : (value * row.understat_minutes) / 90;
	return {
		season: row.season_code,
		season_state: row.understat_season_state ?? "planned",
		season_last_seen_at: row.understat_source_updated_at ?? row.refreshed_at,
		player_code: row.player_code,
		player_id: row.understat_player_id ?? 0,
		is_subject: true,
		minutes: row.understat_minutes ?? 0,
		position: String(row.element_type),
		non_penalty_xg: total(values.npxgPer90),
		xa: total(values.xaPer90),
		shots: total(values.shotsPer90),
		key_passes: total(values.keyPassesPer90),
		xg_chain: total(values.xgChainPer90),
		xg_buildup: total(values.xgBuildupPer90),
		source_hash: row.understat_source_hash ?? "player-state",
		updated_at: row.understat_source_updated_at ?? row.refreshed_at,
	};
};

/** Build Understat analysis from the season projection.  Peer ranks are
 * intentionally consumed from the read model; GraphQL never rebuilds a
 * provider cohort for an individual player request. */
const buildUnderstatProcessFromSeasonRows = (
	position: number,
	season: string,
	rows: PlayerStateSeasonRow[]
): UnderstatProcessResult => {
	const historyRows = rows.filter(
		(row) =>
			row.season_code < season &&
			row.understat_player_id !== null &&
			row.understat_season_state === "complete" &&
			row.understat_mapping_status === "VERIFIED"
	);
	const historyPercentiles = new Map<string, number>();
	for (const row of historyRows) {
		const value = asNumber(row.understat_process_percentile);
		if (value !== null) historyPercentiles.set(row.season_code, value);
	}
	const historySeasons = [...new Set(historyRows.map((row) => row.season_code))].sort().reverse();
	const currentRow = rows.find((row) => row.season_code === season) ?? null;
	const currentSubject =
		currentRow?.understat_player_id !== null && currentRow
			? understatSeasonSubject(currentRow)
			: null;
	if (position === 1) {
		return {
			assessment: unavailableProcess("TEAM_CONTEXT_ONLY", "PROCESS_GKP_TEAM_CONTEXT_ONLY"),
			currentSubject,
			historyPercentiles,
			historySeasons,
		};
	}
	if (currentRow === null || currentRow.understat_mapping_status !== "VERIFIED") {
		return {
			assessment: unavailableProcess("UNAVAILABLE", "PROCESS_MAPPING_UNAVAILABLE"),
			currentSubject: null,
			historyPercentiles,
			historySeasons,
		};
	}
	if (
		currentRow.understat_player_id === null ||
		(currentRow.understat_season_state !== "active" &&
			currentRow.understat_season_state !== "complete")
	) {
		return {
			assessment: unavailableProcess("UNAVAILABLE", "PROCESS_UNAVAILABLE_UNDERSTAT"),
			currentSubject,
			historyPercentiles,
			historySeasons,
		};
	}
	const sampleMinutes = currentRow.understat_minutes ?? 0;
	if (sampleMinutes < PROCESS_MINIMUM_MINUTES) {
		return {
			assessment: {
				...unavailableProcess("INSUFFICIENT", "PROCESS_SAMPLE_BELOW_180_MINUTES"),
				sampleMinutes,
				smallSample: true,
			},
			currentSubject,
			historyPercentiles,
			historySeasons,
		};
	}
	const currentPercentile = asNumber(currentRow.understat_process_percentile);
	if (currentPercentile === null) {
		return {
			assessment: {
				...unavailableProcess("UNAVAILABLE", "PROCESS_COHORT_UNAVAILABLE"),
				sampleMinutes,
			},
			currentSubject,
			historyPercentiles,
			historySeasons,
		};
	}
	const historicalSubjects = historyRows
		.filter(
			(row) => row.season_code < season && (row.understat_minutes ?? 0) >= HISTORY_PLAYER_MINUTES
		)
		.sort((left, right) => right.season_code.localeCompare(left.season_code))
		.slice(0, 3);
	const baselinePercentile = averagePercentiles(
		historicalSubjects.map((row) => historyPercentiles.get(row.season_code) ?? null)
	);
	const direction =
		baselinePercentile === null
			? "UNKNOWN"
			: currentPercentile - baselinePercentile >= 15
				? "RISING"
				: currentPercentile - baselinePercentile <= -15
					? "FALLING"
					: "STABLE";
	const rating = currentPercentile >= 70 ? "STRONG" : currentPercentile >= 30 ? "TYPICAL" : "WEAK";
	const values = understatSeasonValues(currentRow);
	const historicalValues = historicalSubjects.map(understatSeasonValues);
	const specs: Array<{
		code: string;
		value: keyof UnderstatValues;
		percentile: number | string | null;
	}> = [
		{
			code: "UNDERSTAT_NPXG_PER_90",
			value: "npxgPer90",
			percentile: currentRow.understat_npxg_percentile,
		},
		{
			code: "UNDERSTAT_XA_PER_90",
			value: "xaPer90",
			percentile: currentRow.understat_xa_percentile,
		},
		{
			code: "UNDERSTAT_SHOTS_PER_90",
			value: "shotsPer90",
			percentile: currentRow.understat_shots_percentile,
		},
		{
			code: "UNDERSTAT_KEY_PASSES_PER_90",
			value: "keyPassesPer90",
			percentile: currentRow.understat_key_passes_percentile,
		},
		{
			code: "UNDERSTAT_XG_CHAIN_PER_90",
			value: "xgChainPer90",
			percentile: currentRow.understat_xg_chain_percentile,
		},
		{
			code: "UNDERSTAT_XG_BUILDUP_PER_90",
			value: "xgBuildupPer90",
			percentile: currentRow.understat_xg_buildup_percentile,
		},
	];
	const metrics = specs.map(({ code, value, percentile: rank }) =>
		metric(code, values[value], {
			source: "UNDERSTAT_CURRENT",
			baseline:
				historicalValues.length === 0
					? null
					: averagePercentiles(historicalValues.map((candidate) => candidate[value])),
			percentile: asNumber(rank),
			unit: "per90",
			season,
			sampleMinutes,
			sampleSize: currentRow.understat_peer_count,
			smallSample: sampleMinutes < HISTORY_PLAYER_MINUTES,
		})
	);
	return {
		assessment: {
			rating,
			direction,
			available: true,
			sampleMinutes,
			smallSample: sampleMinutes < HISTORY_PLAYER_MINUTES,
			reasonCodes: [
				rating === "STRONG"
					? "PROCESS_STRONG"
					: rating === "TYPICAL"
						? "PROCESS_TYPICAL"
						: "PROCESS_WEAK",
				direction === "UNKNOWN" ? "PROCESS_BASELINE_UNAVAILABLE" : `PROCESS_${direction}`,
			],
			metrics,
		},
		currentSubject,
		historyPercentiles,
		historySeasons,
	};
};

export interface PlayerStateRepository {
	getPlayerStateProfile(
		context: GraphQLContext,
		playerId: number,
		horizon: number
	): Promise<PlayerStateProfile | null>;
	getPlayerStateProfiles(
		context: GraphQLContext,
		playerIds: number[],
		horizon: number
	): Promise<Map<number, PlayerStateProfile | null>>;
}

export const createPlayerStateRepository = (
	dependencies: PlayerStateRepositoryDependencies = {}
): PlayerStateRepository => ({
	async getPlayerStateProfiles(
		context: GraphQLContext,
		playerIds: number[],
		horizon: number
	): Promise<Map<number, PlayerStateProfile | null>> {
		const uniqueIds = Array.from(
			new Set(playerIds.filter((id) => Number.isSafeInteger(id) && id > 0))
		);
		const safeHorizon = Number.isSafeInteger(horizon) ? Math.min(8, Math.max(1, horizon)) : 5;
		if (uniqueIds.length === 0) return new Map();
		const executor = dependencies.executor ?? context.database;
		const datasetRevision = await loadDatasetRevision(context, executor);
		const cacheKeys = uniqueIds.map((playerId) =>
			profileCacheKey(context, datasetRevision.revision, playerId, safeHorizon)
		);
		await readProfileCaches(context, cacheKeys);
		const cacheMemo = requestProfileCacheMemo(context);
		const missingIds = uniqueIds.filter(
			(playerId) =>
				cacheMemo.get(profileCacheKey(context, datasetRevision.revision, playerId, safeHorizon)) ===
				undefined
		);
		if (missingIds.length === 0) {
			return new Map(
				uniqueIds.map((playerId) => [
					playerId,
					cacheMemo.get(
						profileCacheKey(context, datasetRevision.revision, playerId, safeHorizon)
					) ?? null,
				])
			);
		}
		const loadSnapshot = dependencies.loadCoreSnapshot ?? getCoreDataSnapshot;
		const snapshot = await loadSnapshot(context);
		const selectedPlayers = snapshot.players.filter((player) => missingIds.includes(player.id));
		const shared = await loadSharedProfileData(
			context,
			executor,
			selectedPlayers.map((player) => player.code),
			selectedPlayers.map((player) => player.id),
			context.currentSeason.seasonId
		);
		const scope = context.requestScope ?? context;
		let preload = profilePreloadMemo.get(scope);
		if (!preload) {
			preload = new Map();
			profilePreloadMemo.set(scope, preload);
		}
		for (const playerId of missingIds) {
			preload.set(playerId, { snapshot, shared, datasetRevision, executor });
		}
		let profiles: Array<PlayerStateProfile | null>;
		try {
			profiles = await Promise.all(
				missingIds.map((playerId) => this.getPlayerStateProfile(context, playerId, safeHorizon))
			);
		} finally {
			for (const playerId of missingIds) preload.delete(playerId);
		}
		return new Map(
			uniqueIds.map((playerId) => [
				playerId,
				missingIds.includes(playerId)
					? (profiles[missingIds.indexOf(playerId)] ?? null)
					: (cacheMemo.get(
							profileCacheKey(context, datasetRevision.revision, playerId, safeHorizon)
						) ?? null),
			])
		);
	},
	async getPlayerStateProfile(
		context: GraphQLContext,
		playerId: number,
		horizon: number
	): Promise<PlayerStateProfile | null> {
		if (!Number.isSafeInteger(playerId) || playerId <= 0) return null;
		const safeHorizon = Number.isSafeInteger(horizon) ? Math.min(8, Math.max(1, horizon)) : 5;
		const preload = profilePreloadMemo.get(context.requestScope ?? context)?.get(playerId);
		const executor = preload?.executor ?? dependencies.executor ?? context.database;
		const datasetRevision =
			preload?.datasetRevision ?? (await loadDatasetRevision(context, executor));
		const key = profileCacheKey(context, datasetRevision.revision, playerId, safeHorizon);
		const cached = await readProfileCache(context, key);
		if (cached !== undefined) return cached;

		const loadSnapshot = dependencies.loadCoreSnapshot ?? getCoreDataSnapshot;
		const snapshot = preload?.snapshot ?? (await loadSnapshot(context));
		const statsContext = await (dependencies.resolveStatsContext ?? resolvePlayerStatsContext)(
			context
		);
		const player = snapshot.players.find((candidate) => candidate.id === playerId);
		if (!player) {
			await writeNullCache(context, key);
			return null;
		}
		const seasonId = context.currentSeason.seasonId;
		const season = context.currentSeason.seasonCode;
		const asOfEventId = statsContext.asOfEventId ?? resolveAsOfEventId(snapshot);
		const startedEventIds = snapshot.events
			.filter(
				(event) =>
					asOfEventId !== null && event.id <= asOfEventId && (event.finished || event.isCurrent)
			)
			.map((event) => event.id)
			.sort((left, right) => right - left)
			.slice(0, 10)
			.sort((left, right) => left - right);

		const shared =
			preload?.shared ??
			(await loadSharedProfileData(context, executor, [player.code], [player.id], seasonId));
		const currentMarket = shared.marketById.get(playerId) ?? null;
		const seasonRows = shared.seasonRowsByCode.get(player.code) ?? [];
		const currentCohortRows: CurrentCohort =
			statsContext.status === "AVAILABLE"
				? await loadCurrentCohort(
						context,
						executor,
						seasonId,
						player.type,
						asOfEventId !== null,
						startedEventIds
					)
				: { peerRows: [], gameweekRows: [] };
		const currentRow = seasonRows.find((row) => row.season_code === season) ?? null;
		const mappingStatus = (currentRow?.understat_mapping_status ??
			"UNAVAILABLE") as PlayerStateMappingStatus;
		const processResult = buildUnderstatProcessFromSeasonRows(player.type, season, seasonRows);
		const history = addUnderstatHistory(
			historyForPlayerStateRows(seasonRows, player.code, season),
			processResult.historyPercentiles
		);
		const seasonTimeline = maskCurrentSeasonTimeline(
			buildSeasonTimeline(
				seasonRows,
				player.code,
				season,
				player.type,
				context.currentSeason.lifecycleState
			),
			season,
			statsContext.status
		);
		const samples = toGameweekSamples(startedEventIds, currentCohortRows.gameweekRows, playerId);
		const recentWindow = samples.slice(0, 5);
		const previousWindow = samples.slice(5, 10);
		const recentSamples = recentWindow.filter((sample) => sample.covered);
		const previousSamples = previousWindow.filter((sample) => sample.covered);
		const recentEventIds = recentWindow.map((sample) => sample.eventId);
		const recentWindowComplete =
			recentWindow.length === 5 && recentWindow.every((sample) => sample.covered);
		const role = assessRole(recentSamples, previousSamples);
		const market = currentMarket;
		const marketCapturedAt = iso(market?.captured_at ?? null);
		const availability = assessAvailability(
			market === null
				? null
				: {
						status: market.status,
						chanceOfPlayingThisRound: market.chance_this_round,
						stale:
							(freshness(marketCapturedAt) ?? Number.POSITIVE_INFINITY) >
							PLAYER_STATE_FRESHNESS_STALE_SECONDS,
					}
		);

		const allCurrentRows = currentMetrics(currentCohortRows.peerRows);
		const currentCohort = allCurrentRows.filter((row) => row.minutes >= CURRENT_PEER_MINUTES);
		const currentSubject = allCurrentRows.find((row) => row.elementId === playerId) ?? null;
		const currentPlayer =
			currentSubject !== null && currentSubject.minutes >= CURRENT_PEER_MINUTES
				? currentSubject
				: null;
		const currentPercentile = currentPlayer
			? metricCompositePercentile(currentPlayer, currentCohort)
			: null;
		const peerIds = currentCohort.map((row) => row.elementId);
		const recentRows = recentMetrics(peerIds, currentCohortRows.gameweekRows, recentEventIds);
		const recentPlayer = recentRows.find((row) => row.elementId === playerId) ?? null;
		const recentPercentile = recentPlayer
			? metricCompositePercentile(recentPlayer, recentRows)
			: null;
		const recentMetricRanks = recentPlayer ? metricPercentiles(recentPlayer, recentRows) : null;
		const profileRadar = buildPlayerRadarProfile(
			player.type,
			season,
			asOfEventId,
			currentSubject,
			currentCohort
		);
		const reliability = assessReliability(history.baselineSeasons, currentSubject?.minutes ?? 0);
		const output = assessOutput({
			currentPercentile,
			recentPercentile,
			seasonBaselinePercentile: currentPercentile,
			ownBaselinePercentile: reliability.baseline.weightedPercentile,
		});
		const process = processResult.assessment;
		const fplSufficient =
			statsContext.status === "AVAILABLE" &&
			recentSamples.length >= MINIMUM_CURRENT_GAMEWEEKS &&
			recentWindowComplete &&
			currentPlayer !== null &&
			currentPercentile !== null &&
			recentPercentile !== null;
		const composed = composePlayerState({
			availability,
			role,
			output,
			process,
			fplSufficient,
			completeFplWindow: recentWindowComplete,
			historySeasonCount: reliability.baseline.seasons.length,
		});
		const evidenceDecision = applyPlayerStateEvidencePolicy(composed.trend, process.available);

		const outlookStart = resolveOutlookStart(snapshot, asOfEventId);
		const outlookGameweeks = buildOutlookGameweeks(
			snapshot,
			player.teamId,
			outlookStart,
			safeHorizon
		);
		const outlook = assessOutlook(outlookGameweeks, outlookGameweeks.length);
		const dgwCount = outlook.gameweeks.filter((gameweek) => gameweek.dgw).length;
		const bgwCount = outlook.gameweeks.filter((gameweek) => gameweek.bgw).length;
		const outlookCoverageComplete = outlook.gameweeks.length === safeHorizon;
		const outlookReasons = [
			outlook.rating === "FAVOURABLE"
				? "OUTLOOK_FAVOURABLE"
				: outlook.rating === "DIFFICULT"
					? "OUTLOOK_DIFFICULT"
					: "OUTLOOK_NEUTRAL",
			...(dgwCount > 0 ? ["OUTLOOK_DGW"] : []),
			...(bgwCount > 0 ? ["OUTLOOK_BGW"] : []),
			...(!outlookCoverageComplete ? ["OUTLOOK_FIXTURE_COVERAGE_UNKNOWN"] : []),
		];

		const outputMetrics: PlayerStateMetric[] = [
			metric("FPL_POINTS_PER_90", recentPlayer?.pointsPer90 ?? null, {
				source: "FPL_CURRENT",
				baseline: currentPlayer?.pointsPer90 ?? null,
				percentile: recentMetricRanks?.pointsPer90 ?? null,
				unit: "per90",
				season,
				sampleMinutes: recentPlayer?.minutes ?? 0,
				sampleSize: recentSamples.length,
			}),
			metric("FPL_RETURN_RATE", recentPlayer?.returnRate ?? null, {
				source: "FPL_CURRENT",
				baseline: currentPlayer?.returnRate ?? null,
				percentile: recentMetricRanks?.returnRate ?? null,
				unit: "percent",
				season,
				sampleMinutes: recentPlayer?.minutes ?? 0,
				sampleSize: recentSamples.length,
			}),
			metric("FPL_BONUS_PER_90", recentPlayer?.bonusPer90 ?? null, {
				source: "FPL_CURRENT",
				baseline: currentPlayer?.bonusPer90 ?? null,
				percentile: recentMetricRanks?.bonusPer90 ?? null,
				unit: "per90",
				season,
				sampleMinutes: recentPlayer?.minutes ?? 0,
				sampleSize: recentSamples.length,
			}),
			metric("FPL_OUTPUT_PERCENTILE", currentPercentile, {
				source: "DERIVED",
				baseline: output.baselinePercentile,
				percentile: currentPercentile,
				unit: "percentile",
				season,
				sampleMinutes: currentPlayer?.minutes ?? 0,
			}),
		];

		const dimensions: PlayerStateDimension[] = [
			{
				kind: "AVAILABILITY_ROLE",
				rating: availability.unavailable ? "UNAVAILABLE" : role.rating,
				direction: role.direction,
				confidence:
					availability.authoritative && !availability.stale
						? recentWindowComplete
							? "HIGH"
							: "MEDIUM"
						: "LOW",
				reasonCodes: [availability.reasonCode, ...role.reasonCodes],
				metrics: [
					metric("ROLE_STARTS_LAST_5", role.starts, {
						source: "FPL_CURRENT",
						unit: "count",
						season,
						sampleSize: recentSamples.length,
					}),
					metric("ROLE_MEDIAN_STARTER_MINUTES", role.medianStarterMinutes, {
						source: "FPL_CURRENT",
						unit: "minutes",
						season,
						sampleSize: recentSamples.length,
					}),
					metric("AVAILABILITY_CHANCE", availability.chance, {
						source: "FPL_CURRENT",
						unit: "percent",
						season,
						capability: availability.authoritative,
					}),
				],
			},
			{
				kind: "FPL_OUTPUT",
				rating: output.rating,
				direction: output.direction,
				confidence: fplSufficient && recentWindowComplete ? "HIGH" : "LOW",
				reasonCodes: output.reasonCodes,
				metrics: outputMetrics,
			},
			{
				kind: "REAL_WORLD_PROCESS",
				rating: process.rating,
				direction: process.direction,
				confidence: process.available ? (process.smallSample ? "MEDIUM" : "HIGH") : "LOW",
				reasonCodes: process.reasonCodes,
				metrics: process.metrics,
			},
			{
				kind: "HISTORICAL_RELIABILITY",
				rating: reliability.rating,
				direction: reliability.direction,
				confidence: reliability.baseline.seasons.length >= 2 ? "HIGH" : "LOW",
				reasonCodes: reliability.reasonCodes,
				metrics: [
					metric("OWN_BASELINE_PERCENTILE", reliability.baseline.weightedPercentile, {
						source: "FPL_HISTORY",
						unit: "percentile",
						sampleSize: reliability.baseline.seasons.length,
					}),
				],
			},
			{
				kind: "OUTLOOK",
				rating: outlook.rating,
				direction: "STABLE",
				confidence: outlookCoverageComplete ? "HIGH" : "LOW",
				reasonCodes: outlookReasons,
				metrics: [
					metric("OUTLOOK_AVERAGE_FDR", outlook.averageDifficulty, {
						source: "FPL_CURRENT",
						unit: "fdr",
						season,
						sampleSize: outlook.gameweeks.length,
					}),
					metric("OUTLOOK_DGW_COUNT", dgwCount, {
						source: "FPL_CURRENT",
						unit: "count",
						season,
					}),
					metric("OUTLOOK_BGW_COUNT", bgwCount, {
						source: "FPL_CURRENT",
						unit: "count",
						season,
					}),
				],
			},
		];

		const limitations = new Set<string>();
		if (!fplSufficient) limitations.add("CURRENT_FPL_INSUFFICIENT");
		if (evidenceDecision.withheld && evidenceDecision.reasonCode) {
			limitations.add(evidenceDecision.reasonCode);
		}
		if (recentWindow.length > 0 && recentWindow.length < 5) {
			limitations.add("EARLY_SEASON_SAMPLE");
		}
		if (recentWindow.length === 5 && !recentWindowComplete) {
			limitations.add("CURRENT_FPL_COVERAGE_INCOMPLETE");
		}
		if (!outlookCoverageComplete) limitations.add("OUTLOOK_FIXTURE_COVERAGE_UNKNOWN");
		if (!process.available) {
			limitations.add(
				player.type === 1 ? "GKP_PERSONAL_PROCESS_UNAVAILABLE" : "REAL_WORLD_PROCESS_UNAVAILABLE"
			);
		}
		if (history.careerTrajectory.some((point) => !point.expectedMetricsAvailable)) {
			limitations.add("OLD_FPL_EXPECTED_METRICS_MASKED");
		}

		const understatAsOf = latestIso([
			iso(processResult.currentSubject?.updated_at ?? null),
			iso(processResult.currentSubject?.season_last_seen_at ?? null),
		]);
		const asOf =
			latestIso([
				statsContext.sourceCheckedAt,
				snapshot.sourceCheckedAt,
				marketCapturedAt,
				understatAsOf,
				datasetRevision.refreshedAt,
			]) ?? new Date(0).toISOString();
		const fplCurrentAvailable = statsContext.status === "AVAILABLE" && currentRow !== null;
		const currentLifecycleState =
			context.currentSeason.lifecycleState ?? currentRow?.lifecycle_state;
		const fplCurrentAnalysis: PlayerStateAnalysisStatus =
			statsContext.status === "PRESEASON"
				? "PRESEASON"
				: statsContext.status !== "AVAILABLE" || currentRow === null
					? "UNAVAILABLE"
					: currentLifecycleState === "preseason" || currentLifecycleState === "reference_only"
						? "PRESEASON"
						: fplSufficient
							? "READY"
							: "INSUFFICIENT";
		const understatCurrentAvailable =
			currentRow?.understat_mapping_status === "VERIFIED" &&
			currentRow.understat_player_id !== null &&
			(currentRow.understat_season_state === "active" ||
				currentRow.understat_season_state === "complete") &&
			processResult.currentSubject !== null;
		const understatHistoryAvailable = processResult.historySeasons.length > 0;
		const understatCurrentReasonCodes = understatCurrentAvailable
			? processResult.assessment.available || player.type === 1
				? []
				: processResult.assessment.reasonCodes
			: currentRow === null
				? ["UNDERSTAT_CURRENT_NO_SEASON_ROW"]
				: mappingStatus !== "VERIFIED"
					? [`UNDERSTAT_CURRENT_MAPPING_${mappingStatus}`]
					: ["UNDERSTAT_CURRENT_DATA_UNAVAILABLE"];
		const sources: PlayerStateSourceCoverage[] = [
			sourceCoverage({
				provider: "FPL",
				scope: "CURRENT",
				seasons: fplCurrentAvailable ? [season] : [],
				revision: statsContext.revision,
				asOf: statsContext.sourceCheckedAt,
				dataStatus: fplCurrentAvailable ? "AVAILABLE" : "UNAVAILABLE",
				analysisStatus: fplCurrentAnalysis,
				mappingStatus: "NOT_APPLICABLE",
				reasonCodes:
					fplCurrentAnalysis === "PRESEASON"
						? ["FPL_CURRENT_PRESEASON"]
						: fplCurrentAnalysis === "UNAVAILABLE"
							? [`FPL_CURRENT_STATS_${statsContext.status}`]
							: fplSufficient
								? []
								: ["FPL_CURRENT_INSUFFICIENT"],
			}),
			sourceCoverage({
				provider: "FPL",
				scope: "HISTORY",
				seasons: history.seasons,
				revision: datasetRevision.revision,
				asOf: history.asOf,
				dataStatus: "AVAILABLE",
				analysisStatus: history.baselineSeasons.length > 0 ? "READY" : "INSUFFICIENT",
				mappingStatus: "NOT_APPLICABLE",
				reasonCodes: history.seasons.length === 0 ? ["FPL_HISTORY_NO_PLAYER_SEASONS"] : [],
			}),
			sourceCoverage({
				provider: "UNDERSTAT",
				scope: "CURRENT",
				seasons: understatCurrentAvailable ? [season] : [],
				revision: currentRow?.understat_source_hash ?? null,
				asOf: understatAsOf,
				dataStatus: understatCurrentAvailable ? "AVAILABLE" : "UNAVAILABLE",
				analysisStatus:
					understatCurrentAvailable && player.type === 1
						? "NOT_APPLICABLE"
						: understatCurrentAvailable
							? process.available
								? "READY"
								: process.rating === "INSUFFICIENT"
									? "INSUFFICIENT"
									: "UNAVAILABLE"
							: "UNAVAILABLE",
				mappingStatus,
				reasonCodes: understatCurrentReasonCodes,
			}),
			sourceCoverage({
				provider: "UNDERSTAT",
				scope: "HISTORY",
				seasons: processResult.historySeasons,
				revision: understatHistoryAvailable ? datasetRevision.revision : null,
				asOf: understatHistoryAvailable ? history.asOf : null,
				dataStatus: understatHistoryAvailable ? "AVAILABLE" : "UNAVAILABLE",
				analysisStatus:
					player.type === 1
						? "NOT_APPLICABLE"
						: understatHistoryAvailable
							? "READY"
							: "INSUFFICIENT",
				mappingStatus: understatHistoryAvailable ? "VERIFIED" : mappingStatus,
				reasonCodes: understatHistoryAvailable ? [] : ["UNDERSTAT_HISTORY_NO_VERIFIED_SEASONS"],
			}),
		];
		const providerMode: PlayerStateProviderMode = understatCurrentAvailable
			? "FPL_WITH_UNDERSTAT_CURRENT"
			: understatHistoryAvailable
				? "FPL_WITH_UNDERSTAT_HISTORY"
				: "FPL_ONLY";
		const metricCoverage = dimensions
			.flatMap((dimension) => dimension.metrics)
			.filter((candidate) => candidate.capability && candidate.value !== null)
			.map((candidate) => candidate.code);
		const profile: PlayerStateProfile = {
			playerId,
			playerCode: player.code,
			teamId: player.teamId,
			position: player.type,
			season,
			horizon: outlook.gameweeks.length,
			asOfEventId,
			asOf,
			trend: evidenceDecision.trend,
			confidence: evidenceDecision.withheld ? "LOW" : composed.confidence,
			providerMode,
			reasons:
				evidenceDecision.withheld && evidenceDecision.reasonCode
					? [
							{
								code: evidenceDecision.reasonCode,
								dimension: "FPL_OUTPUT",
								current: output.recentPercentile,
								baseline: output.baselinePercentile,
								percentile: output.currentPercentile,
							},
							...composed.reasons.filter((reason) => reason.code === "FPL_ONLY"),
						]
					: composed.reasons,
			profileRadar,
			dimensions,
			ownBaseline: reliability.baseline,
			peerBaseline: {
				position: player.type,
				minimumMinutes: HISTORY_PEER_MINUTES,
				cohortSize: currentCohort.length,
				currentPercentile,
			},
			careerTrajectory: history.careerTrajectory,
			outlook,
			seasonTimeline,
			coverage: {
				sources,
				metricCoverage: [...new Set(metricCoverage)],
				limitations: [...limitations],
			},
		};
		await writeProfileCache(context, key, profile);
		return profile;
	},
});

export const playerStateRepository = createPlayerStateRepository();
