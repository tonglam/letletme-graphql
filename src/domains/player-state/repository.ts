import { createHash } from "node:crypto";
import type { QueryResultRow } from "pg";
import type { GraphQLContext } from "../../graphql/context";
import { gqlCacheKey } from "../../infra/cache-key";
import type { QueryExecutor as DatabaseQueryExecutor } from "../../infra/database";
import {
	getCoreDataSnapshot,
	type CoreDataSnapshot,
	type CoreFixtureData,
} from "../../infra/data-snapshot";
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
import {
	buildPlayerStateProviderRevision,
	confirmedPlayerLinkSeasons,
	PLAYER_STATE_FRESHNESS_STALE_SECONDS,
	resolvePlayerStateMappingStatus,
	type ProviderLinkRow,
} from "./coverage";
import { applyPlayerStateEvidencePolicy } from "./trend-evidence-policy";
import type {
	PlayerGameweekSample,
	PlayerRadarAxis,
	PlayerRadarProfile,
	PlayerStateBaselineSeason,
	PlayerStateCareerPoint,
	PlayerStateCoverage,
	PlayerStateDimension,
	PlayerStateMetric,
	PlayerStateOutlookGameweek,
	PlayerStateProfile,
	PlayerStateProviderRevision,
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
const PROCESS_PEER_MINUTES = 450;

export type QueryExecutor = DatabaseQueryExecutor;

type PlayerStateRepositoryDependencies = Readonly<{
	executor?: QueryExecutor;
	loadCoreSnapshot?: (context: GraphQLContext) => Promise<CoreDataSnapshot>;
}>;

type MarketRow = QueryResultRow & {
	status: string;
	chance_this_round: number | null;
	captured_at: Date | string;
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

type HistoricalCohortRow = QueryResultRow & {
	season: string;
	player_code: number;
	position: number;
	minutes: number | null;
	total_points: number | null;
	bonus: number | null;
	return_count: string | number | null;
	gameweek_count: string | number | null;
	as_of: Date | string | null;
};

type HistoricalMetricRow = {
	season: string;
	playerCode: number;
	position: number;
	minutes: number;
	pointsPer90: number | null;
	returnRate: number | null;
	bonusPer90: number | null;
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

const marketSql = `
	/* player-state:market */
	SELECT status, chance_of_playing_this_round AS chance_this_round, captured_at
	FROM fpl.player_market_snapshots
	WHERE season_id = $1 AND element_id = $2
	ORDER BY snapshot_date DESC, captured_at DESC
	LIMIT 1
`;

const currentPeersSql = `
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

const currentPeerGameweeksSql = `
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

const historicalCohortsSql = `
	/* player-state:fpl-history */
	WITH requested AS MATERIALIZED (
		SELECT season.season_id, season.season_code, subject.element_type AS position
		FROM fpl.seasons season
		JOIN fpl.players subject
			ON subject.season_id = season.season_id
			AND subject.code = $1
		WHERE season.lifecycle_state = 'completed'
	)
	SELECT
		requested.season_code AS season,
		player.code AS player_code,
		player.element_type AS position,
		COALESCE(summary.minutes, 0)::integer AS minutes,
		COALESCE(summary.total_points, 0)::integer AS total_points,
		COALESCE(summary.bonus, 0)::integer AS bonus,
		COALESCE(summary.return_count, 0)::integer AS return_count,
		COALESCE(summary.gameweeks_available, 0)::integer AS gameweek_count,
		GREATEST(player.updated_at, summary.source_updated_at) AS as_of
	FROM requested
	JOIN fpl.players player
		ON player.season_id = requested.season_id
		AND player.element_type = requested.position
	LEFT JOIN reporting.player_season_summary_rows summary
		ON summary.season_id = player.season_id
		AND summary.element_id = player.element_id
	ORDER BY requested.season_code, player.code
`;

const verifiedProviderLinkSql = `
	/* player-state:provider-link-verified */
	SELECT status::text, rule_id, left_entity_id, evidence
	FROM bridge.entity_links
	WHERE entity_type = 'player'
		AND left_provider = 'understat'
		AND right_provider = 'fpl'
		AND right_entity_id = $1
		AND status IN ('auto_verified', 'manual_verified')
	LIMIT 1
`;

const unresolvedProviderLinkSql = `
	/* player-state:provider-link-unresolved */
	SELECT status::text, rule_id, left_entity_id, evidence
	FROM bridge.entity_links
	WHERE entity_type = 'player'
		AND left_provider = 'understat'
		AND right_provider = 'fpl'
		AND right_entity_id = $1
		AND status NOT IN ('auto_verified', 'manual_verified')
	ORDER BY CASE status::text
		WHEN 'quarantined' THEN 1
		WHEN 'ambiguous' THEN 2
		ELSE 3
	END, updated_at DESC, created_at DESC
	LIMIT 1
`;

const understatCohortsSql = `
	/* player-state:understat-cohorts */
	WITH requested AS MATERIALIZED (
		SELECT season.season_id, season.season_code, subject.element_type AS position
		FROM fpl.seasons season
		JOIN fpl.players subject
			ON subject.season_id = season.season_id
			AND subject.code = $1
		WHERE season.season_code = ANY($2::text[])
	), linked_peers AS MATERIALIZED (
		SELECT
			requested.season_code,
			player.code AS player_code,
			CASE
				WHEN link.left_entity_id ~ '^[0-9]+$' THEN link.left_entity_id::integer
			END AS player_id
		FROM requested
		JOIN fpl.players player
			ON player.season_id = requested.season_id
			AND player.element_type = requested.position
		JOIN bridge.entity_links link
			ON link.entity_type = 'player'
			AND link.left_provider = 'understat'
			AND link.right_provider = 'fpl'
			AND link.right_entity_id = player.code::text
			AND link.status IN ('auto_verified', 'manual_verified')
			AND link.evidence -> 'confirmedSeasons' ? requested.season_code
	)
	SELECT
		linked.season_code AS season,
		provider_season.state::text AS season_state,
		provider_season.last_seen_at AS season_last_seen_at,
		linked.player_code,
		metrics.player_id,
		(linked.player_code = $1) AS is_subject,
		metrics.time_minutes AS minutes,
		metrics.position,
		metrics.non_penalty_xg,
		metrics.xa,
		metrics.shots,
		metrics.key_passes,
		metrics.xg_chain,
		metrics.xg_buildup,
		metrics.source_hash,
		metrics.updated_at
	FROM linked_peers linked
	JOIN understat.player_seasons metrics
		ON metrics.season_code = linked.season_code
		AND metrics.player_id = linked.player_id
	JOIN understat.seasons provider_season
		ON provider_season.season_code = metrics.season_code
	WHERE linked.player_id IS NOT NULL
	ORDER BY linked.season_code, linked.player_code
`;

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

const asInt = (value: unknown): number | null => {
	const parsed = asNumber(value);
	return parsed === null ? null : Math.trunc(parsed);
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

const profileGuard = (value: unknown): value is PlayerStateProfile =>
	isRecord(value) &&
	typeof value.playerId === "number" &&
	typeof value.playerCode === "number" &&
	typeof value.season === "string" &&
	typeof value.trend === "string" &&
	Array.isArray(value.dimensions) &&
	isRecord(value.coverage);

const profileCacheKey = (context: GraphQLContext, playerId: number, horizon: number): string =>
	gqlCacheKey(context, `player-state-profile:${playerId}:${horizon}`);

const profileCacheReadMemo = new WeakMap<
	object,
	Map<string, PlayerStateProfile | null | undefined>
>();

type CurrentCohort = Readonly<{
	peerRows: CurrentPeerRow[];
	gameweekRows: CurrentPeerGameweekRow[];
}>;

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
			: executor.query<CurrentPeerRow>(currentPeersSql, [seasonId, position]),
		eventIds.length === 0
			? Promise.resolve({ rows: [] as CurrentPeerGameweekRow[] })
			: executor.query<CurrentPeerGameweekRow>(currentPeerGameweeksSql, [
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

const historicalMetric = (row: HistoricalCohortRow): HistoricalMetricRow | null => {
	const minutes = asInt(row.minutes);
	const totalPoints = asNumber(row.total_points);
	const bonus = asNumber(row.bonus);
	const returnCount = asNumber(row.return_count);
	const gameweekCount = asNumber(row.gameweek_count);
	if (minutes === null) return null;
	return {
		season: row.season,
		playerCode: row.player_code,
		position: row.position,
		minutes,
		pointsPer90: minutes > 0 && totalPoints !== null ? (totalPoints * 90) / minutes : null,
		returnRate:
			returnCount !== null && gameweekCount !== null && gameweekCount > 0
				? (returnCount / gameweekCount) * 100
				: null,
		bonusPer90: minutes > 0 && bonus !== null ? (bonus * 90) / minutes : null,
	};
};

const historyForPlayer = (rows: HistoricalCohortRow[], playerCode: number): PlayerHistory => {
	const metrics = rows
		.map(historicalMetric)
		.filter((row): row is HistoricalMetricRow => row !== null);
	const selected = metrics.filter(
		(row) => row.playerCode === playerCode && row.minutes >= HISTORY_PLAYER_MINUTES
	);
	const baselineSeasons: PlayerStateBaselineSeason[] = selected.map((row) => {
		const peers = metrics.filter(
			(peer) =>
				peer.season === row.season &&
				peer.position === row.position &&
				peer.minutes >= HISTORY_PEER_MINUTES
		);
		return {
			season: row.season,
			position: row.position,
			minutes: row.minutes,
			pointsPer90: row.pointsPer90,
			returnRate: row.returnRate,
			bonusPer90: row.bonusPer90,
			positionPercentile: metricCompositePercentile(row, peers),
			weight: 0,
			expectedMetricsAvailable: expectedMetricsAvailableForSeason(row.season),
			understatProcessPercentile: null,
		};
	});
	const careerTrajectory = baselineSeasons
		.map((season): PlayerStateCareerPoint => ({
			season: season.season,
			position: season.position,
			minutes: season.minutes,
			fplPositionPercentile: season.positionPercentile,
			understatProcessPercentile: null,
			expectedMetricsAvailable: season.expectedMetricsAvailable,
		}))
		.sort((left, right) => left.season.localeCompare(right.season));
	const seasons = [
		...new Set(metrics.filter((row) => row.playerCode === playerCode).map((row) => row.season)),
	]
		.sort()
		.reverse();
	const asOf = latestIso(rows.map((row) => iso(row.as_of)));
	return {
		baselineSeasons,
		careerTrajectory,
		seasons,
		revision: stableHash(
			rows.map((row) => [
				row.season,
				row.player_code,
				row.minutes,
				row.total_points,
				row.bonus,
				row.return_count,
				row.gameweek_count,
				iso(row.as_of),
			])
		),
		asOf,
	};
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

const per90 = (value: unknown, minutes: number): number | null => {
	const number = asNumber(value);
	return number === null || minutes <= 0 ? null : (number * 90) / minutes;
};

const understatValues = (row: UnderstatCohortRow): UnderstatValues => ({
	npxgPer90: per90(row.non_penalty_xg, row.minutes),
	xaPer90: per90(row.xa, row.minutes),
	shotsPer90: per90(row.shots, row.minutes),
	keyPassesPer90: per90(row.key_passes, row.minutes),
	xgChainPer90: per90(row.xg_chain, row.minutes),
	xgBuildupPer90: per90(row.xg_buildup, row.minutes),
});

const understatCompositePercentile = (
	row: UnderstatCohortRow,
	cohort: UnderstatCohortRow[]
): number | null => {
	const subject = understatValues(row);
	const peers = cohort.map(understatValues);
	return averagePercentiles([
		percentile(
			subject.npxgPer90,
			peers.map((peer) => peer.npxgPer90)
		),
		percentile(
			subject.xaPer90,
			peers.map((peer) => peer.xaPer90)
		),
		percentile(
			subject.shotsPer90,
			peers.map((peer) => peer.shotsPer90)
		),
		percentile(
			subject.keyPassesPer90,
			peers.map((peer) => peer.keyPassesPer90)
		),
		percentile(
			subject.xgChainPer90,
			peers.map((peer) => peer.xgChainPer90)
		),
		percentile(
			subject.xgBuildupPer90,
			peers.map((peer) => peer.xgBuildupPer90)
		),
	]);
};

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

const buildUnderstatProcess = (
	position: number,
	season: string,
	mappingStatus: PlayerStateCoverage["mappingStatus"],
	rows: UnderstatCohortRow[]
): UnderstatProcessResult => {
	const subjects = rows.filter((row) => row.is_subject);
	const historyPercentiles = new Map<string, number>();
	for (const subject of subjects.filter((row) => row.season !== season)) {
		const cohort = rows.filter(
			(row) => row.season === subject.season && row.minutes >= PROCESS_PEER_MINUTES
		);
		const rank = understatCompositePercentile(subject, cohort);
		if (rank !== null) historyPercentiles.set(subject.season, rank);
	}
	const historySeasons = subjects
		.filter((row) => row.season_state === "complete")
		.map((row) => row.season)
		.sort();
	const currentSubject = subjects.find((row) => row.season === season) ?? null;
	if (position === 1) {
		return {
			assessment: unavailableProcess("TEAM_CONTEXT_ONLY", "PROCESS_GKP_TEAM_CONTEXT_ONLY"),
			currentSubject,
			historyPercentiles,
			historySeasons,
		};
	}
	if (mappingStatus !== "VERIFIED") {
		return {
			assessment: unavailableProcess("UNAVAILABLE", "PROCESS_MAPPING_UNAVAILABLE"),
			currentSubject: null,
			historyPercentiles,
			historySeasons,
		};
	}
	if (
		currentSubject === null ||
		(currentSubject.season_state !== "active" && currentSubject.season_state !== "complete")
	) {
		return {
			assessment: unavailableProcess("UNAVAILABLE", "PROCESS_UNAVAILABLE_UNDERSTAT"),
			currentSubject,
			historyPercentiles,
			historySeasons,
		};
	}
	if (currentSubject.minutes < PROCESS_MINIMUM_MINUTES) {
		return {
			assessment: {
				...unavailableProcess("INSUFFICIENT", "PROCESS_SAMPLE_BELOW_180_MINUTES"),
				sampleMinutes: currentSubject.minutes,
				smallSample: true,
			},
			currentSubject,
			historyPercentiles,
			historySeasons,
		};
	}
	const cohort = rows.filter((row) => row.season === season && row.minutes >= PROCESS_PEER_MINUTES);
	const currentPercentile = understatCompositePercentile(currentSubject, cohort);
	if (currentPercentile === null) {
		return {
			assessment: {
				...unavailableProcess("UNAVAILABLE", "PROCESS_COHORT_UNAVAILABLE"),
				sampleMinutes: currentSubject.minutes,
			},
			currentSubject,
			historyPercentiles,
			historySeasons,
		};
	}
	const historicalSubjects = subjects
		.filter((row) => row.season < season && row.minutes >= HISTORY_PLAYER_MINUTES)
		.sort((left, right) => right.season.localeCompare(left.season))
		.slice(0, 3);
	const baselinePercentile = averagePercentiles(
		historicalSubjects.map((row) => historyPercentiles.get(row.season) ?? null)
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
	const values = understatValues(currentSubject);
	const historicalValues = historicalSubjects.map(understatValues);
	const metricSpecs: Array<{
		code: string;
		value: keyof UnderstatValues;
	}> = [
		{ code: "UNDERSTAT_NPXG_PER_90", value: "npxgPer90" },
		{ code: "UNDERSTAT_XA_PER_90", value: "xaPer90" },
		{ code: "UNDERSTAT_SHOTS_PER_90", value: "shotsPer90" },
		{ code: "UNDERSTAT_KEY_PASSES_PER_90", value: "keyPassesPer90" },
		{ code: "UNDERSTAT_XG_CHAIN_PER_90", value: "xgChainPer90" },
		{ code: "UNDERSTAT_XG_BUILDUP_PER_90", value: "xgBuildupPer90" },
	];
	const metrics = metricSpecs.map(({ code, value }) =>
		metric(code, values[value], {
			source: "UNDERSTAT_CURRENT",
			baseline:
				historicalValues.length === 0
					? null
					: averagePercentiles(historicalValues.map((candidate) => candidate[value])),
			percentile: percentile(
				values[value],
				cohort.map((row) => understatValues(row)[value])
			),
			unit: "per90",
			season,
			sampleMinutes: currentSubject.minutes,
			sampleSize: cohort.length,
			smallSample: currentSubject.minutes < HISTORY_PLAYER_MINUTES,
		})
	);
	return {
		assessment: {
			rating,
			direction,
			available: true,
			sampleMinutes: currentSubject.minutes,
			smallSample: currentSubject.minutes < HISTORY_PLAYER_MINUTES,
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

const isDurableVerifiedLink = (link: ProviderLinkRow | null): boolean =>
	link !== null &&
	(link.status === "auto_verified" || link.status === "manual_verified") &&
	link.left_entity_id !== null;

const loadProviderLink = async (
	executor: QueryExecutor,
	playerCode: number
): Promise<ProviderLinkRow | null> => {
	const values = [String(playerCode)];
	const verified = await executor.query<ProviderLinkRow>(verifiedProviderLinkSql, values);
	if (verified.rows[0]) return verified.rows[0];
	return (await executor.query<ProviderLinkRow>(unresolvedProviderLinkSql, values)).rows[0] ?? null;
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
		await readProfileCaches(
			context,
			uniqueIds.map((playerId) => profileCacheKey(context, playerId, safeHorizon))
		);
		const profiles = await Promise.all(
			uniqueIds.map((playerId) => this.getPlayerStateProfile(context, playerId, safeHorizon))
		);
		return new Map(uniqueIds.map((playerId, index) => [playerId, profiles[index] ?? null]));
	},
	async getPlayerStateProfile(
		context: GraphQLContext,
		playerId: number,
		horizon: number
	): Promise<PlayerStateProfile | null> {
		if (!Number.isSafeInteger(playerId) || playerId <= 0) return null;
		const safeHorizon = Number.isSafeInteger(horizon) ? Math.min(8, Math.max(1, horizon)) : 5;
		const key = profileCacheKey(context, playerId, safeHorizon);
		const cached = await readProfileCache(context, key);
		if (cached !== undefined) return cached;

		const loadSnapshot = dependencies.loadCoreSnapshot ?? getCoreDataSnapshot;
		const snapshot = await loadSnapshot(context);
		const player = snapshot.players.find((candidate) => candidate.id === playerId);
		if (!player) {
			await writeNullCache(context, key);
			return null;
		}
		const executor = dependencies.executor ?? context.database;
		const seasonId = context.currentSeason.seasonId;
		const season = context.currentSeason.seasonCode;
		const asOfEventId = resolveAsOfEventId(snapshot);
		const startedEventIds = snapshot.events
			.filter(
				(event) =>
					asOfEventId !== null && event.id <= asOfEventId && (event.finished || event.isCurrent)
			)
			.map((event) => event.id)
			.sort((left, right) => right - left)
			.slice(0, 10)
			.sort((left, right) => left - right);

		const linkPromise = loadProviderLink(executor, player.code);
		const fplPromise = Promise.all([
			executor.query<MarketRow>(marketSql, [seasonId, playerId]),
			loadCurrentCohort(
				context,
				executor,
				seasonId,
				player.type,
				asOfEventId !== null,
				startedEventIds
			),
			executor.query<HistoricalCohortRow>(historicalCohortsSql, [player.code]),
		]);

		const link = await linkPromise;
		const mappingStatus = resolvePlayerStateMappingStatus(link, season);
		const confirmedSeasons = isDurableVerifiedLink(link)
			? confirmedPlayerLinkSeasons(link?.evidence ?? null)
			: [];
		const understatRows =
			confirmedSeasons.length === 0
				? []
				: (
						await executor.query<UnderstatCohortRow>(understatCohortsSql, [
							player.code,
							confirmedSeasons,
						])
					).rows;
		const [marketResult, currentCohortRows, historyResult] = await fplPromise;

		const processResult = buildUnderstatProcess(player.type, season, mappingStatus, understatRows);
		const history = addUnderstatHistory(
			historyForPlayer(historyResult.rows, player.code),
			processResult.historyPercentiles
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
		const market = marketResult.rows[0] ?? null;
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
		if (mappingStatus === "UNAVAILABLE") limitations.add("PLAYER_MAPPING_UNAVAILABLE");
		if (mappingStatus === "UNVERIFIED") limitations.add("PLAYER_MAPPING_UNVERIFIED");
		if (mappingStatus === "AMBIGUOUS") limitations.add("PLAYER_MAPPING_AMBIGUOUS");
		if (mappingStatus === "QUARANTINED") limitations.add("PLAYER_MAPPING_QUARANTINED");
		if (mappingStatus === "VERIFIED" && processResult.currentSubject === null) {
			limitations.add("UNDERSTAT_PLAYER_DATA_UNAVAILABLE");
		}
		if (!process.available) {
			limitations.add(
				player.type === 1 ? "GKP_PERSONAL_PROCESS_UNAVAILABLE" : "REAL_WORLD_PROCESS_UNAVAILABLE"
			);
		}
		if (processResult.historySeasons.length === 0) {
			limitations.add("HISTORICAL_UNDERSTAT_UNAVAILABLE");
		}
		if (history.careerTrajectory.some((point) => !point.expectedMetricsAvailable)) {
			limitations.add("OLD_FPL_EXPECTED_METRICS_MASKED");
		}

		const understatAsOf = latestIso([
			iso(processResult.currentSubject?.updated_at ?? null),
			iso(processResult.currentSubject?.season_last_seen_at ?? null),
		]);
		const asOf =
			latestIso([snapshot.sourceCheckedAt, marketCapturedAt, understatAsOf]) ??
			new Date(0).toISOString();
		const providers: PlayerStateProviderRevision[] = [
			buildPlayerStateProviderRevision({
				provider: "FPL",
				scope: "CURRENT",
				season,
				revision: `${snapshot.revision}:${snapshot.publicationId}`,
				asOf: snapshot.sourceCheckedAt,
				available: true,
			}),
			buildPlayerStateProviderRevision({
				provider: "FPL",
				scope: "HISTORY",
				season: history.seasons[0] ?? season,
				revision: history.revision,
				asOf: history.asOf,
				available: history.seasons.length > 0,
			}),
			buildPlayerStateProviderRevision({
				provider: "UNDERSTAT",
				scope: "CURRENT",
				season,
				revision: processResult.currentSubject?.source_hash ?? null,
				asOf: understatAsOf,
				available: mappingStatus === "VERIFIED" && processResult.currentSubject !== null,
			}),
		];
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
			fplOnly: !process.available,
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
			coverage: {
				fplCurrent: fplSufficient,
				understatCurrent: process.available,
				fplHistorySeasons: history.seasons,
				understatHistorySeasons: processResult.historySeasons,
				mappingStatus,
				metricCoverage: [...new Set(metricCoverage)],
				limitations: [...limitations],
				providers,
			},
		};
		await writeProfileCache(context, key, profile);
		return profile;
	},
});

export const playerStateRepository = createPlayerStateRepository();
