import type { GraphQLContext } from "../../graphql/context";
import { gqlCacheKey } from "../../infra/cache-key";
import {
	getLiveDataSnapshot,
	getTargetedLiveDataSnapshot,
	liveDatasetRevision,
	type LivePerformanceData,
} from "../../infra/data-snapshot";
import { getCurrentEventId } from "../../infra/event";
import {
	isLiveSnapshotDatabaseFallback,
	loadLivePublicationMeta,
	loadLiveSnapshotMeta,
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

type DbLiveScoringItem = JsonRecord & {
	scoring_identifier?: string | null;
	scoring_value?: number | string | null;
	points?: number | string | null;
	minutes?: number | string | null;
	minutes_points?: number | string | null;
	goals_scored?: number | string | null;
	goals_scored_points?: number | string | null;
	assists?: number | string | null;
	assists_points?: number | string | null;
	clean_sheets?: number | string | null;
	clean_sheets_points?: number | string | null;
	goals_conceded?: number | string | null;
	goals_conceded_points?: number | string | null;
	own_goals?: number | string | null;
	own_goals_points?: number | string | null;
	penalties_saved?: number | string | null;
	penalties_saved_points?: number | string | null;
	penalties_missed?: number | string | null;
	penalties_missed_points?: number | string | null;
	yellow_cards?: number | string | null;
	yellow_cards_points?: number | string | null;
	red_cards?: number | string | null;
	red_cards_points?: number | string | null;
	saves?: number | string | null;
	saves_points?: number | string | null;
	bonus?: number | string | null;
	defensive_contribution?: number | string | null;
	defensive_contribution_points?: number | string | null;
};

type DbLiveFixtureStat = JsonRecord & {
	fixture_id?: number | string | null;
	element_type?: number | string | null;
	minutes?: number | string | null;
	goals?: number | string | null;
	assists?: number | string | null;
	own_goals?: number | string | null;
	yellow_cards?: number | string | null;
	red_cards?: number | string | null;
};

/** Per-element GW row: `explain` JSON = fixture-level breakdown; cumulative stats use event snapshots. */
type DbLiveExplainRow = {
	event_id: number;
	element_id: number;
	explain?: DbLiveExplainBreakdown[] | string | null;
	modified?: boolean | number | string | null;
	scoring_items?: DbLiveScoringItem[];
	fixture_stats?: DbLiveFixtureStat[];
} & Record<string, unknown>;

type SelectedByCacheRow = {
	selected_by_percent: number | string | null | undefined;
};

const redisKey = {
	playerSelectedBy: (context: GraphQLContext, eventId: number): string =>
		gqlCacheKey(context, `live:selected-by:${eventId}`),
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

const mapPublishedLivePerformance = (row: LivePerformanceData): LivePerformance => ({ ...row });

const deleteMalformedCache = async (context: GraphQLContext, key: string): Promise<void> => {
	try {
		await context.redis.del(key);
	} catch (error) {
		context.logger.warn({ err: error, key }, "Failed to evict malformed live cache");
	}
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
		inDreamTeam: parseBooleanValue(
			pickRecordValue(stats, "in_dream_team", "in_dreamteam", "inDreamTeam")
		),
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
	if (arr) return mapLiveExplainBreakdown(arr);
	const scoringItems = mapScoringItemContributions(row.scoring_items ?? []);
	const fixtureStats = row.fixture_stats ?? [];
	return (row.fixture_stats ?? [])
		.map((fixture) => {
			const fixtureId = parseIntegerValue(pickRecordValue(fixture, "fixture_id", "fixtureId"));
			if (fixtureId === null) return null;
			return {
				fixtureId,
				// The normalized scoring facts are GW-grain. When there is one
				// fixture, retain their exact point attribution; for DGWs use
				// fixture-grain facts with only the metrics that have a
				// deterministic FPL scoring rule at this grain.
				stats:
					fixtureStats.length === 1 && scoringItems.length > 0
						? scoringItems
						: mapFixtureStatContributions(fixture),
			};
		})
		.filter((breakdown): breakdown is LiveExplainBreakdown => breakdown !== null);
};

const mapFixtureStatContributions = (row: DbLiveFixtureStat): LiveExplainStatContribution[] => {
	const definitions = [
		{ identifier: "minutes", value: "minutes" },
		{ identifier: "goals_scored", value: "goals" },
		{ identifier: "assists", value: "assists" },
		{ identifier: "own_goals", value: "own_goals" },
		{ identifier: "yellow_cards", value: "yellow_cards" },
		{ identifier: "red_cards", value: "red_cards" },
	] as const;
	const yellowCards = parseNumericValue(pickRecordValue(row, "yellow_cards", "yellowCards"));
	const redCards = parseNumericValue(pickRecordValue(row, "red_cards", "redCards"));
	return definitions.flatMap(({ identifier, value }) => {
		const count = parseIntegerValue(pickRecordValue(row, value));
		if (count === null || count === 0) return [];
		if (
			identifier === "yellow_cards" &&
			yellowCards !== null &&
			redCards !== null &&
			redCards !== 0
		) {
			return [];
		}
		const elementType = parseIntegerValue(pickRecordValue(row, "element_type", "elementType"));
		const points =
			identifier === "minutes"
				? count >= 60
					? 2
					: 1
				: identifier === "goals_scored"
					? elementType === 1
						? count * 10
						: elementType === 2
							? count * 6
							: elementType === 3
								? count * 5
								: count * 4
					: identifier === "assists"
						? count * 3
						: identifier === "own_goals"
							? count * -2
							: identifier === "yellow_cards"
								? count * -1
								: count * -3;
		return [{ identifier, points, value: count, pointsModification: null }];
	});
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

/**
 * When producers store only raw counts (no `*_points` columns), fill scoring
 * points from FPL rules so web clients can render a non-empty breakdown.
 * Position-weighted events (goals, clean sheets) are estimated only when the
 * snapshot supplies element type; otherwise the contribution is omitted.
 */
const estimateFplPointsFromValue = (
	identifier: string,
	value: number,
	elementType: number | null = null,
	fixtureCount: number | null = null,
	minutes: number | null = null
): number | null => {
	if (!Number.isFinite(value) || value === 0) return 0;
	switch (identifier) {
		case "minutes":
			// Minutes points are awarded per fixture. Without exactly one fixture
			// boundary, even a short double-gameweek aggregate can be wrong.
			if (fixtureCount !== 1) return null;
			return value >= 60 ? 2 : value > 0 ? 1 : 0;
		case "goals_scored":
			return elementType === 1
				? value * 10
				: elementType === 2
					? value * 6
					: elementType === 3
						? value * 5
						: elementType === 4
							? value * 4
							: null;
		case "clean_sheets":
			if (fixtureCount !== 1 || minutes === null || minutes < 60) return null;
			return elementType === 1 || elementType === 2 ? value * 4 : elementType === 3 ? value : null;
		case "goals_conceded":
			return fixtureCount === 1 && (elementType === 1 || elementType === 2)
				? -Math.floor(value / 2)
				: null;
		case "assists":
			return value * 3;
		case "saves":
			// Save points are awarded per fixture. An event aggregate cannot be
			// scored safely without exactly one fixture boundary.
			return fixtureCount === 1 ? Math.floor(value / 3) : null;
		case "defensive_contribution":
			// The event projection exposes the count but not the thresholded points.
			return null;
		case "yellow_cards":
			return value * -1;
		case "red_cards":
			return value * -3;
		case "own_goals":
			return value * -2;
		case "penalties_missed":
			return value * -2;
		case "penalties_saved":
			return value * 5;
		default:
			return null;
	}
};

const mapFlatLiveExplainContributions = (
	row: Record<string, unknown> | null,
	elementType: number | null = null,
	fixtureCount: number | null = null
): LiveExplainStatContribution[] => {
	if (!row) return [];
	const contributions: LiveExplainStatContribution[] = [];
	const minutes = parseNumericValue(pickRecordValue(row, "minutes"));
	for (const definition of FLAT_LIVE_EXPLAIN_STATS) {
		const value = parseNumericValue(pickRecordValue(row, ...definition.value));
		const rawPoints = parseIntegerValue(pickRecordValue(row, ...definition.points));
		if ((value ?? 0) === 0 && (rawPoints ?? 0) === 0) continue;
		let points = rawPoints ?? 0;
		if (rawPoints === null && value !== null && value !== 0) {
			const estimated = estimateFplPointsFromValue(
				definition.identifier,
				value,
				elementType,
				fixtureCount,
				minutes
			);
			if (estimated === null) continue;
			points = estimated;
		}
		contributions.push({
			identifier: definition.identifier,
			value,
			points,
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

const mapScoringItemContributions = (
	items: readonly DbLiveScoringItem[]
): LiveExplainStatContribution[] =>
	items.flatMap((item) => {
		const identifier = pickRecordValue(item, "scoring_identifier", "scoringIdentifier");
		if (typeof identifier === "string" && identifier.trim().length > 0) {
			return [
				{
					identifier,
					points: parseIntegerValue(pickRecordValue(item, "points")) ?? 0,
					value: parseNumericValue(pickRecordValue(item, "scoring_value", "scoringValue")),
					pointsModification: null,
				},
			];
		}
		const pivotedDefinitions = [
			["minutes", "minutes_points"],
			["goals_scored", "goals_scored_points"],
			["assists", "assists_points"],
			["clean_sheets", "clean_sheets_points"],
			["goals_conceded", "goals_conceded_points"],
			["own_goals", "own_goals_points"],
			["penalties_saved", "penalties_saved_points"],
			["penalties_missed", "penalties_missed_points"],
			["yellow_cards", "yellow_cards_points"],
			["red_cards", "red_cards_points"],
			["saves", "saves_points"],
			["bonus", "bonus"],
			["defensive_contribution", "defensive_contribution_points"],
		] as const;
		return pivotedDefinitions.flatMap(([pivotedIdentifier, pointsKey]) => {
			const value = parseNumericValue(pickRecordValue(item, pivotedIdentifier));
			const points = parseIntegerValue(pickRecordValue(item, pointsKey));
			if ((value ?? 0) === 0 && (points ?? 0) === 0) return [];
			return [
				{ identifier: pivotedIdentifier, points: points ?? 0, value, pointsModification: null },
			];
		});
	});

const mergeNonDuplicateContributions = (
	primary: readonly LiveExplainStatContribution[],
	secondary: readonly LiveExplainStatContribution[]
): LiveExplainStatContribution[] => {
	const identifiers = new Set(primary.map((contribution) => contribution.identifier));
	return [
		...primary,
		...secondary.filter((contribution) => {
			if (identifiers.has(contribution.identifier)) return false;
			identifiers.add(contribution.identifier);
			return true;
		}),
	];
};

async function fetchPlayerStatsForLiveExplains(
	context: GraphQLContext,
	eventId: number,
	elementIds: number[]
): Promise<{
	rows: Map<number, DbLiveExplainStats>;
	eventRows: Map<number, DbLiveExplainStats>;
	uncacheableElementIds: Set<number>;
}> {
	if (elementIds.length === 0) {
		return { rows: new Map(), eventRows: new Map(), uncacheableElementIds: new Set() };
	}
	const [snapshotResult, gameweekStatsResult] = await Promise.all([
		context.data
			.read("fpl.player_event_snapshots")
			.select("*")
			.eq("event_id", eventId)
			.in("element_id", elementIds),
		context.data
			.read("fpl.player_gameweek_stats")
			.select("*")
			.eq("event_id", eventId)
			.in("element_id", elementIds),
	]);

	const snapshotQueryFailed = snapshotResult.error !== null;
	const gameweekQueryFailed = gameweekStatsResult.error !== null;
	if (snapshotQueryFailed || gameweekQueryFailed) {
		context.logger.warn(
			{
				err: snapshotResult.error ?? gameweekStatsResult.error,
				eventId,
				elementIds,
				snapshotQueryFailed,
				gameweekQueryFailed,
			},
			"player live stats batch query failed for live explanations"
		);
	}
	const rows = new Map<number, DbLiveExplainStats>();
	const eventRows = new Map<number, DbLiveExplainStats>();
	const uncacheableElementIds = new Set<number>();
	if (snapshotQueryFailed || gameweekQueryFailed) {
		for (const elementId of elementIds) uncacheableElementIds.add(elementId);
	}
	for (const raw of (snapshotQueryFailed ? [] : (snapshotResult.data ?? [])) as unknown[]) {
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
		const row = raw as DbLiveExplainStats;
		const elementId = parseIntegerValue(pickRecordValue(row, "element_id", "elementId"));
		if (elementId !== null && elementIds.includes(elementId)) rows.set(elementId, row);
	}
	// The snapshot projection intentionally excludes some canonical gameweek
	// fields because those columns are not present in every accepted
	// snapshot archive. The gameweek stats projection is the nullable source for
	// these fields.
	for (const raw of (gameweekQueryFailed ? [] : (gameweekStatsResult.data ?? [])) as unknown[]) {
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
		const gameweekRow = raw as DbLiveExplainStats;
		const elementId = parseIntegerValue(pickRecordValue(gameweekRow, "element_id", "elementId"));
		if (elementId === null || !elementIds.includes(elementId)) continue;
		eventRows.set(elementId, gameweekRow);
		const current = rows.get(elementId);
		if (!current) continue;
		for (const [target, keys] of [
			["penalties_missed", ["penalties_missed", "penaltiesMissed"]],
			["defensive_contribution", ["defensive_contribution", "defensiveContribution"]],
			["in_dream_team", ["in_dream_team", "inDreamTeam"]],
		] as const) {
			current[target] = pickRecordValue(gameweekRow, ...keys);
		}
		rows.set(elementId, current);
	}
	for (const elementId of elementIds) {
		if (!rows.has(elementId)) uncacheableElementIds.add(elementId);
	}
	return {
		rows,
		eventRows,
		uncacheableElementIds,
	};
}

async function fetchEventLiveExplainsFromDatabase(
	context: GraphQLContext,
	eventId: number,
	elementIds: number[]
): Promise<Map<number, DbLiveExplainRow>> {
	if (elementIds.length === 0) return new Map();
	const [scoringItemsResult, fixtureStatsResult] = await Promise.all([
		context.data
			.read("fpl.player_gameweek_scoring_items")
			.select("*")
			.eq("event_id", eventId)
			.in("element_id", elementIds),
		context.data
			.read("fpl.player_fixture_stats")
			.select("*")
			.eq("event_id", eventId)
			.in("element_id", elementIds),
	]);
	if (scoringItemsResult.error || fixtureStatsResult.error) {
		const error = scoringItemsResult.error ?? fixtureStatsResult.error;
		context.logger.error(
			{ err: error, eventId, elementIds },
			"player gameweek explain facts batch query failed"
		);
		throw new Error("Failed to fetch event live explain", { cause: error });
	}
	const rows = new Map<number, DbLiveExplainRow>();
	for (const raw of (scoringItemsResult.data ?? []) as unknown[]) {
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
		const record = raw as JsonRecord;
		const elementId = parseIntegerValue(pickRecordValue(record, "element_id"));
		if (elementId === null || !elementIds.includes(elementId)) continue;
		const row = rows.get(elementId) ?? { event_id: eventId, element_id: elementId };
		row.scoring_items = [...(row.scoring_items ?? []), record as DbLiveScoringItem];
		rows.set(elementId, row);
	}
	for (const raw of (fixtureStatsResult.data ?? []) as unknown[]) {
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
		const record = raw as JsonRecord;
		const elementId = parseIntegerValue(pickRecordValue(record, "element_id"));
		if (elementId === null || !elementIds.includes(elementId)) continue;
		const row = rows.get(elementId) ?? { event_id: eventId, element_id: elementId };
		row.fixture_stats = [...(row.fixture_stats ?? []), record as DbLiveFixtureStat];
		rows.set(elementId, row);
	}
	return rows;
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

export type TargetedLiveRead = {
	performances: LivePerformance[];
	effectiveBonusByPlayer: Map<number, number>;
	meta: LiveSnapshotMeta;
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
	getTargetedLiveRead(
		context: GraphQLContext,
		eventId: number,
		playerIds: number[]
	): Promise<TargetedLiveRead>;
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

const SELECTED_BY_CACHE_TTL_SEC = 3600;

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
	elementIds: number[]
): Promise<Map<number, number | null>> {
	const uniqueIds = Array.from(
		new Set(elementIds.filter((elementId) => Number.isSafeInteger(elementId) && elementId > 0))
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

	const hashKey = redisKey.playerSelectedBy(context, eventId);
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
			"Live selected-by query cache read failed"
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
				"Invalid JSON in live selected-by query cache"
			);
		}
	}

	missingIds = missingIds.filter((elementId) => !resolved.has(elementId));
	if (missingIds.length > 0) {
		const { data, error } = await context.data
			.read("fpl.player_event_snapshots")
			.select("element_id, selected_by_percent")
			.eq("event_id", eventId)
			.in("element_id", missingIds);

		if (error) {
			context.logger.warn(
				{ err: error, eventId, elementIds: missingIds },
				"player event snapshot ownership batch query failed"
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
					await context.redis.expire(hashKey, SELECTED_BY_CACHE_TTL_SEC);
				} catch (cacheError) {
					context.logger.warn(
						{ err: cacheError, hashKey, eventId, elementIds: missingIds },
						"Live selected-by query cache write failed"
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

	const { data, error } = await context.data
		.read("fpl.player_gameweek_stats")
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
const LIVE_EXPLAIN_CACHE_TTL_SEC = 10;
const LIVE_EXPLAIN_SINGLEFLIGHT_BATCH_SIZE = 100;

const shapedLiveExplainCacheKey = (
	context: GraphQLContext,
	eventId: number,
	elementId: number,
	meta: LiveSnapshotMeta | null,
	mode: LiveExplainReadMode
): string => {
	const revision = meta
		? liveDatasetRevision(context.dataRevision!, eventId, meta.revision)
		: context.dataRevision;
	return gqlCacheKey(context, `live:explain:${eventId}:${elementId}:${mode}`, revision);
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
	meta: LiveSnapshotMeta | null,
	mode: LiveExplainReadMode
): Promise<Map<number, LiveExplain | null>> => {
	const cacheKeys = elementIds.map((elementId) =>
		shapedLiveExplainCacheKey(context, eventId, elementId, meta, mode)
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
	meta: LiveSnapshotMeta | null,
	mode: LiveExplainReadMode
): Promise<LiveExplainBatchLoad> => {
	// Another process may have filled Redis while this process elected its
	// singleflight. Recheck before touching PostgreSQL.
	const resolved = await readLiveExplainCacheBatch(context, eventId, elementIds, meta, mode);
	const selectedByById = new Map<number, number | null>();
	const coldIds = elementIds.filter((elementId) => !resolved.has(elementId));
	if (coldIds.length === 0) return { values: resolved, selectedByById };

	const databaseIds = coldIds;
	const [playerStatsResult, eventExplainById] = await Promise.all([
		fetchPlayerStatsForLiveExplains(context, eventId, databaseIds),
		fetchEventLiveExplainsFromDatabase(context, eventId, databaseIds),
	]);
	const playerStatsById = playerStatsResult.rows;
	const eventStatsById = playerStatsResult.eventRows;
	for (const [elementId, row] of playerStatsById) {
		selectedByById.set(
			elementId,
			parseNumericValue(pickRecordValue(row, "selected_by_percent", "selectedByPercent"))
		);
	}

	const valuesToCache = new Map<string, string>();
	for (const elementId of coldIds) {
		const psRow = playerStatsById.get(elementId) ?? null;
		const elRow = eventExplainById.get(elementId) ?? null;
		const eventStats = eventStatsById.get(elementId) ?? null;
		const cacheKey = shapedLiveExplainCacheKey(context, eventId, elementId, meta, mode);
		if (!psRow && !elRow && !eventStats) {
			resolved.set(elementId, null);
			if (!playerStatsResult.uncacheableElementIds.has(elementId)) {
				valuesToCache.set(cacheKey, "__null__");
			}
			continue;
		}

		const stats = mapLiveExplainStats(psRow);
		const databaseBreakdown = elRow ? mapBreakdownFromEventLiveRow(elRow) : [];
		const breakdown = databaseBreakdown;
		const fixtureStats = elRow?.fixture_stats ?? [];
		const fixtureCount = elRow?.fixture_stats?.length ?? null;
		const fixtureContributions = breakdown.flatMap((entry) => entry.stats);
		const scoringItemContributions = mapScoringItemContributions(elRow?.scoring_items ?? []);
		let contributions =
			fixtureContributions.length > 0
				? fixtureContributions
				: scoringItemContributions.length > 0
					? scoringItemContributions
					: mapFlatLiveExplainContributions(elRow, null, fixtureCount);
		const elementType = parseIntegerValue(pickRecordValue(psRow, "element_type", "elementType"));
		const eventStatContributions = mapFlatLiveExplainContributions(
			eventStats,
			elementType,
			fixtureCount
		);
		const eventRedCards = parseNumericValue(pickRecordValue(eventStats, "red_cards", "redCards"));
		const eventHasRedCard = eventRedCards !== null && eventRedCards !== 0;
		const hasSameFixtureCard = fixtureStats.some((fixture) => {
			const yellowCards = parseNumericValue(
				pickRecordValue(fixture, "yellow_cards", "yellowCards")
			);
			const redCards = parseNumericValue(pickRecordValue(fixture, "red_cards", "redCards"));
			return yellowCards !== null && yellowCards !== 0 && redCards !== null && redCards !== 0;
		});
		const hasFixtureCardData = fixtureStats.some(
			(fixture) =>
				parseNumericValue(pickRecordValue(fixture, "yellow_cards", "yellowCards")) !== null ||
				parseNumericValue(pickRecordValue(fixture, "red_cards", "redCards")) !== null
		);
		const suppressAmbiguousYellowCard =
			eventHasRedCard &&
			(fixtureCount === 1 || hasSameFixtureCard || (fixtureCount !== 1 && !hasFixtureCardData));
		const safeEventStatContributions = suppressAmbiguousYellowCard
			? eventStatContributions.filter((contribution) => contribution.identifier !== "yellow_cards")
			: eventStatContributions;
		contributions = mergeNonDuplicateContributions(contributions, safeEventStatContributions);

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
		// A transient event-snapshot failure can still yield useful fixture-level
		// details. Return that partial response, but do not pin it to this revision;
		// the next refresh should retry PostgreSQL immediately.
		if (!playerStatsResult.uncacheableElementIds.has(elementId)) {
			valuesToCache.set(cacheKey, JSON.stringify(result));
		}
	}

	await Promise.all(
		Array.from(valuesToCache, async ([cacheKey, value]) => {
			try {
				await context.redis.set(cacheKey, value, "EX", LIVE_EXPLAIN_CACHE_TTL_SEC);
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
	meta: LiveSnapshotMeta | null,
	mode: LiveExplainReadMode
): Promise<LiveExplainBatchLoad> => {
	const flights = getLiveExplainFlightMap(context);
	const scopeKey = `${context.currentSeason.seasonCode}:${eventId}:${mode}:${meta?.revision ?? "postgres"}`;
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
				const loaded = await loadColdLiveExplainBatch(context, eventId, batchIds, meta, mode);
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

export const liveRepository: LiveRepository = {
	async getAllLivePerformances(
		context: GraphQLContext,
		eventId: number
	): Promise<Map<number, LivePerformance>> {
		if (!Number.isSafeInteger(eventId) || eventId <= 0) {
			return new Map();
		}
		const snapshot = await getLiveDataSnapshot(context, eventId);
		return new Map(
			snapshot.eventLives.map((row) => {
				const performance = mapPublishedLivePerformance(row);
				return [performance.playerId, performance];
			})
		);
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

		if (!Number.isSafeInteger(targetEventId) || targetEventId <= 0) {
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
		if (!Number.isSafeInteger(eventId) || eventId <= 0) return [];
		const uniqueIds = Array.from(
			new Set(elementIds.filter((id) => Number.isSafeInteger(id) && id > 0))
		);
		if (uniqueIds.length === 0) return [];

		const meta = await loadLiveSnapshotMeta(context, eventId);
		const resolved = await readLiveExplainCacheBatch(context, eventId, uniqueIds, meta, mode);

		const missingIds = uniqueIds.filter((elementId) => !resolved.has(elementId));
		if (missingIds.length > 0) {
			const loaded = await loadLiveExplainsWithSingleflight(
				context,
				eventId,
				missingIds,
				meta,
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
			results.map((result) => result.elementId)
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
		if (!Number.isSafeInteger(eventId) || eventId <= 0) {
			throw new Error("eventId is required to fetch live performances");
		}

		const uniqueIds = Array.from(
			new Set(playerIds.filter((id) => Number.isSafeInteger(id) && id > 0))
		);
		if (uniqueIds.length === 0) {
			return [];
		}
		return (await this.getTargetedLiveRead(context, eventId, uniqueIds)).performances;
	},

	async getTargetedLiveRead(
		context: GraphQLContext,
		eventId: number,
		playerIds: number[]
	): Promise<TargetedLiveRead> {
		const publishedMeta = await loadLivePublicationMeta(context, eventId);
		const snapshot =
			publishedMeta?.publicationId && !isLiveSnapshotDatabaseFallback(context, eventId)
				? await getTargetedLiveDataSnapshot(context, eventId, playerIds, {
						publicationId: publishedMeta.publicationId,
						revision: publishedMeta.revision,
						sourceCheckedAt: publishedMeta.checkedAt,
						publishedAt: publishedMeta.publishedAt,
						state: publishedMeta.state,
						eventLiveCount: publishedMeta.eventLiveCount,
						fixtureCount: publishedMeta.fixtureCount,
						fixtureTeamCount: publishedMeta.fixtureTeamCount,
						bonusTeamCount: publishedMeta.bonusTeamCount,
					})
				: await getTargetedLiveDataSnapshot(context, eventId, playerIds, {
						publicationId: "unavailable",
						revision: "unavailable",
						sourceCheckedAt: publishedMeta?.checkedAt ?? "",
						publishedAt: publishedMeta?.publishedAt ?? "",
						state: publishedMeta?.state ?? "scheduled",
						eventLiveCount: publishedMeta?.eventLiveCount ?? 0,
						fixtureCount: publishedMeta?.fixtureCount ?? 0,
						fixtureTeamCount: publishedMeta?.fixtureTeamCount ?? 0,
						bonusTeamCount: publishedMeta?.bonusTeamCount ?? 0,
					});
		const requested = new Set(playerIds);
		const effectiveBonusByPlayer = new Map<number, number>();
		for (const teamBonus of Object.values(snapshot.liveBonus)) {
			for (const [playerIdRaw, bonus] of Object.entries(teamBonus)) {
				const playerId = Number(playerIdRaw);
				if (requested.has(playerId)) effectiveBonusByPlayer.set(playerId, bonus);
			}
		}
		const meta: LiveSnapshotMeta = {
			season: snapshot.seasonCode,
			eventId,
			revision: snapshot.revision,
			publicationId: snapshot.publicationId,
			state: snapshot.state,
			publishedAt: snapshot.publishedAt,
			checkedAt: snapshot.sourceCheckedAt,
			eventLiveCount: snapshot.eventLiveCount,
			fixtureCount: snapshot.fixtureCount,
			fixtureTeamCount: snapshot.fixtureTeamCount,
			bonusTeamCount: snapshot.bonusTeamCount,
		};
		rememberLiveSnapshotMeta(context, meta, snapshot.seasonCode, eventId, snapshot.source);
		return {
			performances: snapshot.eventLives.map(mapPublishedLivePerformance),
			effectiveBonusByPlayer,
			meta,
		};
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
			!Number.isSafeInteger(eventId) ||
			eventId <= 0 ||
			!Number.isSafeInteger(elementId) ||
			elementId <= 0
		) {
			return null;
		}
		return resolveSelectedByPercent(context, eventId, elementId);
	},
};
