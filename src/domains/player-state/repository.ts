import { createHash } from "node:crypto";
import type { QueryResult } from "pg";
import type { GraphQLContext } from "../../graphql/context";
import { gqlCacheKey } from "../../infra/cache-key";
import { dbPool } from "../../infra/db-pool";
import { getCurrentSeason } from "../../infra/season";
import { resolvePlayerStatsContext } from "../players/season-stats-at-event";
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
	playerStateHistoryStorageAvailable,
	resolvePlayerStateMappingStatus,
	type PlayerStateHistoryStorage,
	type ProviderLinkRow,
} from "./coverage";
import { applyPlayerStateReleaseGate } from "./release-gate";
import type {
	PlayerGameweekSample,
	PlayerStateBaselineSeason,
	PlayerStateCareerPoint,
	PlayerStateDimension,
	PlayerStateMetric,
	PlayerStateOutlookGameweek,
	PlayerStateProfile,
	PlayerStateProviderRevision,
	ProcessAssessment,
} from "./types";

const STATE_ENGINE_VERSION = "player-state-v1.1";
const PROFILE_CACHE_TTL_SECONDS = 15 * 60;
const HISTORY_CACHE_TTL_SECONDS = 24 * 60 * 60;
const NULL_SENTINEL = "__player_state:null__";
const MINIMUM_CURRENT_GAMEWEEKS = 3;
const HISTORY_PLAYER_MINUTES = 450;
const HISTORY_PEER_MINUTES = 900;

export type QueryExecutor = {
	query<T extends object>(text: string, values?: unknown[]): Promise<QueryResult<T>>;
};

type PlayerMetadataRow = {
	player_id: number;
	player_code: number;
	position: number;
	team_id: number;
	core_season: string | null;
	core_revision: string | number | null;
	publication_id: string | null;
	core_committed_at: Date | string | null;
	fpl_snapshot_at: Date | string | null;
	outlook_event_id: number | null;
	market_status: string | null;
	chance_this_round: number | null;
	market_captured_at: Date | string | null;
};

type ArchiveRow = {
	season: string;
	status: string;
	source_core_revision: string | null;
	completed_at: Date | string | null;
};

type UnderstatSeasonRow = {
	season: string;
	state: string;
	last_seen_at: Date | string;
};

type UnderstatManifest = {
	schemaVersion: 1;
	season: string;
	lane: "team" | "player";
	revision: string;
	publishedAt: string;
	counts: Record<string, number>;
};

type CurrentGameweekRow = {
	event_id: number;
	finished: boolean;
	is_current: boolean;
	coverage_count: string | number;
	total_points: number | null;
	minutes: number | null;
	started: boolean | null;
	bonus: number | null;
};

type CurrentPeerRow = {
	element_id: number;
	total_points: number | null;
	minutes: number | null;
	bonus: number | null;
};

type CurrentPeerGameweekRow = {
	element_id: number;
	event_id: number;
	total_points: number;
	minutes: number | null;
	bonus: number | null;
};

type FixtureRow = {
	id: number;
	event_id: number;
	team_h_id: number;
	team_a_id: number;
	team_h_difficulty: number | null;
	team_a_difficulty: number | null;
	kickoff_time: Date | string | null;
	opponent_short_name: string;
};

type FixtureCoverageRow = {
	event_id: number;
	fixture_count: string | number;
};

type HistoricalCohortRow = {
	season: string;
	player_code: number;
	position: number;
	minutes: number | null;
	total_points: number | null;
	bonus: number | null;
	return_count: string | number | null;
	gameweek_count: string | number | null;
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
};

type HistoryPayload = {
	rows: HistoricalCohortRow[];
};

type PlayerHistory = {
	baselineSeasons: PlayerStateBaselineSeason[];
	careerTrajectory: PlayerStateCareerPoint[];
	sealedSeasons: string[];
	declaredSealedSeasons: string[];
	unavailableSealedSeasons: string[];
	storageAvailable: boolean;
	archiveRevision: string;
};

const metadataSql = `
	SELECT
		p.id AS player_id,
		p.code AS player_code,
		p.type AS position,
		p.team_id,
		c.season AS core_season,
		c.revision AS core_revision,
		c.publication_id::text,
		c.committed_at AS core_committed_at,
		source.fpl_snapshot_at,
		COALESCE(
			(SELECT id FROM events
			 WHERE is_current = true AND COALESCE(finished, false) = false
			 ORDER BY id DESC LIMIT 1),
			(SELECT id FROM events WHERE is_next = true ORDER BY id ASC LIMIT 1),
			(SELECT id FROM events WHERE finished = true ORDER BY id DESC LIMIT 1),
			1
		) AS outlook_event_id,
		market.status AS market_status,
		market.chance_of_playing_this_round AS chance_this_round,
		market.captured_at AS market_captured_at
	FROM players p
	LEFT JOIN core_snapshot_authority c ON c.singleton_id = 1
	LEFT JOIN LATERAL (
		SELECT GREATEST(
			COALESCE(p.updated_at, p.created_at),
			(SELECT max(COALESCE(updated_at, created_at)) FROM events),
			(SELECT max(COALESCE(updated_at, created_at)) FROM event_fixtures),
			(SELECT max(COALESCE(updated_at, created_at)) FROM player_stats)
		) AS fpl_snapshot_at
	) source ON true
	LEFT JOIN LATERAL (
		SELECT status, chance_of_playing_this_round, captured_at
		FROM player_market_snapshots
		WHERE element_id = p.id
		ORDER BY snapshot_date DESC, captured_at DESC
		LIMIT 1
	) market ON true
	WHERE p.id = $1
	LIMIT 1
`;

const archiveSql = `
	SELECT season, status, source_core_revision, completed_at
	FROM fpl_season_archives
	WHERE status = 'sealed'
	ORDER BY season DESC
`;

const historyStorageSql = `
	SELECT
		to_regclass('public.fpl_player_history')::text AS player_history,
		to_regclass('public.fpl_player_stat_history')::text AS player_stat_history,
		to_regclass('public.fpl_event_live_history')::text AS event_live_history
`;

const availableArchiveSql = `
	SELECT archive.season, archive.status, archive.source_core_revision, archive.completed_at
	FROM fpl_season_archives archive
	WHERE archive.status = 'sealed'
		AND EXISTS (
			SELECT 1 FROM fpl_player_history player WHERE player.season = archive.season
		)
		AND EXISTS (
			SELECT 1 FROM fpl_player_stat_history stats WHERE stats.season = archive.season
		)
		AND EXISTS (
			SELECT 1 FROM fpl_event_live_history live WHERE live.season = archive.season
		)
	ORDER BY archive.season DESC
`;

const providerLinkSql = `
	SELECT status, rule_version, left_entity_id, evidence
	FROM provider_entity_links
	WHERE entity_type = 'player'
		AND left_provider = 'understat'
		AND right_provider = 'fpl'
		AND right_entity_id = $1
	ORDER BY CASE status
		WHEN 'manual_verified' THEN 1
		WHEN 'auto_verified' THEN 2
		WHEN 'quarantined' THEN 3
		WHEN 'ambiguous' THEN 4
		ELSE 5
	END, updated_at DESC NULLS LAST, created_at DESC
	LIMIT 1
`;

const understatSeasonsSql = `
	SELECT season, state, last_seen_at
	FROM understat_seasons
	ORDER BY season DESC
`;

const fixtureCoverageSql = `
	SELECT
		e.id AS event_id,
		COUNT(f.id)::integer AS fixture_count
	FROM events e
	LEFT JOIN event_fixtures f ON f.event_id = e.id
	WHERE e.id BETWEEN $1 AND $2
	GROUP BY e.id
	ORDER BY e.id
`;

const recentGameweeksSql = `
	WITH candidate_events AS (
		SELECT id, finished, is_current
		FROM events
		WHERE id <= $2
			AND (
				finished = true
				OR is_current = true
				OR deadline_time IS NOT NULL AND deadline_time <= now()
			)
		ORDER BY id DESC
		LIMIT 10
	), coverage AS (
		SELECT event_id, count(*) AS row_count
		FROM event_lives
		WHERE event_id IN (SELECT id FROM candidate_events)
		GROUP BY event_id
	)
	SELECT
		e.id AS event_id,
		e.finished,
		e.is_current,
		COALESCE(c.row_count, 0) AS coverage_count,
		l.total_points,
		l.minutes,
		l.starts AS started,
		l.bonus
	FROM candidate_events e
	LEFT JOIN coverage c ON c.event_id = e.id
	LEFT JOIN event_lives l ON l.event_id = e.id AND l.element_id = $1
	ORDER BY e.id DESC
`;

const currentPeersSql = `
	SELECT element_id, total_points, minutes, bonus
	FROM player_stats
	WHERE event_id = $1
		AND element_type = $2
		AND COALESCE(minutes, 0) >= ${HISTORY_PEER_MINUTES}
`;

const currentPeerGameweeksSql = `
	SELECT element_id, event_id, total_points, minutes, bonus
	FROM event_lives
	WHERE event_id <= $1 AND element_id = ANY($2::integer[])
`;

const fixturesSql = `
	SELECT
		f.id,
		f.event_id,
		f.team_h_id,
		f.team_a_id,
		f.team_h_difficulty,
		f.team_a_difficulty,
		f.kickoff_time,
		CASE WHEN f.team_h_id = $1 THEN away.short_name ELSE home.short_name END AS opponent_short_name
	FROM event_fixtures f
	JOIN teams home ON home.id = f.team_h_id
	JOIN teams away ON away.id = f.team_a_id
	WHERE f.event_id BETWEEN $2 AND $3
		AND (f.team_h_id = $1 OR f.team_a_id = $1)
	ORDER BY f.event_id, f.kickoff_time NULLS LAST, f.id
`;

const historicalCohortsSql = `
	WITH sealed AS (
		SELECT unnest($2::text[]) AS season
	), requested AS (
		SELECT player.season, player.type AS position
		FROM fpl_player_history player
		JOIN sealed ON sealed.season = player.season
		WHERE player.code = $1
	), peer_players AS (
		SELECT player.season, player.id AS element_id, player.code AS player_code, player.type AS position
		FROM fpl_player_history player
		JOIN requested
			ON requested.season = player.season
			AND requested.position = player.type
	), final_stats AS (
		SELECT DISTINCT ON (stats.season, stats.element_id)
			stats.season,
			player.player_code,
			player.position,
			stats.element_id,
			stats.minutes,
			stats.total_points,
			stats.bonus
		FROM fpl_player_stat_history stats
		JOIN peer_players player
			ON player.season = stats.season AND player.element_id = stats.element_id
		ORDER BY stats.season, stats.element_id, stats.event_id DESC
	), returns AS (
		SELECT
			live.season,
			live.element_id,
			count(*) FILTER (WHERE live.total_points >= 5) AS return_count,
			count(DISTINCT live.event_id) AS gameweek_count
		FROM fpl_event_live_history live
		JOIN peer_players player
			ON player.season = live.season AND player.element_id = live.element_id
		GROUP BY live.season, live.element_id
	)
	SELECT
		final_stats.season,
		final_stats.player_code,
		final_stats.position,
		final_stats.minutes,
		final_stats.total_points,
		final_stats.bonus,
		returns.return_count,
		returns.gameweek_count
	FROM final_stats
	LEFT JOIN returns
		ON returns.season = final_stats.season
		AND returns.element_id = final_stats.element_id
`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const asNumber = (value: unknown): number | null => {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
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

const freshness = (timestamp: string | null): number | null =>
	timestamp === null ? null : Math.max(0, Math.floor((Date.now() - Date.parse(timestamp)) / 1000));

const stableHash = (value: unknown): string =>
	createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 20);

const parseManifest = (
	raw: string | null,
	season: string,
	lane: "team" | "player"
): UnderstatManifest | null => {
	if (!raw) return null;
	try {
		const value: unknown = JSON.parse(raw);
		if (
			!isRecord(value) ||
			value.schemaVersion !== 1 ||
			value.season !== season ||
			value.lane !== lane ||
			typeof value.revision !== "string" ||
			typeof value.publishedAt !== "string" ||
			!Number.isFinite(Date.parse(value.publishedAt)) ||
			!isRecord(value.counts)
		) {
			return null;
		}
		return value as UnderstatManifest;
	} catch {
		return null;
	}
};

const currentMetrics = (
	peerRows: CurrentPeerRow[],
	gameweekRows: CurrentPeerGameweekRow[],
	eventIds: number[]
): CurrentMetricRow[] => {
	const byPlayerEvent = new Map<string, CurrentPeerGameweekRow>();
	for (const row of gameweekRows) byPlayerEvent.set(`${row.element_id}:${row.event_id}`, row);
	return peerRows.map((row) => {
		const minutes = row.minutes ?? 0;
		const eventRows = eventIds.map(
			(eventId) => byPlayerEvent.get(`${row.element_id}:${eventId}`) ?? null
		);
		const returnCount = eventRows.filter((event) => (event?.total_points ?? 0) >= 5).length;
		return {
			elementId: row.element_id,
			pointsPer90:
				minutes > 0 && row.total_points !== null ? (row.total_points * 90) / minutes : null,
			returnRate: eventIds.length === 0 ? 0 : (returnCount / eventIds.length) * 100,
			bonusPer90: minutes > 0 && row.bonus !== null ? (row.bonus * 90) / minutes : null,
			minutes,
			gameweeks: eventIds.length,
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
		const result: CurrentMetricRow = {
			elementId,
			pointsPer90: minutes > 0 ? (points * 90) / minutes : null,
			returnRate:
				eventIds.length === 0
					? 0
					: (rows.filter((row) => (row?.total_points ?? 0) >= 5).length / eventIds.length) * 100,
			bonusPer90: minutes > 0 ? (bonus * 90) / minutes : null,
			minutes,
			gameweeks: eventIds.length,
		};
		return result;
	});
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

const historyForPlayer = (
	rows: HistoricalCohortRow[],
	playerCode: number,
	archiveRevision: string,
	sealedSeasons: string[],
	declaredSealedSeasons: string[],
	unavailableSealedSeasons: string[],
	storageAvailable: boolean
): PlayerHistory => {
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
	return {
		baselineSeasons,
		careerTrajectory,
		sealedSeasons,
		declaredSealedSeasons,
		unavailableSealedSeasons,
		storageAvailable,
		archiveRevision,
	};
};

const toGameweekSamples = (rows: CurrentGameweekRow[]): PlayerGameweekSample[] =>
	rows.map((row) => {
		const covered = asInt(row.coverage_count) !== null && (asInt(row.coverage_count) ?? 0) > 0;
		return {
			eventId: row.event_id,
			totalPoints: covered ? (row.total_points ?? 0) : 0,
			minutes: covered ? (row.minutes ?? 0) : 0,
			started: covered ? Boolean(row.started) : false,
			bonus: covered ? (row.bonus ?? 0) : 0,
			covered,
		};
	});

const buildOutlookGameweeks = (
	rows: FixtureRow[],
	teamId: number,
	startEventId: number,
	horizon: number,
	coveredEventIds: Set<number>
): PlayerStateOutlookGameweek[] => {
	const result: PlayerStateOutlookGameweek[] = [];
	for (let eventId = startEventId; eventId < startEventId + horizon; eventId += 1) {
		const eventRows = rows.filter((row) => row.event_id === eventId);
		const fixtures = eventRows.map((row) => ({
			id: row.id,
			opponentTeamShortName: row.opponent_short_name,
			wasHome: row.team_h_id === teamId,
			difficulty: (row.team_h_id === teamId ? row.team_h_difficulty : row.team_a_difficulty) ?? 0,
			kickoffTime: iso(row.kickoff_time),
		}));
		const difficulties = fixtures
			.map((fixture) => fixture.difficulty)
			.filter((difficulty) => difficulty >= 1 && difficulty <= 5);
		const covered = coveredEventIds.has(eventId);
		result.push({
			eventId,
			bgw: covered && fixtures.length === 0,
			dgw: covered && fixtures.length > 1,
			averageDifficulty:
				difficulties.length === 0
					? null
					: difficulties.reduce((sum, difficulty) => sum + difficulty, 0) / difficulties.length,
			fixtures,
		});
	}
	return result;
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

const profileGuard = (value: unknown): value is PlayerStateProfile =>
	isRecord(value) &&
	typeof value.playerId === "number" &&
	typeof value.trend === "string" &&
	Array.isArray(value.dimensions) &&
	isRecord(value.coverage);

const historyGuard = (value: unknown): value is HistoryPayload =>
	isRecord(value) && Array.isArray(value.rows);

async function readCache<T>(
	context: GraphQLContext,
	key: string,
	guard: (value: unknown) => value is T
): Promise<T | null | undefined> {
	try {
		const raw = await context.redis.get(key);
		if (raw === null) return undefined;
		if (raw === NULL_SENTINEL) return null;
		const parsed: unknown = JSON.parse(raw);
		if (guard(parsed)) return parsed;
		await context.redis.del(key);
	} catch (error) {
		context.logger.warn({ err: error, key }, "Failed to read player-state cache");
	}
	return undefined;
}

async function writeCache(
	context: GraphQLContext,
	key: string,
	value: unknown,
	ttl: number
): Promise<void> {
	try {
		await context.redis.set(key, JSON.stringify(value), "EX", ttl);
	} catch (error) {
		context.logger.warn({ err: error, key }, "Failed to write player-state cache");
	}
}

async function loadHistory(
	context: GraphQLContext,
	executor: QueryExecutor,
	playerCode: number,
	archives: ArchiveRow[]
): Promise<PlayerHistory> {
	const declaredSealedSeasons = archives.map((archive) => archive.season);
	let storage: PlayerStateHistoryStorage | null = null;
	try {
		const storageResult = await executor.query<{
			player_history: string | null;
			player_stat_history: string | null;
			event_live_history: string | null;
		}>(historyStorageSql);
		const row = storageResult.rows[0];
		storage = row
			? {
					playerHistory: row.player_history,
					playerStatHistory: row.player_stat_history,
					eventLiveHistory: row.event_live_history,
				}
			: null;
	} catch (error) {
		context.logger.warn({ err: error }, "Failed to inspect FPL history storage");
	}

	if (!playerStateHistoryStorageAvailable(storage)) {
		const archiveRevision = stableHash({
			declared: archives.map((archive) => [
				archive.season,
				archive.source_core_revision,
				iso(archive.completed_at),
			]),
			storage: "unavailable",
		});
		return historyForPlayer(
			[],
			playerCode,
			archiveRevision,
			[],
			declaredSealedSeasons,
			declaredSealedSeasons,
			false
		);
	}

	let availableArchives: ArchiveRow[] = [];
	try {
		availableArchives = (await executor.query<ArchiveRow>(availableArchiveSql)).rows;
	} catch (error) {
		context.logger.warn({ err: error }, "Failed to reconcile sealed FPL history storage");
	}
	const sealedSeasons = availableArchives.map((archive) => archive.season);
	const availableSet = new Set(sealedSeasons);
	const unavailableSealedSeasons = declaredSealedSeasons.filter(
		(season) => !availableSet.has(season)
	);
	const archiveRevision = stableHash({
		declared: archives.map((archive) => [
			archive.season,
			archive.source_core_revision,
			iso(archive.completed_at),
		]),
		available: availableArchives.map((archive) => [
			archive.season,
			archive.source_core_revision,
			iso(archive.completed_at),
		]),
		storage: "available",
	});
	if (sealedSeasons.length === 0) {
		return historyForPlayer(
			[],
			playerCode,
			archiveRevision,
			[],
			declaredSealedSeasons,
			unavailableSealedSeasons,
			true
		);
	}
	const key = `player_state:history-cohorts:${STATE_ENGINE_VERSION}:${playerCode}:${archiveRevision}`;
	let payload = await readCache(context, key, historyGuard);
	if (payload === undefined || payload === null) {
		try {
			const result = await executor.query<HistoricalCohortRow>(historicalCohortsSql, [
				playerCode,
				sealedSeasons,
			]);
			payload = { rows: result.rows };
			await writeCache(context, key, payload, HISTORY_CACHE_TTL_SECONDS);
		} catch (error) {
			context.logger.warn({ err: error }, "Failed to load sealed FPL history cohorts");
			return historyForPlayer(
				[],
				playerCode,
				stableHash({ archiveRevision, query: "unavailable" }),
				[],
				declaredSealedSeasons,
				declaredSealedSeasons,
				false
			);
		}
	}
	return historyForPlayer(
		payload.rows,
		playerCode,
		archiveRevision,
		sealedSeasons,
		declaredSealedSeasons,
		unavailableSealedSeasons,
		true
	);
}

async function readUnderstatManifests(
	context: GraphQLContext,
	season: string
): Promise<{ team: UnderstatManifest | null; player: UnderstatManifest | null }> {
	try {
		const [teamRaw, playerRaw] = await context.redis.mget(
			`Understat:Snapshot:${season}:team`,
			`Understat:Snapshot:${season}:player`
		);
		return {
			team: parseManifest(teamRaw ?? null, season, "team"),
			player: parseManifest(playerRaw ?? null, season, "player"),
		};
	} catch (error) {
		context.logger.warn({ err: error, season }, "Failed to read Understat manifests");
		return { team: null, player: null };
	}
}

const isMissingRelationError = (error: unknown): boolean =>
	isRecord(error) && error.code === "42P01";

async function loadUnderstatSeasons(
	context: GraphQLContext,
	executor: QueryExecutor
): Promise<UnderstatSeasonRow[]> {
	try {
		const result = await executor.query<UnderstatSeasonRow>(understatSeasonsSql);
		return result.rows;
	} catch (error) {
		if (isMissingRelationError(error)) {
			context.logger.warn(
				{ table: "understat_seasons" },
				"Understat season storage is not provisioned; serving FPL-only state"
			);
			return [];
		}
		throw error;
	}
}

export interface PlayerStateRepository {
	getPlayerStateProfile(
		context: GraphQLContext,
		playerId: number,
		horizon: number
	): Promise<PlayerStateProfile | null>;
}

export const createPlayerStateRepository = (
	executor: QueryExecutor = dbPool as unknown as QueryExecutor
): PlayerStateRepository => ({
	async getPlayerStateProfile(
		context: GraphQLContext,
		playerId: number,
		horizon: number
	): Promise<PlayerStateProfile | null> {
		if (!Number.isInteger(playerId) || playerId <= 0) return null;
		const safeHorizon = Number.isInteger(horizon) ? Math.min(8, Math.max(1, horizon)) : 5;

		const season = await getCurrentSeason(context);
		const statsContextPromise = resolvePlayerStatsContext(context);
		const [metadataResult, archiveResult, understatSeasonsResult, statsContext] = await Promise.all(
			[
				executor.query<PlayerMetadataRow>(metadataSql, [playerId]),
				executor.query<ArchiveRow>(archiveSql),
				loadUnderstatSeasons(context, executor),
				statsContextPromise,
			]
		);
		const metadata = metadataResult.rows[0];
		if (!metadata) return null;

		// Provider links use durable FPL player.code, never the season-local element id.
		const durableLink = await executor.query<ProviderLinkRow>(providerLinkSql, [
			String(metadata.player_code),
		]);
		const link = durableLink.rows[0] ?? null;
		const manifests = await readUnderstatManifests(context, season);
		const currentMappingStatus = resolvePlayerStateMappingStatus(link, season);
		const currentUnderstatSeason = understatSeasonsResult.find(
			(candidate) => candidate.season === season
		);
		const understatPublished =
			Boolean(currentUnderstatSeason) &&
			(currentUnderstatSeason?.state === "active" ||
				currentUnderstatSeason?.state === "complete") &&
			manifests.team !== null &&
			manifests.player !== null;
		const understatCurrent = understatPublished && currentMappingStatus === "VERIFIED";

		const history = await loadHistory(context, executor, metadata.player_code, archiveResult.rows);
		const sourceVector = {
			engine: STATE_ENGINE_VERSION,
			season,
			eventId: statsContext.asOfEventId,
			coreRevision: metadata.core_revision,
			publicationId: metadata.publication_id,
			fplSnapshotAt: iso(metadata.fpl_snapshot_at),
			marketCapturedAt: iso(metadata.market_captured_at),
			understatTeamRevision: manifests.team?.revision ?? null,
			understatPlayerRevision: manifests.player?.revision ?? null,
			linkRuleVersion: link?.rule_version ?? "none",
			mappingStatus: currentMappingStatus,
			archiveRevision: history.archiveRevision,
			horizon: safeHorizon,
		};
		const profileKey = gqlCacheKey(
			season,
			`player_state:profile:${playerId}:${stableHash(sourceVector)}`
		);
		const cached = await readCache(context, profileKey, profileGuard);
		if (cached !== undefined) return cached;

		const outlookStart = Math.max(1, metadata.outlook_event_id ?? statsContext.asOfEventId ?? 1);
		const gameweekPromise =
			statsContext.scope === "CURRENT_SEASON" && statsContext.asOfEventId !== null
				? executor.query<CurrentGameweekRow>(recentGameweeksSql, [
						playerId,
						statsContext.asOfEventId,
					])
				: Promise.resolve({ rows: [] } as unknown as QueryResult<CurrentGameweekRow>);
		const [gameweekResult, fixtureResult, fixtureCoverageResult] = await Promise.all([
			gameweekPromise,
			executor.query<FixtureRow>(fixturesSql, [
				metadata.team_id,
				outlookStart,
				outlookStart + safeHorizon - 1,
			]),
			executor.query<FixtureCoverageRow>(fixtureCoverageSql, [
				outlookStart,
				outlookStart + safeHorizon - 1,
			]),
		]);
		const samples = toGameweekSamples(gameweekResult.rows);
		const coveredSamples = samples.filter((sample) => sample.covered);
		const recentSamples = coveredSamples.slice(0, 5);
		const previousSamples = coveredSamples.slice(5, 10);
		const recentEventIds = recentSamples.map((sample) => sample.eventId);
		const role = assessRole(recentSamples, previousSamples);
		const availability = assessAvailability(
			metadata.market_status === null
				? null
				: {
						status: metadata.market_status,
						chanceOfPlayingThisRound: metadata.chance_this_round,
						stale:
							(freshness(iso(metadata.market_captured_at)) ?? Number.POSITIVE_INFINITY) >
							PLAYER_STATE_FRESHNESS_STALE_SECONDS,
					}
		);

		let currentRows: CurrentMetricRow[] = [];
		let recentRows: CurrentMetricRow[] = [];
		if (statsContext.asOfEventId !== null && recentEventIds.length > 0) {
			const peersResult = await executor.query<CurrentPeerRow>(currentPeersSql, [
				statsContext.asOfEventId,
				metadata.position,
			]);
			const peerIds = peersResult.rows.map((row) => row.element_id);
			const peerGameweeks =
				peerIds.length === 0
					? ({ rows: [] } as unknown as QueryResult<CurrentPeerGameweekRow>)
					: await executor.query<CurrentPeerGameweekRow>(currentPeerGameweeksSql, [
							statsContext.asOfEventId,
							peerIds,
						]);
			const seasonEventIds = [...new Set(peerGameweeks.rows.map((row) => row.event_id))].sort(
				(left, right) => left - right
			);
			currentRows = currentMetrics(peersResult.rows, peerGameweeks.rows, seasonEventIds);
			recentRows = recentMetrics(peerIds, peerGameweeks.rows, recentEventIds);
		}
		const currentPlayer = currentRows.find((row) => row.elementId === playerId) ?? null;
		const recentPlayer = recentRows.find((row) => row.elementId === playerId) ?? null;
		const currentPercentile = currentPlayer
			? metricCompositePercentile(currentPlayer, currentRows)
			: null;
		const recentPercentile = recentPlayer
			? metricCompositePercentile(recentPlayer, recentRows)
			: null;
		const reliability = assessReliability(history.baselineSeasons, currentPlayer?.minutes ?? 0);
		const output = assessOutput({
			currentPercentile,
			recentPercentile,
			seasonBaselinePercentile: currentPercentile,
			ownBaselinePercentile: reliability.baseline.weightedPercentile,
		});

		const process: ProcessAssessment = {
			rating: metadata.position === 1 ? "TEAM_CONTEXT_ONLY" : "UNAVAILABLE",
			direction: "UNKNOWN",
			available: false,
			sampleMinutes: 0,
			smallSample: false,
			reasonCodes: [
				metadata.position === 1
					? "PROCESS_GKP_TEAM_CONTEXT_ONLY"
					: understatCurrent
						? "PROCESS_METRIC_CAPABILITY_UNAVAILABLE"
						: "PROCESS_UNAVAILABLE_UNDERSTAT",
			],
			metrics: [],
		};

		const fplSufficient =
			statsContext.scope === "CURRENT_SEASON" &&
			coveredSamples.length >= MINIMUM_CURRENT_GAMEWEEKS &&
			currentPlayer !== null &&
			currentPercentile !== null &&
			recentPercentile !== null;
		const composed = composePlayerState({
			availability,
			role,
			output,
			process,
			fplSufficient,
			completeFplWindow: recentSamples.length === 5,
			historySeasonCount: reliability.baseline.seasons.length,
		});
		const releaseDecision = applyPlayerStateReleaseGate(composed.trend, process.available);

		const outlookGameweeks = buildOutlookGameweeks(
			fixtureResult.rows,
			metadata.team_id,
			outlookStart,
			safeHorizon,
			new Set(
				fixtureCoverageResult.rows
					.filter((row) => Number(row.fixture_count) > 0)
					.map((row) => row.event_id)
			)
		);
		const outlook = assessOutlook(outlookGameweeks, safeHorizon);
		const dgwCount = outlook.gameweeks.filter((gameweek) => gameweek.dgw).length;
		const bgwCount = outlook.gameweeks.filter((gameweek) => gameweek.bgw).length;
		const outlookCoverageComplete =
			fixtureCoverageResult.rows.length === safeHorizon &&
			fixtureCoverageResult.rows.every((row) => Number(row.fixture_count) > 0);
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
				percentile: recentPercentile,
				unit: "per90",
				season,
				sampleMinutes: recentPlayer?.minutes ?? 0,
				sampleSize: recentSamples.length,
			}),
			metric("FPL_RETURN_RATE", recentPlayer?.returnRate ?? null, {
				source: "FPL_CURRENT",
				baseline: currentPlayer?.returnRate ?? null,
				percentile: recentPercentile,
				unit: "percent",
				season,
				sampleMinutes: recentPlayer?.minutes ?? 0,
				sampleSize: recentSamples.length,
			}),
			metric("FPL_BONUS_PER_90", recentPlayer?.bonusPer90 ?? null, {
				source: "FPL_CURRENT",
				baseline: currentPlayer?.bonusPer90 ?? null,
				percentile: recentPercentile,
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
						? recentSamples.length >= 5
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
				confidence: fplSufficient && recentSamples.length === 5 ? "HIGH" : "LOW",
				reasonCodes: output.reasonCodes,
				metrics: outputMetrics,
			},
			{
				kind: "REAL_WORLD_PROCESS",
				rating: process.rating,
				direction: process.direction,
				confidence: "LOW",
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
				confidence:
					outlookCoverageComplete && (fixtureResult.rows.length > 0 || bgwCount > 0)
						? "HIGH"
						: "LOW",
				reasonCodes: outlookReasons,
				metrics: [
					metric("OUTLOOK_AVERAGE_FDR", outlook.averageDifficulty, {
						source: "FPL_CURRENT",
						unit: "fdr",
						season,
						sampleSize: safeHorizon,
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

		const linkIsVerified =
			link !== null &&
			(link.status === "auto_verified" || link.status === "manual_verified") &&
			link.left_entity_id !== null;
		const linkConfirmed = linkIsVerified ? confirmedPlayerLinkSeasons(link?.evidence ?? null) : [];
		const understatHistorySeasons = understatSeasonsResult
			.filter(
				(candidate) => candidate.state === "complete" && linkConfirmed.includes(candidate.season)
			)
			.map((candidate) => candidate.season)
			.sort();
		const limitations = new Set<string>();
		if (!fplSufficient) limitations.add("CURRENT_FPL_INSUFFICIENT");
		if (releaseDecision.withheld && releaseDecision.reasonCode) {
			limitations.add(releaseDecision.reasonCode);
		}
		if (recentSamples.length > 0 && recentSamples.length < 5)
			limitations.add("EARLY_SEASON_SAMPLE");
		if (!outlookCoverageComplete) limitations.add("OUTLOOK_FIXTURE_COVERAGE_UNKNOWN");
		if (!understatPublished) limitations.add("UNDERSTAT_SEASON_UNAVAILABLE");
		if (currentMappingStatus === "UNAVAILABLE") limitations.add("PLAYER_MAPPING_UNAVAILABLE");
		if (currentMappingStatus === "UNVERIFIED") limitations.add("PLAYER_MAPPING_UNVERIFIED");
		if (currentMappingStatus === "AMBIGUOUS") limitations.add("PLAYER_MAPPING_AMBIGUOUS");
		if (currentMappingStatus === "QUARANTINED") limitations.add("PLAYER_MAPPING_QUARANTINED");
		limitations.add(
			metadata.position === 1
				? "GKP_PERSONAL_PROCESS_UNAVAILABLE"
				: "REAL_WORLD_PROCESS_UNAVAILABLE"
		);
		if (understatHistorySeasons.length === 0) limitations.add("HISTORICAL_UNDERSTAT_UNAVAILABLE");
		if (!history.storageAvailable && history.declaredSealedSeasons.length > 0) {
			limitations.add("FPL_HISTORY_STORAGE_UNAVAILABLE");
		} else if (history.unavailableSealedSeasons.length > 0) {
			limitations.add("FPL_HISTORY_ARCHIVE_INCOMPLETE");
		}
		if (history.careerTrajectory.some((point) => !point.expectedMetricsAvailable)) {
			limitations.add("OLD_FPL_EXPECTED_METRICS_MASKED");
		}
		if (metadata.core_season !== null && metadata.core_season !== season) {
			limitations.add("FPL_SEASON_AUTHORITY_MISMATCH");
		}
		if (metadata.core_revision === null) limitations.add("FPL_CORE_REVISION_UNAVAILABLE");

		const coreAsOf = iso(metadata.core_committed_at) ?? iso(metadata.fpl_snapshot_at);
		const marketAsOf = iso(metadata.market_captured_at);
		const understatAsOf =
			[manifests.team?.publishedAt, manifests.player?.publishedAt]
				.filter((value): value is string => typeof value === "string")
				.sort()
				.at(-1) ?? null;
		const asOf =
			[coreAsOf, marketAsOf, understatAsOf]
				.filter((value): value is string => value !== null)
				.sort()
				.at(-1) ?? new Date(0).toISOString();
		const providers: PlayerStateProviderRevision[] = [
			buildPlayerStateProviderRevision({
				provider: "FPL",
				scope: "CURRENT",
				season,
				revision:
					metadata.core_revision === null
						? coreAsOf === null
							? null
							: `fallback:${stableHash(coreAsOf)}`
						: `${metadata.core_revision}:${metadata.publication_id ?? "unknown"}`,
				asOf: coreAsOf,
				available: metadata.core_season === null || metadata.core_season === season,
			}),
			buildPlayerStateProviderRevision({
				provider: "FPL",
				scope: "HISTORY",
				season: history.sealedSeasons.at(0) ?? season,
				revision: history.archiveRevision,
				asOf:
					archiveResult.rows
						.map((archive) => iso(archive.completed_at))
						.filter((value): value is string => value !== null)
						.sort()
						.at(-1) ?? null,
				available: history.sealedSeasons.length > 0,
			}),
			buildPlayerStateProviderRevision({
				provider: "UNDERSTAT",
				scope: "CURRENT",
				season,
				revision:
					manifests.team && manifests.player
						? `team:${manifests.team.revision}|player:${manifests.player.revision}`
						: null,
				asOf: understatAsOf,
				available: understatCurrent,
			}),
		];

		const metricCoverage = dimensions
			.flatMap((dimension) => dimension.metrics)
			.filter((candidate) => candidate.capability && candidate.value !== null)
			.map((candidate) => candidate.code);
		const profile: PlayerStateProfile = {
			playerId,
			playerCode: metadata.player_code,
			teamId: metadata.team_id,
			position: metadata.position,
			season,
			horizon: safeHorizon,
			asOfEventId: statsContext.asOfEventId,
			asOf,
			trend: releaseDecision.trend,
			confidence: releaseDecision.withheld ? "LOW" : composed.confidence,
			fplOnly: !process.available,
			reasons:
				releaseDecision.withheld && releaseDecision.reasonCode
					? [
							{
								code: releaseDecision.reasonCode,
								dimension: "FPL_OUTPUT",
								current: output.recentPercentile,
								baseline: output.baselinePercentile,
								percentile: output.currentPercentile,
							},
							...composed.reasons.filter((reason) => reason.code === "FPL_ONLY"),
						]
					: composed.reasons,
			dimensions,
			ownBaseline: reliability.baseline,
			peerBaseline: {
				position: metadata.position,
				minimumMinutes: HISTORY_PEER_MINUTES,
				cohortSize: currentRows.length,
				currentPercentile,
			},
			careerTrajectory: history.careerTrajectory,
			outlook,
			coverage: {
				fplCurrent: fplSufficient,
				understatCurrent: process.available,
				fplHistorySeasons: history.sealedSeasons,
				understatHistorySeasons,
				mappingStatus: currentMappingStatus,
				metricCoverage: [...new Set(metricCoverage)],
				limitations: [...limitations],
				providers,
			},
		};
		await writeCache(context, profileKey, profile, PROFILE_CACHE_TTL_SECONDS);
		return profile;
	},
});

export const playerStateRepository = createPlayerStateRepository();
