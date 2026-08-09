import type { GraphQLContext } from "../../graphql/context";
import { gqlCacheKey } from "../../infra/cache-key";
import { getCurrentEventFromRedis } from "../../infra/event";
import { getCurrentSeason } from "../../infra/season";

export type PlayerStatsScope = "CURRENT_SEASON" | "PREVIOUS_SEASON" | "UNAVAILABLE";

export type PlayerStatsContext = {
	scope: PlayerStatsScope;
	season: string;
	asOfEventId: number | null;
};

export type PlayerSeasonStatsAtEvent = {
	elementId: number;
	eventId: number;
	available: boolean;
	totalPoints: number | null;
	selectedByPercent: number | null;
	form: number | null;
	seasonTransfersIn: number | null;
	seasonTransfersOut: number | null;
	transfersInEvent: number | null;
	transfersOutEvent: number | null;
	minutes: number | null;
	starts: number | null;
	goalsScored: number | null;
	assists: number | null;
	cleanSheets: number | null;
	goalsConceded: number | null;
	ownGoals: number | null;
	penaltiesSaved: number | null;
	yellowCards: number | null;
	redCards: number | null;
	saves: number | null;
	bonus: number | null;
	bps: number | null;
	expectedGoals: number | null;
	expectedAssists: number | null;
	expectedGoalInvolvements: number | null;
	expectedGoalsConceded: number | null;
	influence: number | null;
	creativity: number | null;
	threat: number | null;
	ictIndex: number | null;
};

type EventPhaseRow = {
	id: number;
	finished: boolean | null;
	is_current: boolean | null;
	deadline_time_epoch: number | null;
};

const SEASON_STATS_CACHE_VERSION = "v4";
const SEASON_STATS_CACHE_TTL = 60 * 60;
const SEASON_STATS_LIVE_CACHE_TTL = 5 * 60;
const EMPTY_SEASON_STATS_CACHE_TTL = 5 * 60;
const EVENT_PHASE_LOOKBACK = 40;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const asNullableNumber = (value: unknown): number | null => {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : null;
	}
	return null;
};

const asNullableInt = (value: unknown): number | null => {
	const parsed = asNullableNumber(value);
	return parsed === null ? null : Math.trunc(parsed);
};

const unavailableContext = (season: string): PlayerStatsContext => ({
	scope: "UNAVAILABLE",
	season,
	asOfEventId: null,
});

const isStartedEvent = (event: EventPhaseRow, nowEpoch: number): boolean =>
	Boolean(event.finished) ||
	Boolean(event.is_current) ||
	(typeof event.deadline_time_epoch === "number" && event.deadline_time_epoch <= nowEpoch);

/**
 * Resolve the latest event whose current-season statistics are safe to label.
 * A future GW1 is deliberately not accepted: FPL can expose reference totals
 * before the new season starts, but those are not current-season production.
 */
export async function resolvePlayerStatsContext(
	context: GraphQLContext,
	requestedEventId?: number | null
): Promise<PlayerStatsContext> {
	const season = await getCurrentSeason(context);
	const upperBound =
		typeof requestedEventId === "number" &&
		Number.isFinite(requestedEventId) &&
		requestedEventId > 0
			? Math.trunc(requestedEventId)
			: null;

	const current = await getCurrentEventFromRedis(context);
	if (current?.isCurrent && (upperBound === null || current.id <= upperBound)) {
		return { scope: "CURRENT_SEASON", season, asOfEventId: current.id };
	}

	try {
		let query = context.data
			.read("fpl.events")
			.select("id, finished, is_current, deadline_time_epoch");
		if (upperBound !== null) query = query.lte("id", upperBound);
		const { data, error } = await query
			.order("id", { ascending: false })
			.limit(EVENT_PHASE_LOOKBACK);
		if (error) {
			context.logger.warn(
				{ err: error, requestedEventId: upperBound },
				"Failed to resolve player-stats season phase"
			);
			return unavailableContext(season);
		}

		const nowEpoch = Math.floor(Date.now() / 1000);
		const row = ((data ?? []) as EventPhaseRow[]).find((event) => isStartedEvent(event, nowEpoch));
		return row
			? { scope: "CURRENT_SEASON", season, asOfEventId: row.id }
			: unavailableContext(season);
	} catch (error) {
		context.logger.warn(
			{ err: error, requestedEventId: upperBound },
			"Failed to resolve player-stats season phase"
		);
		return unavailableContext(season);
	}
}

const emptySeasonStats = (elementId: number, eventId: number): PlayerSeasonStatsAtEvent => ({
	elementId,
	eventId,
	available: false,
	totalPoints: null,
	selectedByPercent: null,
	form: null,
	seasonTransfersIn: null,
	seasonTransfersOut: null,
	transfersInEvent: null,
	transfersOutEvent: null,
	minutes: null,
	starts: null,
	goalsScored: null,
	assists: null,
	cleanSheets: null,
	goalsConceded: null,
	ownGoals: null,
	penaltiesSaved: null,
	yellowCards: null,
	redCards: null,
	saves: null,
	bonus: null,
	bps: null,
	expectedGoals: null,
	expectedAssists: null,
	expectedGoalInvolvements: null,
	expectedGoalsConceded: null,
	influence: null,
	creativity: null,
	threat: null,
	ictIndex: null,
});

const mapDbRow = (
	eventId: number,
	row: Record<string, unknown>
): PlayerSeasonStatsAtEvent | null => {
	const elementId = asNullableInt(row.element_id ?? row.elementId);
	if (elementId === null || elementId <= 0) return null;
	return {
		elementId,
		eventId,
		available: true,
		totalPoints: asNullableInt(row.total_points ?? row.totalPoints),
		selectedByPercent: asNullableNumber(row.selected_by_percent ?? row.selectedByPercent),
		form: asNullableNumber(row.form),
		seasonTransfersIn: asNullableInt(row.transfers_in ?? row.transfersIn),
		seasonTransfersOut: asNullableInt(row.transfers_out ?? row.transfersOut),
		transfersInEvent: asNullableInt(row.transfers_in_event ?? row.transfersInEvent),
		transfersOutEvent: asNullableInt(row.transfers_out_event ?? row.transfersOutEvent),
		minutes: asNullableInt(row.minutes),
		starts: asNullableInt(row.starts),
		goalsScored: asNullableInt(row.goals_scored ?? row.goalsScored),
		assists: asNullableInt(row.assists),
		cleanSheets: asNullableInt(row.clean_sheets ?? row.cleanSheets),
		goalsConceded: asNullableInt(row.goals_conceded ?? row.goalsConceded),
		ownGoals: asNullableInt(row.own_goals ?? row.ownGoals),
		penaltiesSaved: asNullableInt(row.penalties_saved ?? row.penaltiesSaved),
		yellowCards: asNullableInt(row.yellow_cards ?? row.yellowCards),
		redCards: asNullableInt(row.red_cards ?? row.redCards),
		saves: asNullableInt(row.saves),
		bonus: asNullableInt(row.bonus),
		bps: asNullableInt(row.bps),
		expectedGoals: asNullableNumber(row.expected_goals ?? row.expectedGoals),
		expectedAssists: asNullableNumber(row.expected_assists ?? row.expectedAssists),
		expectedGoalInvolvements: asNullableNumber(
			row.expected_goal_involvements ?? row.expectedGoalInvolvements
		),
		expectedGoalsConceded: asNullableNumber(
			row.expected_goals_conceded ?? row.expectedGoalsConceded
		),
		influence: asNullableNumber(row.influence),
		creativity: asNullableNumber(row.creativity),
		threat: asNullableNumber(row.threat),
		ictIndex: asNullableNumber(row.ict_index ?? row.ictIndex),
	};
};

const isPlayerSeasonStatsAtEvent = (value: unknown): value is PlayerSeasonStatsAtEvent =>
	isRecord(value) &&
	typeof value.elementId === "number" &&
	typeof value.eventId === "number" &&
	typeof value.available === "boolean" &&
	(value.totalPoints === null || typeof value.totalPoints === "number") &&
	(value.form === null || typeof value.form === "number");

const cacheKey = (season: string, elementId: number, eventId: number): string =>
	gqlCacheKey(season, `players:season-stats:${SEASON_STATS_CACHE_VERSION}:${elementId}:${eventId}`);

async function isUnfinishedCurrentEvent(
	context: GraphQLContext,
	eventId: number
): Promise<boolean> {
	const current = await getCurrentEventFromRedis(context);
	if (current) return current.id === eventId && !current.finished;
	try {
		const { data, error } = await context.data
			.read("fpl.events")
			.select("finished")
			.eq("id", eventId)
			.limit(1);
		if (error) return true;
		const row = data?.[0] as { finished?: boolean | null } | undefined;
		return row?.finished !== true;
	} catch (error) {
		context.logger.warn({ err: error, eventId }, "Failed to resolve season-stat cache freshness");
		return true;
	}
}

const SEASON_STATS_SELECT = [
	"element_id",
	"event_id",
	"total_points",
	"selected_by_percent",
	"form",
	"transfers_in",
	"transfers_out",
	"transfers_in_event",
	"transfers_out_event",
	"minutes",
	"starts",
	"goals_scored",
	"assists",
	"clean_sheets",
	"goals_conceded",
	"own_goals",
	"penalties_saved",
	"yellow_cards",
	"red_cards",
	"saves",
	"bonus",
	"bps",
	"expected_goals",
	"expected_assists",
	"expected_goal_involvements",
	"expected_goals_conceded",
	"influence",
	"creativity",
	"threat",
	"ict_index",
].join(", ");

export async function getPlayerSeasonStatsByIdsForContext(
	context: GraphQLContext,
	elementIds: number[],
	statsContext: PlayerStatsContext
): Promise<Map<number, PlayerSeasonStatsAtEvent>> {
	const uniqueIds = Array.from(new Set(elementIds.filter((id) => Number.isInteger(id) && id > 0)));
	const result = new Map<number, PlayerSeasonStatsAtEvent>();
	const eventId = statsContext.asOfEventId;
	if (uniqueIds.length === 0 || statsContext.scope !== "CURRENT_SEASON" || eventId === null) {
		return result;
	}

	const keys = uniqueIds.map((id) => cacheKey(statsContext.season, id, eventId));
	let cachedRows: Array<string | null> = uniqueIds.map(() => null);
	try {
		cachedRows = await context.redis.mget(...keys);
	} catch (error) {
		context.logger.warn({ err: error, keys }, "Failed to read player season-stat cache");
	}

	const missingIds: number[] = [];
	for (const [index, id] of uniqueIds.entries()) {
		const raw = cachedRows[index];
		if (raw) {
			try {
				const parsed: unknown = JSON.parse(raw);
				if (isPlayerSeasonStatsAtEvent(parsed) && parsed.eventId === eventId) {
					result.set(id, parsed);
					continue;
				}
			} catch (error) {
				context.logger.warn({ err: error, key: keys[index] }, "Malformed season-stat cache");
			}
			try {
				await context.redis.del(keys[index]);
			} catch {
				// A cache repair failure must not block the PostgreSQL source of truth.
			}
		}
		missingIds.push(id);
	}

	if (missingIds.length === 0) return result;
	const cacheTtl = (await isUnfinishedCurrentEvent(context, eventId))
		? SEASON_STATS_LIVE_CACHE_TTL
		: SEASON_STATS_CACHE_TTL;

	const { data, error } = await context.data
		.read("fpl.player_event_snapshots")
		.select(SEASON_STATS_SELECT)
		.eq("event_id", eventId)
		.in("element_id", missingIds);

	if (error) {
		context.logger.warn(
			{ err: error, eventId, playerIds: missingIds },
			"Failed to fetch season-as-of-event player stats"
		);
		return result;
	}

	const pipeline = context.redis.pipeline();
	const found = new Set<number>();
	for (const raw of (data ?? []) as unknown[]) {
		if (!isRecord(raw)) continue;
		const mapped = mapDbRow(eventId, raw);
		if (!mapped) continue;
		found.add(mapped.elementId);
		result.set(mapped.elementId, mapped);
		pipeline.set(
			cacheKey(statsContext.season, mapped.elementId, eventId),
			JSON.stringify(mapped),
			"EX",
			cacheTtl
		);
	}
	for (const id of missingIds) {
		if (found.has(id)) continue;
		const empty = emptySeasonStats(id, eventId);
		result.set(id, empty);
		pipeline.set(
			cacheKey(statsContext.season, id, eventId),
			JSON.stringify(empty),
			"EX",
			EMPTY_SEASON_STATS_CACHE_TTL
		);
	}
	try {
		await pipeline.exec();
	} catch (error) {
		context.logger.warn({ err: error, eventId }, "Failed to cache player season stats");
	}

	return result;
}

export async function getPlayerSeasonStatsForContext(
	context: GraphQLContext,
	elementId: number,
	statsContext: PlayerStatsContext
): Promise<PlayerSeasonStatsAtEvent | null> {
	if (!Number.isInteger(elementId) || elementId <= 0) return null;
	const stats = await getPlayerSeasonStatsByIdsForContext(context, [elementId], statsContext);
	return stats.get(elementId) ?? null;
}
