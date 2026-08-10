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
	eventLiveExplainV2: (season: string, eventId: number): string =>
		`EventLiveExplainV2:${season}:${eventId}`,
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
		const trimmed = value.trim();
		if (trimmed.length === 0) return null;
		const parsed = Number(trimmed);
		return Number.isFinite(parsed) ? parsed : null;
	}
	return null;
};

const GRAPHQL_INT_MIN = -2_147_483_648;
const GRAPHQL_INT_MAX = 2_147_483_647;

const pickLiveField = (row: JsonRecord, keys: string[]): { present: boolean; value: unknown } => {
	for (const key of keys) {
		if (Object.hasOwn(row, key)) return { present: true, value: row[key] };
	}
	return { present: false, value: undefined };
};

const parseOptionalNumber = (
	row: JsonRecord,
	keys: string[]
): { value: number | null; valid: boolean } => {
	const field = pickLiveField(row, keys);
	if (!field.present || field.value === null) return { value: null, valid: true };
	const value = asNumber(field.value);
	return {
		value,
		valid:
			value !== null &&
			Number.isInteger(value) &&
			value >= GRAPHQL_INT_MIN &&
			value <= GRAPHQL_INT_MAX,
	};
};

const parseOptionalBoolean = (
	row: JsonRecord,
	keys: string[]
): { value: boolean | null; valid: boolean } => {
	const field = pickLiveField(row, keys);
	if (!field.present || field.value === null) return { value: null, valid: true };
	const value = asBoolean(field.value);
	return { value, valid: value !== null };
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

	const eventId = asNumber(pickLiveField(row, ["eventId", "event_id"]).value);
	const elementId = asNumber(pickLiveField(row, ["elementId", "element_id"]).value);
	if (
		eventId === null ||
		elementId === null ||
		!Number.isInteger(eventId) ||
		!Number.isInteger(elementId) ||
		eventId <= 0 ||
		elementId <= 0
	) {
		return null;
	}

	const numericFields = {
		minutes: parseOptionalNumber(row, ["minutes"]),
		goalsScored: parseOptionalNumber(row, ["goalsScored", "goals_scored"]),
		assists: parseOptionalNumber(row, ["assists"]),
		cleanSheets: parseOptionalNumber(row, ["cleanSheets", "clean_sheets"]),
		goalsConceded: parseOptionalNumber(row, ["goalsConceded", "goals_conceded"]),
		ownGoals: parseOptionalNumber(row, ["ownGoals", "own_goals"]),
		penaltiesSaved: parseOptionalNumber(row, ["penaltiesSaved", "penalties_saved"]),
		penaltiesMissed: parseOptionalNumber(row, ["penaltiesMissed", "penalties_missed"]),
		yellowCards: parseOptionalNumber(row, ["yellowCards", "yellow_cards"]),
		redCards: parseOptionalNumber(row, ["redCards", "red_cards"]),
		saves: parseOptionalNumber(row, ["saves"]),
		bonus: parseOptionalNumber(row, ["bonus"]),
		bps: parseOptionalNumber(row, ["bps"]),
		defensiveContribution: parseOptionalNumber(row, [
			"defensiveContribution",
			"defensive_contribution",
		]),
	};
	if (Object.values(numericFields).some((field) => !field.valid)) return null;
	const starts = parseOptionalBoolean(row, ["starts"]);
	const inDreamTeam = parseOptionalBoolean(row, ["inDreamTeam", "in_dream_team"]);
	if (!starts.valid || !inDreamTeam.valid) return null;
	const totalPointsField = pickLiveField(row, ["totalPoints", "total_points"]);
	const totalPoints = !totalPointsField.present ? 0 : asNumber(totalPointsField.value);
	if (
		totalPoints === null ||
		!Number.isInteger(totalPoints) ||
		totalPoints < GRAPHQL_INT_MIN ||
		totalPoints > GRAPHQL_INT_MAX
	) {
		return null;
	}

	return {
		eventId,
		playerId: elementId,
		minutes: numericFields.minutes.value,
		goalsScored: numericFields.goalsScored.value,
		assists: numericFields.assists.value,
		cleanSheets: numericFields.cleanSheets.value,
		goalsConceded: numericFields.goalsConceded.value,
		ownGoals: numericFields.ownGoals.value,
		penaltiesSaved: numericFields.penaltiesSaved.value,
		penaltiesMissed: numericFields.penaltiesMissed.value,
		yellowCards: numericFields.yellowCards.value,
		redCards: numericFields.redCards.value,
		saves: numericFields.saves.value,
		bonus: numericFields.bonus.value,
		bps: numericFields.bps.value,
		starts: starts.value,
		defensiveContribution: numericFields.defensiveContribution.value,
		expectedGoals: asString(row.expectedGoals ?? row.expected_goals) ?? null,
		expectedAssists: asString(row.expectedAssists ?? row.expected_assists) ?? null,
		expectedGoalInvolvements:
			asString(row.expectedGoalInvolvements ?? row.expected_goal_involvements) ?? null,
		expectedGoalsConceded:
			asString(row.expectedGoalsConceded ?? row.expected_goals_conceded) ?? null,
		inDreamTeam: inDreamTeam.value,
		totalPoints,
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
	{
		identifier: "defensive_contribution",
		value: ["defensive_contribution", "defensiveContribution"],
		points: ["defensive_contribution_points", "defensiveContributionPoints"],
	},
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
): Promise<{ rows: Map<number, DbLiveExplainStats>; failed: boolean }> {
	if (elementIds.length === 0) return { rows: new Map(), failed: false };
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
		return { rows: new Map(), failed: true };
	}
	const rows = new Map<number, DbLiveExplainStats>();
	for (const raw of (data ?? []) as unknown[]) {
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
		const row = raw as DbLiveExplainStats;
		const elementId = parseIntegerValue(pickRecordValue(row, "element_id", "elementId"));
		if (elementId !== null && elementIds.includes(elementId)) rows.set(elementId, row);
	}
	return { rows, failed: false };
}

type LiveExplainRedisSupplement = {
	breakdown: LiveExplainBreakdown[];
	contributions: LiveExplainStatContribution[];
};

const parseEventLiveExplainRedisSupplement = (
	raw: string | null,
	expected?: { eventId: number; elementId: number; requireIdentity?: boolean }
): LiveExplainRedisSupplement | null => {
	if (raw === null || raw.length === 0) return null;
	const parsed = parseJsonUnknown(raw);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
	const o = parsed as Record<string, unknown>;
	if (expected) {
		const rawEventId = pickRecordValue(o, "eventId", "event_id");
		const rawElementId = pickRecordValue(o, "elementId", "element_id");
		if (expected.requireIdentity) {
			if (rawEventId !== expected.eventId || rawElementId !== expected.elementId) return null;
		} else {
			const embeddedEventId = parseIntegerValue(rawEventId);
			const embeddedElementId = parseIntegerValue(rawElementId);
			if (embeddedEventId !== null && embeddedEventId !== expected.eventId) return null;
			if (embeddedElementId !== null && embeddedElementId !== expected.elementId) return null;
		}
	}
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

/**
 * Read the producer's additive V2 compact contributions first, with per-player
 * fallback to the frozen legacy hash (which can also contain historical
 * fixture breakdowns). This keeps rolling deployment compatible in either
 * producer/consumer order.
 */
async function loadBreakdownsFromEventLiveExplainRedis(
	context: GraphQLContext,
	eventId: number,
	elementIds: number[],
	seasonOverride?: string
): Promise<Map<number, LiveExplainRedisSupplement>> {
	if (elementIds.length === 0) return new Map();
	const season = seasonOverride ?? (await getCurrentSeason(context));
	const v2HashKey = redisKey.eventLiveExplainV2(season, eventId);
	let v2Values: Array<string | null>;
	try {
		v2Values = await context.redis.hmget(v2HashKey, ...elementIds.map(String));
	} catch (error) {
		context.logger.warn(
			{ err: error, hashKey: v2HashKey, eventId, elementIds },
			"Redis HMGET EventLiveExplainV2 failed"
		);
		v2Values = elementIds.map(() => null);
	}
	const supplements = new Map<number, LiveExplainRedisSupplement>();
	for (const [index, elementId] of elementIds.entries()) {
		const parsed = parseEventLiveExplainRedisSupplement(v2Values[index] ?? null, {
			eventId,
			elementId,
			requireIdentity: true,
		});
		if (parsed) supplements.set(elementId, parsed);
	}

	const legacyElementIds = elementIds.filter((elementId) => !supplements.has(elementId));
	if (legacyElementIds.length === 0) return supplements;
	const legacyHashKey = redisKey.eventLiveExplain(season, eventId);
	let legacyValues: Array<string | null>;
	try {
		legacyValues = await context.redis.hmget(legacyHashKey, ...legacyElementIds.map(String));
	} catch (error) {
		context.logger.warn(
			{ err: error, hashKey: legacyHashKey, eventId, elementIds: legacyElementIds },
			"Redis HMGET EventLiveExplain failed"
		);
		return supplements;
	}
	for (const [index, elementId] of legacyElementIds.entries()) {
		const parsed = parseEventLiveExplainRedisSupplement(legacyValues[index] ?? null, {
			eventId,
			elementId,
		});
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
		elementId: number,
		includeSelectedBy?: boolean
	): Promise<LiveExplain | null>;
	getEventLiveExplains(
		context: GraphQLContext,
		eventId: number,
		elementIds: number[],
		mode?: LiveExplainReadMode,
		includeSelectedBy?: boolean
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

const liveSelectedByPreloadKey = (eventId: number, elementId: number): string =>
	`${eventId}:${elementId}`;

const rememberSelectedByPercents = (
	context: GraphQLContext,
	eventId: number,
	selectedByById: Map<number, number | null>
): void => {
	if (selectedByById.size === 0) return;
	// Sibling roots may finish in either order. Merge into the latest map so one
	// batch cannot discard values preloaded by another live root.
	const preload = new Map(context.liveSelectedByPreload ?? []);
	for (const [elementId, selectedBy] of selectedByById) {
		preload.set(liveSelectedByPreloadKey(eventId, elementId), selectedBy);
	}
	context.liveSelectedByPreload = preload;
};

async function resolveSelectedByPercents(
	context: GraphQLContext,
	eventId: number,
	elementIds: number[],
	seasonOverride?: string
): Promise<Map<number, number | null>> {
	const uniqueIds = Array.from(
		new Set(elementIds.filter((elementId) => Number.isInteger(elementId) && elementId > 0))
	);
	const resolved = new Map<number, number | null>();
	for (const elementId of uniqueIds) {
		const key = liveSelectedByPreloadKey(eventId, elementId);
		if (context.liveSelectedByPreload?.has(key)) {
			resolved.set(elementId, context.liveSelectedByPreload.get(key) ?? null);
		}
	}
	let missingIds = uniqueIds.filter((elementId) => !resolved.has(elementId));
	if (missingIds.length === 0) return resolved;

	const season = seasonOverride ?? (await getCurrentSeason(context));
	const hashKey = redisKey.playerSelectedBy(season, eventId);
	let cachedValues: Array<string | null> = missingIds.map(() => null);
	try {
		cachedValues =
			typeof context.redis.hmget === "function"
				? await context.redis.hmget(hashKey, ...missingIds.map(String))
				: await Promise.all(
						missingIds.map((elementId) => context.redis.hget(hashKey, String(elementId)))
					);
	} catch (error) {
		context.logger.warn(
			{ err: error, hashKey, eventId, elementIds: missingIds },
			"PlayerStatsSelected batch cache read failed"
		);
	}

	for (const [index, elementId] of missingIds.entries()) {
		const cached = cachedValues[index] ?? null;
		if (cached === null) continue;
		try {
			const parsed: unknown = JSON.parse(cached);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				const row = parsed as Record<string, unknown>;
				if (Object.hasOwn(row, "selected_by_percent") || Object.hasOwn(row, "selectedByPercent")) {
					resolved.set(
						elementId,
						parseNumericValue(pickRecordValue(row, "selected_by_percent", "selectedByPercent"))
					);
				}
			}
		} catch (error) {
			context.logger.warn(
				{ err: error, hashKey, field: String(elementId) },
				"Invalid JSON in PlayerStatsSelected cache"
			);
		}
	}

	missingIds = missingIds.filter((elementId) => !resolved.has(elementId));
	if (missingIds.length > 0) {
		const { data, error } = await context.supabase
			.from("player_stats")
			.select("element_id, selected_by_percent")
			.eq("event_id", eventId)
			.in("element_id", missingIds);

		if (error) {
			context.logger.warn(
				{ err: error, eventId, elementIds: missingIds },
				"player_stats selected_by_percent batch query failed"
			);
		} else {
			const rowsById = new Map<number, SelectedByCacheRow>();
			for (const raw of (data ?? []) as unknown[]) {
				if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
				const row = raw as Record<string, unknown>;
				const elementId = parseIntegerValue(pickRecordValue(row, "element_id", "elementId"));
				if (elementId !== null && missingIds.includes(elementId)) {
					rowsById.set(elementId, {
						selected_by_percent: pickRecordValue(
							row,
							"selected_by_percent",
							"selectedByPercent"
						) as number | string | null | undefined,
					});
				}
			}

			const cachePairs: string[] = [];
			for (const elementId of missingIds) {
				const row = rowsById.get(elementId);
				const selectedBy = parseNumericValue(row?.selected_by_percent ?? null);
				resolved.set(elementId, selectedBy);
				if (selectedBy !== null) {
					cachePairs.push(
						String(elementId),
						JSON.stringify({ selected_by_percent: selectedBy } satisfies SelectedByCacheRow)
					);
				}
			}
			if (cachePairs.length > 0) {
				try {
					await context.redis.hset(hashKey, ...cachePairs);
					await context.redis.expire(hashKey, SELECTED_BY_REDIS_TTL_SEC);
				} catch (cacheError) {
					context.logger.warn(
						{ err: cacheError, hashKey, eventId, elementIds: missingIds },
						"PlayerStatsSelected batch cache write failed"
					);
				}
			}
		}
	}

	for (const elementId of uniqueIds) {
		if (!resolved.has(elementId)) resolved.set(elementId, null);
	}
	rememberSelectedByPercents(context, eventId, resolved);
	return resolved;
}

async function resolveSelectedByPercent(
	context: GraphQLContext,
	eventId: number,
	elementId: number
): Promise<number | null> {
	const selectedBy = await resolveSelectedByPercents(context, eventId, [elementId]);
	return selectedBy.get(elementId) ?? null;
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
const LIVE_EXPLAIN_CACHE_SHAPE = "shape2";
const LIVE_EXPLAIN_SINGLEFLIGHT_BATCH_SIZE = 100;

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
				`live:explain:${LIVE_EXPLAIN_CACHE_SHAPE}:${eventId}:${elementId}:${mode}:revision:${meta.revision}${databaseFallback ? ":fallback15" : ""}`
			)
		: gqlCacheKey(
				season,
				`live:explain:${LIVE_EXPLAIN_CACHE_SHAPE}:${eventId}:${elementId}:${mode}:fallback15`
			);

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

type LiveExplainBatchLoad = {
	values: Map<number, LiveExplain | null>;
	selectedByById: Map<number, number | null>;
};

type LiveExplainFlight = {
	pendingIds: Set<number>;
	result: LiveExplainBatchLoad;
	promise: Promise<LiveExplainBatchLoad>;
};

const liveExplainFlights = new WeakMap<object, Map<string, LiveExplainFlight>>();

const getLiveExplainFlightMap = (context: GraphQLContext): Map<string, LiveExplainFlight> => {
	const redisIdentity = context.redis as object;
	let flights = liveExplainFlights.get(redisIdentity);
	if (!flights) {
		flights = new Map();
		liveExplainFlights.set(redisIdentity, flights);
	}
	return flights;
};

const readLiveExplainCacheBatch = async (
	context: GraphQLContext,
	eventId: number,
	elementIds: number[],
	season: string,
	meta: LiveSnapshotMeta | null,
	databaseFallback: boolean,
	mode: LiveExplainReadMode
): Promise<Map<number, LiveExplain | null>> => {
	const cacheKeys = elementIds.map((elementId) =>
		shapedLiveExplainCacheKey(season, eventId, elementId, meta, databaseFallback, mode)
	);
	let cachedValues: Array<string | null> = elementIds.map(() => null);
	try {
		cachedValues =
			typeof context.redis.mget === "function"
				? await context.redis.mget(...cacheKeys)
				: await Promise.all(cacheKeys.map((cacheKey) => context.redis.get(cacheKey)));
	} catch (error) {
		context.logger.warn(
			{ err: error, eventId, elementIds },
			"Failed to read live explain batch cache"
		);
	}

	const resolved = new Map<number, LiveExplain | null>();
	const malformedKeys: string[] = [];
	for (const [index, elementId] of elementIds.entries()) {
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
	return resolved;
};

const loadColdLiveExplainBatch = async (
	context: GraphQLContext,
	eventId: number,
	elementIds: number[],
	season: string,
	meta: LiveSnapshotMeta | null,
	databaseFallback: boolean,
	mode: LiveExplainReadMode
): Promise<LiveExplainBatchLoad> => {
	// Another process may have filled Redis while this process elected its
	// singleflight. Recheck before touching PostgreSQL.
	const resolved = await readLiveExplainCacheBatch(
		context,
		eventId,
		elementIds,
		season,
		meta,
		databaseFallback,
		mode
	);
	const selectedByById = new Map<number, number | null>();
	const coldIds = elementIds.filter((elementId) => !resolved.has(elementId));
	if (coldIds.length === 0) return { values: resolved, selectedByById };

	const redisSupplementById = databaseFallback
		? new Map<number, LiveExplainRedisSupplement>()
		: await loadBreakdownsFromEventLiveExplainRedis(context, eventId, coldIds, season);
	const databaseIds =
		mode === "full" ? coldIds : coldIds.filter((elementId) => !redisSupplementById.has(elementId));
	const [playerStatsResult, eventExplainById] = await Promise.all([
		fetchPlayerStatsForLiveExplains(context, eventId, databaseIds),
		fetchEventLiveExplainsFromSupabase(context, eventId, databaseIds),
	]);
	const playerStatsById = playerStatsResult.rows;
	const playerStatsDatabaseIds = new Set(databaseIds);
	for (const [elementId, row] of playerStatsById) {
		selectedByById.set(
			elementId,
			parseNumericValue(pickRecordValue(row, "selected_by_percent", "selectedByPercent"))
		);
	}

	const cacheTtl =
		databaseFallback || !meta
			? LIVE_EXPLAIN_FALLBACK_CACHE_TTL_SEC
			: LIVE_EXPLAIN_REVISION_CACHE_TTL_SEC;
	const valuesToCache = new Map<string, string>();
	for (const elementId of coldIds) {
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
			if (!playerStatsResult.failed || !playerStatsDatabaseIds.has(elementId)) {
				valuesToCache.set(cacheKey, "__null__");
			}
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
		// A transient player_stats failure can still yield useful fixture-level
		// details. Return that partial response, but do not pin it to this revision;
		// the next refresh should retry PostgreSQL immediately.
		if (!playerStatsResult.failed || !playerStatsDatabaseIds.has(elementId)) {
			valuesToCache.set(cacheKey, JSON.stringify(result));
		}
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

	return { values: resolved, selectedByById };
};

const loadLiveExplainsWithSingleflight = (
	context: GraphQLContext,
	eventId: number,
	elementIds: number[],
	season: string,
	meta: LiveSnapshotMeta | null,
	databaseFallback: boolean,
	mode: LiveExplainReadMode
): Promise<LiveExplainBatchLoad> => {
	const flights = getLiveExplainFlightMap(context);
	const scopeKey = `${season}:${eventId}:${mode}:${meta?.revision ?? "fallback"}:${databaseFallback ? "database" : "redis"}`;
	const existing = flights.get(scopeKey);
	if (existing) {
		for (const elementId of elementIds) existing.pendingIds.add(elementId);
		return existing.promise;
	}

	const flight: LiveExplainFlight = {
		pendingIds: new Set(elementIds),
		result: { values: new Map(), selectedByById: new Map() },
		promise: Promise.resolve({ values: new Map(), selectedByById: new Map() }),
	};
	flight.promise = (async (): Promise<LiveExplainBatchLoad> => {
		try {
			// Yield once so simultaneous entry/tournament/browser refreshes can join
			// this revision-scoped batch before the two durable reads begin.
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
			while (flight.pendingIds.size > 0) {
				const batchIds = Array.from(flight.pendingIds).slice(
					0,
					LIVE_EXPLAIN_SINGLEFLIGHT_BATCH_SIZE
				);
				for (const elementId of batchIds) flight.pendingIds.delete(elementId);
				const loaded = await loadColdLiveExplainBatch(
					context,
					eventId,
					batchIds,
					season,
					meta,
					databaseFallback,
					mode
				);
				for (const [elementId, value] of loaded.values) {
					flight.result.values.set(elementId, value);
				}
				for (const [elementId, selectedBy] of loaded.selectedByById) {
					flight.result.selectedByById.set(elementId, selectedBy);
				}
			}
			return flight.result;
		} finally {
			if (flights.get(scopeKey) === flight) flights.delete(scopeKey);
		}
	})();
	flights.set(scopeKey, flight);
	return flight.promise;
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
		elementId: number,
		includeSelectedBy = false
	): Promise<LiveExplain | null> {
		return (
			(
				await this.getEventLiveExplains(context, eventId, [elementId], "full", includeSelectedBy)
			)[0] ?? null
		);
	},

	async getEventLiveExplains(
		context: GraphQLContext,
		eventId: number,
		elementIds: number[],
		mode: LiveExplainReadMode = "full",
		includeSelectedBy = false
	): Promise<LiveExplain[]> {
		if (!Number.isFinite(eventId) || eventId <= 0) return [];
		const uniqueIds = Array.from(
			new Set(elementIds.filter((id) => Number.isInteger(id) && id > 0))
		);
		if (uniqueIds.length === 0) return [];

		const season = await getCurrentSeason(context);
		const databaseFallback = isLiveSnapshotDatabaseFallback(context, eventId);
		// A consistency wrapper has already established the operation candidate
		// and memoized it on this context. Reuse that decision so a transient
		// second metadata GET cannot select an unversioned fallback cache while
		// the outer before/after boundary still accepts the original revision.
		const meta = await loadLiveSnapshotMeta(context, eventId, { season });
		const resolved = await readLiveExplainCacheBatch(
			context,
			eventId,
			uniqueIds,
			season,
			meta,
			databaseFallback,
			mode
		);

		const missingIds = uniqueIds.filter((elementId) => !resolved.has(elementId));
		if (missingIds.length > 0) {
			const loaded = await loadLiveExplainsWithSingleflight(
				context,
				eventId,
				missingIds,
				season,
				meta,
				databaseFallback,
				mode
			);
			for (const elementId of missingIds) {
				if (loaded.values.has(elementId)) {
					resolved.set(elementId, loaded.values.get(elementId) ?? null);
				}
			}
			rememberSelectedByPercents(context, eventId, loaded.selectedByById);
		}

		const results = uniqueIds
			.map((elementId) => resolved.get(elementId) ?? null)
			.filter((value): value is LiveExplain => value !== null);
		if (!includeSelectedBy || results.length === 0) return results;

		const selectedByById = await resolveSelectedByPercents(
			context,
			eventId,
			results.map((result) => result.elementId),
			season
		);
		return results.map((result) => ({
			...result,
			selectedBy: selectedByById.get(result.elementId) ?? null,
		}));
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
