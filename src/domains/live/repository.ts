import type { GraphQLContext } from "../../graphql/context";
import { gqlCacheKey } from "../../infra/cache-key";
import { getCurrentEventId } from "../../infra/event";
import { isMissingPostgrestColumnError } from "../../infra/postgrest-error";
import { getCurrentSeason } from "../../infra/season";
import {
	isLiveSnapshotConsistencyActive,
	isLiveSnapshotDatabaseFallback,
	LiveSnapshotCoherenceError,
	loadLiveSnapshotMeta,
	liveSnapshotMetaKey,
	parseLiveSnapshotMeta,
	rememberLiveSnapshotMeta,
	type LiveSnapshotMeta,
} from "./snapshot-meta";

export type LivePerformance = {
	eventId: number;
	playerId: number;
	minutes: number | null;
	goalsScored: number | null;
	assists: number | null;
	cleanSheets: number | null;
	goalsConceded: number | null;
	ownGoals: number | null;
	penaltiesSaved: number | null;
	penaltiesMissed: number | null;
	yellowCards: number | null;
	redCards: number | null;
	saves: number | null;
	bonus: number | null;
	bps: number | null;
	starts: boolean | null;
	defensiveContribution: number | null;
	expectedGoals: string | null;
	expectedAssists: string | null;
	expectedGoalInvolvements: string | null;
	expectedGoalsConceded: string | null;
	inDreamTeam: boolean | null;
	totalPoints: number;
};

export type LiveExplainStats = {
	minutes: number | null;
	goalsScored: number | null;
	assists: number | null;
	cleanSheets: number | null;
	goalsConceded: number | null;
	ownGoals: number | null;
	penaltiesSaved: number | null;
	penaltiesMissed: number | null;
	yellowCards: number | null;
	redCards: number | null;
	saves: number | null;
	bonus: number | null;
	bps: number | null;
	influence: number | null;
	creativity: number | null;
	threat: number | null;
	ictIndex: number | null;
	clearancesBlocksInterceptions: number | null;
	recoveries: number | null;
	tackles: number | null;
	defensiveContribution: number | null;
	starts: number | null;
	expectedGoals: number | null;
	expectedAssists: number | null;
	expectedGoalInvolvements: number | null;
	expectedGoalsConceded: number | null;
	totalPoints: number | null;
	inDreamTeam: boolean | null;
};

export type LiveExplainStatContribution = {
	identifier: string;
	points: number;
	value: number | null;
	pointsModification: number | null;
};

export type LiveExplainBreakdown = {
	fixtureId: number;
	stats: LiveExplainStatContribution[];
};

export type LiveExplain = {
	eventId: number;
	elementId: number;
	modified: boolean | null;
	stats: LiveExplainStats;
	breakdown: LiveExplainBreakdown[];
	contributions?: LiveExplainStatContribution[];
	selectedBy: number | null;
};

export type LiveExplainReadMode = "full" | "contributions";

type DbLiveRow = {
	event_id: number;
	element_id: number;
	minutes: number | null;
	goals_scored: number | null;
	assists: number | null;
	clean_sheets: number | null;
	goals_conceded: number | null;
	own_goals: number | null;
	penalties_saved: number | null;
	penalties_missed: number | null;
	yellow_cards: number | null;
	red_cards: number | null;
	saves: number | null;
	bonus: number | null;
	bps: number | null;
	starts: boolean | null;
	defensive_contribution: number | null;
	expected_goals: string | null;
	expected_assists: string | null;
	expected_goal_involvements: string | null;
	expected_goals_conceded: string | null;
	in_dream_team: boolean | null;
	total_points: number;
};

type JsonRecord = Record<string, unknown>;

type DbLiveExplainStats = JsonRecord;

type DbLiveExplainBreakdownStat = JsonRecord;

type DbLiveExplainBreakdown = JsonRecord & {
	stats?: DbLiveExplainBreakdownStat[] | string | null;
};

/** Per-element GW row: `explain` JSON = fixture-level breakdown; not used for `stats` (use `player_stats`). */
type DbLiveExplainRow = {
	event_id: number;
	element_id: number;
	explain?: DbLiveExplainBreakdown[] | string | null;
	modified?: boolean | number | string | null;
} & Record<string, unknown>;

type SelectedByCacheRow = {
	selected_by_percent: number | string | null | undefined;
};

const redisKey = {
	eventLive: (season: string, eventId: number): string => `EventLive:${season}:${eventId}`,
	eventLiveExplain: (season: string, eventId: number): string =>
		`EventLiveExplain:${season}:${eventId}`,
	playerSelectedBy: (season: string, eventId: number): string =>
		gqlCacheKey(season, `live:selected-by:${eventId}`),
} as const;

const mapLivePerformance = (row: DbLiveRow): LivePerformance => ({
	eventId: row.event_id,
	playerId: row.element_id,
	minutes: row.minutes,
	goalsScored: row.goals_scored,
	assists: row.assists,
	cleanSheets: row.clean_sheets,
	goalsConceded: row.goals_conceded,
	ownGoals: row.own_goals,
	penaltiesSaved: row.penalties_saved,
	penaltiesMissed: row.penalties_missed,
	yellowCards: row.yellow_cards,
	redCards: row.red_cards,
	saves: row.saves,
	bonus: row.bonus,
	bps: row.bps,
	starts: row.starts,
	defensiveContribution: row.defensive_contribution,
	expectedGoals: row.expected_goals,
	expectedAssists: row.expected_assists,
	expectedGoalInvolvements: row.expected_goal_involvements,
	expectedGoalsConceded: row.expected_goals_conceded,
	inDreamTeam: row.in_dream_team,
	totalPoints: row.total_points,
});

const asNumber = (value: unknown): number | null => {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}
	if (typeof value === "string") {
		const parsed = Number.parseFloat(value);
		return Number.isFinite(parsed) ? parsed : null;
	}
	return null;
};

const asBoolean = (value: unknown): boolean | null => {
	if (typeof value === "boolean") {
		return value;
	}
	if (typeof value === "number") {
		return value === 1 ? true : value === 0 ? false : null;
	}
	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase();
		if (normalized === "true" || normalized === "1") {
			return true;
		}
		if (normalized === "false" || normalized === "0") {
			return false;
		}
	}
	return null;
};

const asString = (value: unknown): string | null => (typeof value === "string" ? value : null);

const parseJsonUnknown = (value: string): unknown | null => {
	try {
		return JSON.parse(value) as unknown;
	} catch {
		return null;
	}
};

const deleteMalformedCache = async (context: GraphQLContext, key: string): Promise<void> => {
	try {
		await context.redis.del(key);
	} catch (error) {
		context.logger.warn({ err: error, key }, "Failed to evict malformed live cache");
	}
};

const isLivePerformance = (value: unknown): value is LivePerformance => {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const row = value as Record<string, unknown>;
	return (
		typeof row.eventId === "number" &&
		typeof row.playerId === "number" &&
		Number.isFinite(row.eventId) &&
		Number.isFinite(row.playerId) &&
		typeof row.totalPoints === "number"
	);
};

const isLiveExplain = (value: unknown): value is LiveExplain => {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const explain = value as Record<string, unknown>;
	return (
		typeof explain.eventId === "number" &&
		typeof explain.elementId === "number" &&
		Number.isFinite(explain.eventId) &&
		Number.isFinite(explain.elementId) &&
		typeof explain.stats === "object" &&
		explain.stats !== null &&
		Array.isArray(explain.breakdown)
	);
};

export const mapSyncJobLiveRow = (raw: unknown): LivePerformance | null => {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return null;
	}
	const row = raw as Record<string, unknown>;

	const eventId = asNumber(row.eventId ?? row.event_id);
	const elementId = asNumber(row.elementId ?? row.element_id);
	if (eventId === null || elementId === null) {
		return null;
	}

	const startsRaw = row.starts ?? row.starts;
	const startsValue = asBoolean(startsRaw);

	return {
		eventId: Math.trunc(eventId),
		playerId: Math.trunc(elementId),
		minutes: asNumber(row.minutes),
		goalsScored: asNumber(row.goalsScored ?? row.goals_scored),
		assists: asNumber(row.assists),
		cleanSheets: asNumber(row.cleanSheets ?? row.clean_sheets),
		goalsConceded: asNumber(row.goalsConceded ?? row.goals_conceded),
		ownGoals: asNumber(row.ownGoals ?? row.own_goals),
		penaltiesSaved: asNumber(row.penaltiesSaved ?? row.penalties_saved),
		penaltiesMissed: asNumber(row.penaltiesMissed ?? row.penalties_missed),
		yellowCards: asNumber(row.yellowCards ?? row.yellow_cards),
		redCards: asNumber(row.redCards ?? row.red_cards),
		saves: asNumber(row.saves),
		bonus: asNumber(row.bonus),
		bps: asNumber(row.bps),
		starts: startsValue,
		defensiveContribution: asNumber(row.defensiveContribution ?? row.defensive_contribution),
		expectedGoals: asString(row.expectedGoals ?? row.expected_goals) ?? null,
		expectedAssists: asString(row.expectedAssists ?? row.expected_assists) ?? null,
		expectedGoalInvolvements:
			asString(row.expectedGoalInvolvements ?? row.expected_goal_involvements) ?? null,
		expectedGoalsConceded:
			asString(row.expectedGoalsConceded ?? row.expected_goals_conceded) ?? null,
		inDreamTeam: asBoolean(row.inDreamTeam ?? row.in_dream_team),
		totalPoints: asNumber(row.totalPoints ?? row.total_points) ?? 0,
	};
};

const parseEventLiveHashEntries = (
	hashEntries: Record<string, string>,
	eventId: number
): Map<number, LivePerformance> => {
	const performances = new Map<number, LivePerformance>();
	for (const [field, fieldValue] of Object.entries(hashEntries)) {
		const parsed = parseJsonUnknown(fieldValue);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			continue;
		}
		const perf = mapSyncJobLiveRow(parsed);
		if (perf && String(perf.playerId) === field && perf.eventId === eventId) {
			performances.set(perf.playerId, perf);
		}
	}
	return performances;
};

const parseNumericValue = (value: unknown): number | null => {
	if (typeof value === "number") {
		return Number.isFinite(value) ? value : null;
	}
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (trimmed.length === 0) {
			return null;
		}
		const parsed = Number.parseFloat(trimmed);
		return Number.isFinite(parsed) ? parsed : null;
	}
	return null;
};

const parseIntegerValue = (value: unknown): number | null => {
	const parsed = parseNumericValue(value);
	return parsed === null ? null : Math.trunc(parsed);
};

const parseBooleanValue = (value: unknown): boolean | null => {
	if (typeof value === "boolean") {
		return value;
	}
	if (typeof value === "number") {
		if (value === 1) {
			return true;
		}
		if (value === 0) {
			return false;
		}
	}
	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase();
		if (normalized === "true" || normalized === "t") {
			return true;
		}
		if (normalized === "false" || normalized === "f") {
			return false;
		}
		if (normalized === "1") {
			return true;
		}
		if (normalized === "0") {
			return false;
		}
	}
	return null;
};

const pickRecordValue = (
	source: Record<string, unknown> | null | undefined,
	...keys: string[]
): unknown => {
	if (!source) {
		return null;
	}
	for (const key of keys) {
		if (Object.hasOwn(source, key)) {
			const value = source[key];
			if (value !== undefined) {
				return value;
			}
		}
	}
	return null;
};

const parseArrayValue = <T>(value: unknown): T[] | null => {
	if (Array.isArray(value)) {
		return value as T[];
	}
	if (typeof value === "string") {
		try {
			const parsed: unknown = JSON.parse(value);
			return Array.isArray(parsed) ? (parsed as T[]) : null;
		} catch {
			return null;
		}
	}
	return null;
};

const mapLiveExplainStats = (statsValue: DbLiveExplainStats | null): LiveExplainStats => {
	const stats: DbLiveExplainStats = statsValue ?? {};
	return {
		minutes: parseIntegerValue(pickRecordValue(stats, "minutes")),
		goalsScored: parseIntegerValue(pickRecordValue(stats, "goals_scored", "goalsScored")),
		assists: parseIntegerValue(pickRecordValue(stats, "assists")),
		cleanSheets: parseIntegerValue(pickRecordValue(stats, "clean_sheets", "cleanSheets")),
		goalsConceded: parseIntegerValue(pickRecordValue(stats, "goals_conceded", "goalsConceded")),
		ownGoals: parseIntegerValue(pickRecordValue(stats, "own_goals", "ownGoals")),
		penaltiesSaved: parseIntegerValue(pickRecordValue(stats, "penalties_saved", "penaltiesSaved")),
		penaltiesMissed: parseIntegerValue(
			pickRecordValue(stats, "penalties_missed", "penaltiesMissed")
		),
		yellowCards: parseIntegerValue(pickRecordValue(stats, "yellow_cards", "yellowCards")),
		redCards: parseIntegerValue(pickRecordValue(stats, "red_cards", "redCards")),
		saves: parseIntegerValue(pickRecordValue(stats, "saves")),
		bonus: parseIntegerValue(pickRecordValue(stats, "bonus")),
		bps: parseIntegerValue(pickRecordValue(stats, "bps")),
		influence: parseNumericValue(pickRecordValue(stats, "influence")),
		creativity: parseNumericValue(pickRecordValue(stats, "creativity")),
		threat: parseNumericValue(pickRecordValue(stats, "threat")),
		ictIndex: parseNumericValue(pickRecordValue(stats, "ict_index", "ictIndex")),
		clearancesBlocksInterceptions: parseIntegerValue(
			pickRecordValue(stats, "clearances_blocks_interceptions", "clearancesBlocksInterceptions")
		),
		recoveries: parseIntegerValue(pickRecordValue(stats, "recoveries")),
		tackles: parseIntegerValue(pickRecordValue(stats, "tackles")),
		defensiveContribution: parseIntegerValue(
			pickRecordValue(stats, "defensive_contribution", "defensiveContribution")
		),
		starts: parseIntegerValue(pickRecordValue(stats, "starts")),
		expectedGoals: parseNumericValue(pickRecordValue(stats, "expected_goals", "expectedGoals")),
		expectedAssists: parseNumericValue(
			pickRecordValue(stats, "expected_assists", "expectedAssists")
		),
		expectedGoalInvolvements: parseNumericValue(
			pickRecordValue(stats, "expected_goal_involvements", "expectedGoalInvolvements")
		),
		expectedGoalsConceded: parseNumericValue(
			pickRecordValue(stats, "expected_goals_conceded", "expectedGoalsConceded")
		),
		totalPoints: parseIntegerValue(pickRecordValue(stats, "total_points", "totalPoints")),
		inDreamTeam: parseBooleanValue(pickRecordValue(stats, "in_dreamteam", "inDreamTeam")),
	};
};

const mapLiveExplainBreakdownStat = (
	stat: DbLiveExplainBreakdownStat | null
): LiveExplainStatContribution | null => {
	if (!stat || typeof stat !== "object" || Array.isArray(stat)) {
		return null;
	}
	const identifierValue = pickRecordValue(stat, "identifier");
	const identifier = typeof identifierValue === "string" ? identifierValue : null;
	if (!identifier || identifier.trim().length === 0) {
		return null;
	}
	return {
		identifier,
		points: parseIntegerValue(pickRecordValue(stat, "points")) ?? 0,
		value: parseNumericValue(pickRecordValue(stat, "value")),
		pointsModification: parseIntegerValue(
			pickRecordValue(stat, "points_modification", "pointsModification")
		),
	};
};

const mapLiveExplainBreakdown = (
	explainValue: DbLiveExplainBreakdown[] | null
): LiveExplainBreakdown[] => {
	if (!explainValue) {
		return [];
	}
	const breakdowns: LiveExplainBreakdown[] = [];
	for (const entry of explainValue) {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
			continue;
		}
		const fixtureId = parseIntegerValue(pickRecordValue(entry, "fixture", "fixtureId"));
		if (fixtureId === null) {
			continue;
		}
		const rawStats = Array.isArray(entry.stats)
			? entry.stats
			: parseArrayValue<DbLiveExplainBreakdownStat>(entry.stats ?? null);
		const statsList = (rawStats ?? [])
			.map((s) => mapLiveExplainBreakdownStat(s ?? null))
			.filter((s): s is LiveExplainStatContribution => s !== null);
		breakdowns.push({ fixtureId, stats: statsList });
	}
	return breakdowns;
};

const mapBreakdownFromEventLiveRow = (row: DbLiveExplainRow): LiveExplainBreakdown[] => {
	const arr = parseArrayValue<DbLiveExplainBreakdown>(row.explain ?? null);
	return mapLiveExplainBreakdown(arr);
};

const FLAT_LIVE_EXPLAIN_STATS = [
	{ identifier: "minutes", value: ["minutes"], points: ["minutes_points", "minutesPoints"] },
	{
		identifier: "goals_scored",
		value: ["goals_scored", "goalsScored"],
		points: ["goals_scored_points", "goalsScoredPoints"],
	},
	{ identifier: "assists", value: ["assists"], points: ["assists_points", "assistsPoints"] },
	{
		identifier: "clean_sheets",
		value: ["clean_sheets", "cleanSheets"],
		points: ["clean_sheets_points", "cleanSheetsPoints"],
	},
	{
		identifier: "goals_conceded",
		value: ["goals_conceded", "goalsConceded"],
		points: ["goals_conceded_points", "goalsConcededPoints"],
	},
	{
		identifier: "own_goals",
		value: ["own_goals", "ownGoals"],
		points: ["own_goals_points", "ownGoalsPoints"],
	},
	{
		identifier: "penalties_saved",
		value: ["penalties_saved", "penaltiesSaved"],
		points: ["penalties_saved_points", "penaltiesSavedPoints"],
	},
	{
		identifier: "penalties_missed",
		value: ["penalties_missed", "penaltiesMissed"],
		points: ["penalties_missed_points", "penaltiesMissedPoints"],
	},
	{
		identifier: "yellow_cards",
		value: ["yellow_cards", "yellowCards"],
		points: ["yellow_cards_points", "yellowCardsPoints"],
	},
	{
		identifier: "red_cards",
		value: ["red_cards", "redCards"],
		points: ["red_cards_points", "redCardsPoints"],
	},
	{ identifier: "saves", value: ["saves"], points: ["saves_points", "savesPoints"] },
] as const;

const mapFlatLiveExplainContributions = (
	row: Record<string, unknown> | null
): LiveExplainStatContribution[] => {
	if (!row) return [];
	const contributions: LiveExplainStatContribution[] = [];
	for (const definition of FLAT_LIVE_EXPLAIN_STATS) {
		const value = parseNumericValue(pickRecordValue(row, ...definition.value));
		const points = parseIntegerValue(pickRecordValue(row, ...definition.points));
		if ((value ?? 0) === 0 && (points ?? 0) === 0) continue;
		contributions.push({
			identifier: definition.identifier,
			value,
			points: points ?? 0,
			pointsModification: null,
		});
	}
	const bonus = parseIntegerValue(pickRecordValue(row, "bonus"));
	if ((bonus ?? 0) !== 0) {
		contributions.push({
			identifier: "bonus",
			value: bonus,
			points: bonus ?? 0,
			pointsModification: null,
		});
	}
	return contributions;
};

async function fetchPlayerStatsForLiveExplains(
	context: GraphQLContext,
	eventId: number,
	elementIds: number[]
): Promise<Map<number, DbLiveExplainStats>> {
	if (elementIds.length === 0) return new Map();
	const { data, error } = await context.supabase
		.from("player_stats")
		.select("*")
		.eq("event_id", eventId)
		.in("element_id", elementIds);

	if (error) {
		context.logger.warn(
			{ err: error, eventId, elementIds },
			"player_stats batch query failed for event live explains"
		);
		return new Map();
	}
	const rows = new Map<number, DbLiveExplainStats>();
	for (const raw of (data ?? []) as unknown[]) {
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
		const row = raw as DbLiveExplainStats;
		const elementId = parseIntegerValue(pickRecordValue(row, "element_id", "elementId"));
		if (elementId !== null && elementIds.includes(elementId)) rows.set(elementId, row);
	}
	return rows;
}

type LiveExplainRedisSupplement = {
	breakdown: LiveExplainBreakdown[];
	contributions: LiveExplainStatContribution[];
};

const parseEventLiveExplainRedisSupplement = (
	raw: string | null
): LiveExplainRedisSupplement | null => {
	if (raw === null || raw.length === 0) return null;
	const parsed = parseJsonUnknown(raw);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
	const o = parsed as Record<string, unknown>;
	const ex = o.explain;
	const arr: DbLiveExplainBreakdown[] | null =
		ex === undefined || ex === null
			? null
			: Array.isArray(ex)
				? (ex as DbLiveExplainBreakdown[])
				: parseArrayValue<DbLiveExplainBreakdown>(ex);
	const breakdown = mapLiveExplainBreakdown(arr);
	const contributions = mapFlatLiveExplainContributions(o);
	return breakdown.length > 0 || contributions.length > 0 ? { breakdown, contributions } : null;
};

/** Read legacy fixture breakdowns or the producer's compact stat contributions from Redis. */
async function loadBreakdownsFromEventLiveExplainRedis(
	context: GraphQLContext,
	eventId: number,
	elementIds: number[]
): Promise<Map<number, LiveExplainRedisSupplement>> {
	if (elementIds.length === 0) return new Map();
	const season = await getCurrentSeason(context);
	const hashKey = redisKey.eventLiveExplain(season, eventId);
	let values: Array<string | null>;
	try {
		values = await context.redis.hmget(hashKey, ...elementIds.map(String));
	} catch (error) {
		context.logger.warn(
			{ err: error, hashKey, eventId, elementIds },
			"Redis HMGET EventLiveExplain failed"
		);
		return new Map();
	}
	const supplements = new Map<number, LiveExplainRedisSupplement>();
	for (const [index, elementId] of elementIds.entries()) {
		const parsed = parseEventLiveExplainRedisSupplement(values[index] ?? null);
		if (parsed) supplements.set(elementId, parsed);
	}
	return supplements;
}

type EventLiveExplainElementColumn = "element_id" | "element";
const eventLiveExplainElementColumn = new WeakMap<object, EventLiveExplainElementColumn>();

async function fetchEventLiveExplainsFromSupabase(
	context: GraphQLContext,
	eventId: number,
	elementIds: number[]
): Promise<Map<number, DbLiveExplainRow>> {
	if (elementIds.length === 0) return new Map();
	const clientKey = context.supabase as object;
	const cachedColumn = eventLiveExplainElementColumn.get(clientKey);
	const candidates: EventLiveExplainElementColumn[] = cachedColumn
		? [cachedColumn, cachedColumn === "element_id" ? "element" : "element_id"]
		: ["element_id", "element"];

	for (const column of candidates) {
		const { data, error } = await context.supabase
			.from("event_live_explains")
			.select("*")
			.eq("event_id", eventId)
			.in(column, elementIds);

		if (!error) {
			eventLiveExplainElementColumn.set(clientKey, column);
			const rows = new Map<number, DbLiveExplainRow>();
			for (const raw of (data ?? []) as unknown[]) {
				if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
				const row = raw as DbLiveExplainRow;
				const elementId = parseIntegerValue(pickRecordValue(row, "element_id", "element"));
				if (elementId !== null && elementIds.includes(elementId)) rows.set(elementId, row);
			}
			return rows;
		}
		if (isMissingPostgrestColumnError(error, column)) {
			continue;
		}
		context.logger.error(
			{ err: error, eventId, elementIds },
			"event_live_explains batch query failed"
		);
		throw new Error("Failed to fetch event live explain", { cause: error });
	}

	throw new Error("event_live_explains has no supported element column");
}

export type LiveScoresFilter = {
	inDreamTeam?: boolean | null;
	minTotalPoints?: number | null;
	maxTotalPoints?: number | null;
};

export const applyLiveScoresFilter = (
	results: LivePerformance[],
	filter?: LiveScoresFilter | null
): LivePerformance[] => {
	let out = results;
	if (filter?.inDreamTeam !== undefined && filter.inDreamTeam !== null) {
		out = out.filter((p) => p.inDreamTeam === filter.inDreamTeam);
	}
	const minTotalPoints = filter?.minTotalPoints;
	if (minTotalPoints !== undefined && minTotalPoints !== null) {
		out = out.filter((p) => p.totalPoints >= minTotalPoints);
	}
	const maxTotalPoints = filter?.maxTotalPoints;
	if (maxTotalPoints !== undefined && maxTotalPoints !== null) {
		out = out.filter((p) => p.totalPoints <= maxTotalPoints);
	}
	return out;
};

export type EventLive = {
	eventId: number;
	performances: LivePerformance[];
};

interface LiveRepository {
	getLiveScores(
		context: GraphQLContext,
		eventId?: number,
		filter?: LiveScoresFilter | null
	): Promise<LivePerformance[]>;
	getPlayerLive(
		context: GraphQLContext,
		playerId: number,
		eventId?: number
	): Promise<LivePerformance | null>;
	getEventLive(context: GraphQLContext, eventId: number): Promise<EventLive>;
	getEventLiveExplain(
		context: GraphQLContext,
		eventId: number,
		elementId: number
	): Promise<LiveExplain | null>;
	getEventLiveExplains(
		context: GraphQLContext,
		eventId: number,
		elementIds: number[],
		mode?: LiveExplainReadMode
	): Promise<LiveExplain[]>;
	getLivePerformancesByPlayerIds(
		context: GraphQLContext,
		eventId: number,
		playerIds: number[]
	): Promise<LivePerformance[]>;
	getLivePerformancesForEventsAndPlayers(
		context: GraphQLContext,
		eventIds: number[],
		playerIds: number[]
	): Promise<LivePerformance[]>;
	getAllLivePerformances(
		context: GraphQLContext,
		eventId: number
	): Promise<Map<number, LivePerformance>>;
	getSelectedByPercent(
		context: GraphQLContext,
		eventId: number,
		elementId: number
	): Promise<number | null>;
}

const SELECTED_BY_REDIS_TTL_SEC = 3600;

async function resolveSelectedByPercent(
	context: GraphQLContext,
	eventId: number,
	elementId: number
): Promise<number | null> {
	const season = await getCurrentSeason(context);
	const hashKey = redisKey.playerSelectedBy(season, eventId);
	const field = String(elementId);

	const cached = await context.redis.hget(hashKey, field);
	if (cached) {
		try {
			const row = JSON.parse(cached) as SelectedByCacheRow;
			return parseNumericValue(row.selected_by_percent);
		} catch (error) {
			context.logger.warn(
				{ err: error, hashKey, field },
				"Invalid JSON in PlayerStatsSelected cache"
			);
		}
	}

	const { data, error } = await context.supabase
		.from("player_stats")
		.select("selected_by_percent")
		.eq("event_id", eventId)
		.eq("element_id", elementId)
		.limit(1);

	if (error) {
		context.logger.warn(
			{ err: error, eventId, elementId },
			"player_stats selected_by_percent query failed"
		);
	} else {
		const row = data?.[0] as { selected_by_percent?: number | string | null } | undefined;
		const pct = parseNumericValue(row?.selected_by_percent ?? null);
		if (pct !== null) {
			const cacheRow: SelectedByCacheRow = {
				selected_by_percent: row?.selected_by_percent,
			};
			await context.redis.hset(hashKey, field, JSON.stringify(cacheRow));
			await context.redis.expire(hashKey, SELECTED_BY_REDIS_TTL_SEC);
			return pct;
		}
	}

	// selected_by_percent does not exist on the players table; player_stats is the only source.
	return null;
}

const EVENT_LIVES_PROJECTION = [
	"event_id",
	"element_id",
	"minutes",
	"goals_scored",
	"assists",
	"clean_sheets",
	"goals_conceded",
	"own_goals",
	"penalties_saved",
	"penalties_missed",
	"yellow_cards",
	"red_cards",
	"saves",
	"bonus",
	"bps",
	"starts",
	"defensive_contribution",
	"expected_goals",
	"expected_assists",
	"expected_goal_involvements",
	"expected_goals_conceded",
	"in_dream_team",
	"total_points",
].join(", ");

const _fetchLivePerformanceFromDbByPlayerIds = async (
	context: GraphQLContext,
	eventId: number,
	playerIds: number[]
): Promise<LivePerformance[]> => {
	const uniqueIds = Array.from(new Set(playerIds.filter((id) => Number.isFinite(id) && id > 0)));
	if (uniqueIds.length === 0) {
		return [];
	}

	const { data, error } = await context.supabase
		.from("event_lives")
		.select(EVENT_LIVES_PROJECTION)
		.eq("event_id", eventId)
		.in("element_id", uniqueIds);

	if (error) {
		context.logger.error(
			{ err: error, eventId, playerIds: uniqueIds },
			"Failed to fetch live performances by player IDs"
		);
		throw new Error("Failed to fetch live performances");
	}

	return (data as unknown as DbLiveRow[] | null)?.map(mapLivePerformance) ?? [];
};

const fetchLivePerformanceFromDbByEventsAndPlayerIds = async (
	context: GraphQLContext,
	eventIds: number[],
	playerIds: number[]
): Promise<LivePerformance[]> => {
	const uniqueEventIds = Array.from(
		new Set(eventIds.filter((id) => Number.isFinite(id) && id > 0))
	);
	const uniquePlayerIds = Array.from(
		new Set(playerIds.filter((id) => Number.isFinite(id) && id > 0))
	);
	if (uniqueEventIds.length === 0 || uniquePlayerIds.length === 0) {
		return [];
	}

	const { data, error } = await context.supabase
		.from("event_lives")
		.select(EVENT_LIVES_PROJECTION)
		.in("event_id", uniqueEventIds)
		.in("element_id", uniquePlayerIds);

	if (error) {
		context.logger.error(
			{ err: error, eventIds: uniqueEventIds, playerIds: uniquePlayerIds },
			"Failed to fetch historical live performances by event and player IDs"
		);
		throw new Error("Failed to fetch historical live performances");
	}

	return (data as unknown as DbLiveRow[] | null)?.map(mapLivePerformance) ?? [];
};

const fetchAllLivePerformanceFromDb = async (
	context: GraphQLContext,
	eventId: number
): Promise<LivePerformance[]> => {
	const { data, error } = await context.supabase
		.from("event_lives")
		.select(EVENT_LIVES_PROJECTION)
		.eq("event_id", eventId);

	if (error) {
		context.logger.error({ err: error, eventId }, "Failed to fetch all live performances from DB");
		throw new Error("Failed to fetch live performances");
	}

	return (data as unknown as DbLiveRow[] | null)?.map(mapLivePerformance) ?? [];
};

type LiveRedisSnapshot = {
	meta: LiveSnapshotMeta | null;
	performances: Map<number, LivePerformance>;
};

const isStringRecord = (value: unknown): value is Record<string, string> =>
	typeof value === "object" &&
	value !== null &&
	!Array.isArray(value) &&
	Object.values(value).every((entry) => typeof entry === "string");

const loadEventLiveFromRedis = async (
	context: GraphQLContext,
	eventId: number,
	season: string
): Promise<LiveRedisSnapshot | null> => {
	const hashKey = redisKey.eventLive(season, eventId);
	const metaKey = liveSnapshotMetaKey(season, eventId);

	let hashEntries: Record<string, string>;
	let rawMeta: string | null;
	try {
		// MULTI makes the metadata revision and EventLive hash one read snapshot.
		// Lightweight test doubles may not implement it, so preserve a sequential
		// compatibility path for repository tests and non-ioredis adapters.
		if (typeof context.redis.multi === "function") {
			const result = await context.redis.multi().get(metaKey).hgetall(hashKey).exec();
			if (!result || result.length !== 2) {
				throw new Error("Live snapshot Redis read transaction was aborted");
			}
			const metaResult = result[0];
			const hashResult = result[1];
			if (metaResult[0]) throw metaResult[0];
			if (hashResult[0]) throw hashResult[0];
			rawMeta = typeof metaResult[1] === "string" ? metaResult[1] : null;
			hashEntries = isStringRecord(hashResult[1]) ? hashResult[1] : {};
		} else {
			[rawMeta, hashEntries] = await Promise.all([
				context.redis.get(metaKey),
				context.redis.hgetall(hashKey),
			]);
		}
	} catch (error) {
		context.logger.warn(
			{ err: error, hashKey, metaKey },
			"Failed to read EventLive hash from Redis, falling back to DB"
		);
		const meta = await loadLiveSnapshotMeta(context, eventId, { season });
		if (meta && isLiveSnapshotConsistencyActive(context, eventId)) {
			throw new LiveSnapshotCoherenceError(
				eventId,
				"EventLive",
				`EventLive view unavailable for revision ${meta.revision}`
			);
		}
		return null;
	}

	const meta = parseLiveSnapshotMeta(rawMeta, { season, eventId });
	rememberLiveSnapshotMeta(context, meta, season, eventId);
	const performances = parseEventLiveHashEntries(hashEntries, eventId);
	if (meta && performances.size !== meta.eventLiveCount) {
		context.logger.warn(
			{
				hashKey,
				revision: meta.revision,
				expectedCount: meta.eventLiveCount,
				actualCount: performances.size,
			},
			"Incomplete EventLive revision"
		);
		if (isLiveSnapshotConsistencyActive(context, eventId)) {
			throw new LiveSnapshotCoherenceError(
				eventId,
				"EventLive",
				`Incomplete EventLive revision ${meta.revision}`
			);
		}
		return { meta, performances: new Map() };
	}
	return { meta, performances };
};

const LIVE_REVISION_CACHE_TTL_SEC = 180;
const LIVE_FALLBACK_CACHE_TTL_SEC = 15;
const LIVE_EXPLAIN_REVISION_CACHE_TTL_SEC = 300;
const LIVE_EXPLAIN_FALLBACK_CACHE_TTL_SEC = 15;

const shapedLiveExplainCacheKey = (
	season: string,
	eventId: number,
	elementId: number,
	meta: LiveSnapshotMeta | null,
	databaseFallback: boolean,
	mode: LiveExplainReadMode
): string =>
	meta
		? gqlCacheKey(
				season,
				`live:explain:${eventId}:${elementId}:${mode}:revision:${meta.revision}${databaseFallback ? ":fallback15" : ""}`
			)
		: gqlCacheKey(season, `live:explain:${eventId}:${elementId}:${mode}:fallback15`);

const liveAllFlights = new WeakMap<object, Map<string, Promise<Map<number, LivePerformance>>>>();

const getLiveAllFlightMap = (
	context: GraphQLContext
): Map<string, Promise<Map<number, LivePerformance>>> => {
	const redisIdentity = context.redis as object;
	let flights = liveAllFlights.get(redisIdentity);
	if (!flights) {
		flights = new Map();
		liveAllFlights.set(redisIdentity, flights);
	}
	return flights;
};

const shapedLiveCacheKey = (
	season: string,
	eventId: number,
	meta: LiveSnapshotMeta | null
): string =>
	meta
		? gqlCacheKey(season, `live:all:${eventId}:revision:${meta.revision}`)
		: gqlCacheKey(season, `live:all:${eventId}:fallback15`);

const shapedLiveFallbackCacheKey = (
	season: string,
	eventId: number,
	meta: LiveSnapshotMeta | null
): string =>
	meta
		? gqlCacheKey(season, `live:all:${eventId}:revision:${meta.revision}:fallback15`)
		: shapedLiveCacheKey(season, eventId, null);

const readShapedLiveCache = async (
	context: GraphQLContext,
	cacheKey: string
): Promise<Map<number, LivePerformance> | null> => {
	let cached: string | null;
	try {
		cached = await context.redis.get(cacheKey);
	} catch (error) {
		context.logger.warn({ err: error, cacheKey }, "Failed to read shaped live cache");
		return null;
	}
	if (cached === null) return null;
	try {
		const parsed: unknown = JSON.parse(cached);
		if (Array.isArray(parsed) && parsed.every(isLivePerformance)) {
			return new Map(parsed.map((performance) => [performance.playerId, performance]));
		}
	} catch (error) {
		context.logger.warn({ err: error, cacheKey }, "Malformed shaped live cache");
	}
	await deleteMalformedCache(context, cacheKey);
	return null;
};

const readRequestedLiveCache = async (
	context: GraphQLContext,
	eventId: number,
	meta: LiveSnapshotMeta | null,
	cacheKey: string,
	fallbackKey: string
): Promise<Map<number, LivePerformance> | null> => {
	const cached = await readShapedLiveCache(context, cacheKey);
	if (cached) return cached;
	if (fallbackKey === cacheKey) return null;

	const fallback = await readShapedLiveCache(context, fallbackKey);
	if (fallback && meta && isLiveSnapshotConsistencyActive(context, eventId)) {
		throw new LiveSnapshotCoherenceError(
			eventId,
			"EventLive",
			`Database fallback cache is active for EventLive revision ${meta.revision}`
		);
	}
	return fallback;
};

const writeShapedLiveCache = async (
	context: GraphQLContext,
	cacheKey: string,
	performances: Map<number, LivePerformance>,
	ttlSeconds: number,
	cacheEmpty = false
): Promise<void> => {
	if (performances.size === 0 && !cacheEmpty) return;
	try {
		await context.redis.set(
			cacheKey,
			JSON.stringify(Array.from(performances.values())),
			"EX",
			ttlSeconds
		);
	} catch (error) {
		context.logger.warn({ err: error, cacheKey }, "Failed to write shaped live cache");
	}
};

const loadLivePerformanceDbFallback = async (
	context: GraphQLContext,
	eventId: number,
	season: string,
	meta: LiveSnapshotMeta | null
): Promise<Map<number, LivePerformance>> => {
	const cacheKey = shapedLiveFallbackCacheKey(season, eventId, meta);
	const cached = await readShapedLiveCache(context, cacheKey);
	if (cached) return cached;

	const flights = getLiveAllFlightMap(context);
	const flightKey = `database:${cacheKey}`;
	const existingFlight = flights.get(flightKey);
	if (existingFlight) return new Map(await existingFlight);

	const flight = (async (): Promise<Map<number, LivePerformance>> => {
		const cacheAfterFlightElection = await readShapedLiveCache(context, cacheKey);
		if (cacheAfterFlightElection) return cacheAfterFlightElection;

		const fromDb = new Map(
			(await fetchAllLivePerformanceFromDb(context, eventId)).map((performance) => [
				performance.playerId,
				performance,
			])
		);
		await writeShapedLiveCache(context, cacheKey, fromDb, LIVE_FALLBACK_CACHE_TTL_SEC, true);
		return fromDb;
	})();
	flights.set(flightKey, flight);
	try {
		return new Map(await flight);
	} finally {
		if (flights.get(flightKey) === flight) flights.delete(flightKey);
	}
};

export const liveRepository: LiveRepository = {
	async getAllLivePerformances(
		context: GraphQLContext,
		eventId: number
	): Promise<Map<number, LivePerformance>> {
		if (!eventId || !Number.isFinite(eventId) || eventId <= 0) {
			return new Map();
		}
		const season = await getCurrentSeason(context);
		const requestedMeta = await loadLiveSnapshotMeta(context, eventId, { season });
		if (isLiveSnapshotDatabaseFallback(context, eventId)) {
			return loadLivePerformanceDbFallback(context, eventId, season, requestedMeta);
		}
		const requestedCacheKey = shapedLiveCacheKey(season, eventId, requestedMeta);
		const requestedFallbackKey = shapedLiveFallbackCacheKey(season, eventId, requestedMeta);
		const cached = await readRequestedLiveCache(
			context,
			eventId,
			requestedMeta,
			requestedCacheKey,
			requestedFallbackKey
		);
		if (cached) return cached;

		const flightKey = `${season}:${eventId}:${requestedMeta?.revision ?? "fallback"}`;
		const flights = getLiveAllFlightMap(context);
		const existingFlight = flights.get(flightKey);
		if (existingFlight) return new Map(await existingFlight);

		const flight = (async (): Promise<Map<number, LivePerformance>> => {
			// A sibling request may have populated the cache before this flight won.
			const cacheAfterFlightElection = await readRequestedLiveCache(
				context,
				eventId,
				requestedMeta,
				requestedCacheKey,
				requestedFallbackKey
			);
			if (cacheAfterFlightElection) return cacheAfterFlightElection;

			const redisSnapshot = await loadEventLiveFromRedis(context, eventId, season);
			if (redisSnapshot && redisSnapshot.performances.size > 0) {
				const actualKey = shapedLiveCacheKey(season, eventId, redisSnapshot.meta);
				if (actualKey !== requestedCacheKey) {
					const actualCached = await readShapedLiveCache(context, actualKey);
					if (actualCached) return actualCached;
				}
				await writeShapedLiveCache(
					context,
					actualKey,
					redisSnapshot.performances,
					redisSnapshot.meta ? LIVE_REVISION_CACHE_TTL_SEC : LIVE_FALLBACK_CACHE_TTL_SEC
				);
				return redisSnapshot.performances;
			}

			// A missing required Redis view means the metadata revision is not safe
			// for caching. Keep DB recovery bounded to fifteen seconds so the Data
			// producer's next repair is visible immediately through a revision key.
			return loadLivePerformanceDbFallback(
				context,
				eventId,
				season,
				redisSnapshot?.meta ?? requestedMeta
			);
		})();
		flights.set(flightKey, flight);
		try {
			return new Map(await flight);
		} finally {
			if (flights.get(flightKey) === flight) flights.delete(flightKey);
		}
	},

	async getLiveScores(
		context: GraphQLContext,
		eventId?: number,
		filter?: LiveScoresFilter | null
	): Promise<LivePerformance[]> {
		let targetEventId = eventId;

		if (!targetEventId) {
			const currentId = await getCurrentEventId(context);
			if (!currentId) {
				return [];
			}
			targetEventId = currentId;
		}

		if (!Number.isFinite(targetEventId) || targetEventId <= 0) {
			return [];
		}

		const performances = await this.getAllLivePerformances(context, targetEventId);
		return applyLiveScoresFilter(Array.from(performances.values()), filter);
	},

	async getPlayerLive(
		context: GraphQLContext,
		playerId: number,
		eventId?: number
	): Promise<LivePerformance | null> {
		let targetEventId = eventId;

		if (!targetEventId) {
			const currentId = await getCurrentEventId(context);
			if (!currentId) {
				return null;
			}
			targetEventId = currentId;
		}

		const performances = await this.getLivePerformancesByPlayerIds(context, targetEventId, [
			playerId,
		]);
		return performances.find((p) => p.playerId === playerId) ?? null;
	},

	async getEventLive(context: GraphQLContext, eventId: number): Promise<EventLive> {
		const allPerformances = await this.getAllLivePerformances(context, eventId);
		return {
			eventId,
			performances: Array.from(allPerformances.values()),
		};
	},

	async getEventLiveExplain(
		context: GraphQLContext,
		eventId: number,
		elementId: number
	): Promise<LiveExplain | null> {
		return (await this.getEventLiveExplains(context, eventId, [elementId]))[0] ?? null;
	},

	async getEventLiveExplains(
		context: GraphQLContext,
		eventId: number,
		elementIds: number[],
		mode: LiveExplainReadMode = "full"
	): Promise<LiveExplain[]> {
		if (!Number.isFinite(eventId) || eventId <= 0) return [];
		const uniqueIds = Array.from(
			new Set(elementIds.filter((id) => Number.isInteger(id) && id > 0))
		);
		if (uniqueIds.length === 0) return [];

		const season = await getCurrentSeason(context);
		const databaseFallback = isLiveSnapshotDatabaseFallback(context, eventId);
		const meta = await loadLiveSnapshotMeta(context, eventId, {
			season,
			fresh: isLiveSnapshotConsistencyActive(context, eventId),
		});
		const cacheKeys = uniqueIds.map((elementId) =>
			shapedLiveExplainCacheKey(season, eventId, elementId, meta, databaseFallback, mode)
		);
		const cacheTtl =
			databaseFallback || !meta
				? LIVE_EXPLAIN_FALLBACK_CACHE_TTL_SEC
				: LIVE_EXPLAIN_REVISION_CACHE_TTL_SEC;
		let cachedValues: Array<string | null> = uniqueIds.map(() => null);
		try {
			cachedValues =
				typeof context.redis.mget === "function"
					? await context.redis.mget(...cacheKeys)
					: await Promise.all(cacheKeys.map((cacheKey) => context.redis.get(cacheKey)));
		} catch (error) {
			context.logger.warn(
				{ err: error, eventId, elementIds: uniqueIds },
				"Failed to read live explain batch cache"
			);
		}

		const resolved = new Map<number, LiveExplain | null>();
		const malformedKeys: string[] = [];
		for (const [index, elementId] of uniqueIds.entries()) {
			const cachedRaw = cachedValues[index] ?? null;
			if (cachedRaw === null) continue;
			if (cachedRaw === "__null__") {
				resolved.set(elementId, null);
				continue;
			}
			try {
				const parsed: unknown = JSON.parse(cachedRaw);
				if (isLiveExplain(parsed) && parsed.eventId === eventId && parsed.elementId === elementId) {
					resolved.set(elementId, parsed);
					continue;
				}
			} catch (error) {
				context.logger.warn(
					{ err: error, cacheKey: cacheKeys[index] },
					"Malformed live explain cache"
				);
			}
			malformedKeys.push(cacheKeys[index]!);
		}
		await Promise.all(malformedKeys.map((cacheKey) => deleteMalformedCache(context, cacheKey)));

		const missingIds = uniqueIds.filter((elementId) => !resolved.has(elementId));
		if (missingIds.length === 0) {
			return uniqueIds
				.map((elementId) => resolved.get(elementId) ?? null)
				.filter((value): value is LiveExplain => value !== null);
		}

		const redisSupplementById = databaseFallback
			? new Map<number, LiveExplainRedisSupplement>()
			: await loadBreakdownsFromEventLiveExplainRedis(context, eventId, missingIds);
		const eventExplainDatabaseIds =
			mode === "full"
				? missingIds
				: missingIds.filter((elementId) => !redisSupplementById.has(elementId));
		const [playerStatsById, eventExplainById] = await Promise.all([
			mode === "full"
				? fetchPlayerStatsForLiveExplains(context, eventId, missingIds)
				: Promise.resolve(new Map<number, DbLiveExplainStats>()),
			fetchEventLiveExplainsFromSupabase(context, eventId, eventExplainDatabaseIds),
		]);

		const valuesToCache = new Map<string, string>();
		for (const elementId of missingIds) {
			const psRow = playerStatsById.get(elementId) ?? null;
			const elRow = eventExplainById.get(elementId) ?? null;
			const redisSupplement = redisSupplementById.get(elementId) ?? null;
			const cacheKey = shapedLiveExplainCacheKey(
				season,
				eventId,
				elementId,
				meta,
				databaseFallback,
				mode
			);
			if (!psRow && !elRow && !redisSupplement) {
				resolved.set(elementId, null);
				valuesToCache.set(cacheKey, "__null__");
				continue;
			}

			const stats = mapLiveExplainStats(psRow);
			const databaseBreakdown = elRow ? mapBreakdownFromEventLiveRow(elRow) : [];
			const breakdown =
				redisSupplement && redisSupplement.breakdown.length > 0
					? redisSupplement.breakdown
					: databaseBreakdown;
			let contributions = redisSupplement?.contributions ?? [];
			if (contributions.length === 0) contributions = breakdown.flatMap((entry) => entry.stats);
			if (contributions.length === 0) contributions = mapFlatLiveExplainContributions(elRow);

			const result: LiveExplain = {
				eventId,
				elementId,
				modified: elRow ? parseBooleanValue(elRow.modified) : null,
				stats,
				breakdown,
				contributions,
				selectedBy: null,
			};
			resolved.set(elementId, result);
			valuesToCache.set(cacheKey, JSON.stringify(result));
		}

		await Promise.all(
			Array.from(valuesToCache, async ([cacheKey, value]) => {
				try {
					await context.redis.set(cacheKey, value, "EX", cacheTtl);
				} catch (error) {
					context.logger.warn({ err: error, cacheKey }, "Failed to cache live explain");
				}
			})
		);

		return uniqueIds
			.map((elementId) => resolved.get(elementId) ?? null)
			.filter((value): value is LiveExplain => value !== null);
	},

	async getLivePerformancesByPlayerIds(
		context: GraphQLContext,
		eventId: number,
		playerIds: number[]
	): Promise<LivePerformance[]> {
		if (!eventId || !Number.isFinite(eventId) || eventId <= 0) {
			throw new Error("eventId is required to fetch live performances");
		}

		const uniqueIds = Array.from(new Set(playerIds.filter((id) => Number.isFinite(id) && id > 0)));
		if (uniqueIds.length === 0) {
			return [];
		}
		if (isLiveSnapshotDatabaseFallback(context, eventId)) {
			const all = await this.getAllLivePerformances(context, eventId);
			return uniqueIds
				.map((playerId) => all.get(playerId))
				.filter((performance): performance is LivePerformance => performance !== undefined);
		}

		// Use HMGET with specific player IDs — avoids loading all 700+ players via HGETALL.
		const season = await getCurrentSeason(context);
		const hashKey = redisKey.eventLive(season, eventId);
		const meta = await loadLiveSnapshotMeta(context, eventId, { season });
		const readValidatedFallback = async (): Promise<LivePerformance[]> => {
			const all = await this.getAllLivePerformances(context, eventId);
			return uniqueIds
				.map((playerId) => all.get(playerId))
				.filter((performance): performance is LivePerformance => performance !== undefined);
		};
		let values: (string | null)[];
		let hashLength: number;
		try {
			[hashLength, values] = await Promise.all([
				context.redis.hlen(hashKey),
				context.redis.hmget(hashKey, ...uniqueIds.map(String)),
			]);
		} catch (err) {
			context.logger.warn({ err, hashKey }, "EventLive HMGET failed, falling back to DB");
			return meta
				? readValidatedFallback()
				: fetchLivePerformanceFromDbByEventsAndPlayerIds(context, [eventId], uniqueIds);
		}

		if (meta && hashLength !== meta.eventLiveCount) {
			context.logger.warn(
				{
					hashKey,
					revision: meta.revision,
					expectedCount: meta.eventLiveCount,
					actualCount: hashLength,
				},
				"Incomplete EventLive revision during targeted read"
			);
			return readValidatedFallback();
		}

		const results: LivePerformance[] = [];
		const hitIds = new Set<number>();
		for (let i = 0; i < uniqueIds.length; i++) {
			const value = values[i];
			if (!value) continue;
			const parsed = parseJsonUnknown(value);
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
			const perf = mapSyncJobLiveRow(parsed as Record<string, unknown>);
			if (perf && perf.playerId === uniqueIds[i] && perf.eventId === eventId) {
				results.push(perf);
				hitIds.add(uniqueIds[i]);
			}
		}

		const missIds = uniqueIds.filter((id) => !hitIds.has(id));
		if (meta && missIds.length > 0) {
			context.logger.warn(
				{ hashKey, revision: meta.revision, missIds },
				"Malformed or missing EventLive field during targeted read"
			);
			return readValidatedFallback();
		}
		if (missIds.length > 0) {
			const fromDb = await fetchLivePerformanceFromDbByEventsAndPlayerIds(
				context,
				[eventId],
				missIds
			);
			results.push(...fromDb);
		}

		return results;
	},

	getLivePerformancesForEventsAndPlayers(
		context: GraphQLContext,
		eventIds: number[],
		playerIds: number[]
	): Promise<LivePerformance[]> {
		return fetchLivePerformanceFromDbByEventsAndPlayerIds(context, eventIds, playerIds);
	},

	async getSelectedByPercent(
		context: GraphQLContext,
		eventId: number,
		elementId: number
	): Promise<number | null> {
		if (
			!Number.isFinite(eventId) ||
			eventId <= 0 ||
			!Number.isFinite(elementId) ||
			elementId <= 0
		) {
			return null;
		}
		return resolveSelectedByPercent(context, eventId, elementId);
	},
};
