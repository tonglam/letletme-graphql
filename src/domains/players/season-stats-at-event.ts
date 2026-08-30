import type { GraphQLContext } from "../../graphql/context";
import { isPlainRecord as isRecord } from "../../contracts/guards";
import { gqlCacheKey } from "../../infra/cache-key";
import { getCoreEventSnapshot } from "../../infra/data-snapshot";
import { QUERY_CACHE_TTL_SECONDS } from "../../infra/query-cache";
import { getCurrentSeason } from "../../infra/season";

export type PlayerStatsScope = "CURRENT_SEASON" | "PREVIOUS_SEASON" | "UNAVAILABLE";
export type PlayerStatsSnapshotStatus =
	"AVAILABLE" | "PRESEASON" | "STALE" | "INCOMPLETE" | "UNAVAILABLE";

export type PlayerStatsContext = {
	scope: PlayerStatsScope;
	season: string;
	asOfEventId: number | null;
	status: PlayerStatsSnapshotStatus;
	revision: string | null;
	sourceCheckedAt: string | null;
	publishedAt: string | null;
	rowCount: number;
	expectedRowCount: number;
};

const PLAYER_STATS_DEFAULT_FRESHNESS_MS = 60_000;
const PLAYER_STATS_LIVE_FRESHNESS_MS = 90_000;
const PLAYER_SEASON_STATS_CACHE_VERSION = "v2";

export type PlayerStatsFreshnessCadence = "ACTIVE_EVENT" | "STATIC";

/**
 * Player statistics have their own observer cadence. They must not read the
 * live lifecycle table: that table is not on the live-points read path and a
 * lifecycle heartbeat outage must not turn a player-stats query into a second
 * live-data dependency.
 */
export function resolvePlayerStatsFreshnessBudgetMs(
	cadence: PlayerStatsFreshnessCadence | null
): number {
	if (cadence === "ACTIVE_EVENT") {
		return PLAYER_STATS_LIVE_FRESHNESS_MS;
	}
	return PLAYER_STATS_DEFAULT_FRESHNESS_MS;
}

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

const unavailableContext = (
	season: string,
	status: PlayerStatsSnapshotStatus = "UNAVAILABLE"
): PlayerStatsContext => ({
	scope: "UNAVAILABLE",
	season,
	asOfEventId: null,
	status,
	revision: null,
	sourceCheckedAt: null,
	publishedAt: null,
	rowCount: 0,
	expectedRowCount: 0,
});

type PublicationRow = {
	event_id: number;
	revision: string | number;
	source_checked_at: string | Date;
	published_at: string | Date;
	row_count: number;
	expected_row_count: number;
	baseline_verified_at: string | Date | null;
};

type PlayerEventSnapshotBundleRow = {
	event_id: number;
	element_id: number;
	publication_revision: string | number;
	publication_source_checked_at: string | Date;
	publication_published_at: string | Date;
	publication_row_count: number;
	publication_expected_row_count: number;
	publication_content_sha256: string;
	publication_baseline_verified_at: string | Date | null;
};

const isoTimestamp = (value: string | Date | null | undefined): string | null => {
	if (value === null || value === undefined) return null;
	const parsed = value instanceof Date ? value : new Date(value);
	return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
};

const positiveCount = (value: unknown): number | null => {
	const parsed = typeof value === "number" ? value : Number(value);
	return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
};

const publicationContext = (
	season: string,
	eventId: number,
	publication: PublicationRow,
	status: PlayerStatsSnapshotStatus
): PlayerStatsContext => ({
	scope: "CURRENT_SEASON",
	season,
	asOfEventId: eventId,
	status,
	revision: String(publication.revision),
	sourceCheckedAt: isoTimestamp(publication.source_checked_at),
	publishedAt: isoTimestamp(publication.published_at),
	rowCount: positiveCount(publication.row_count) ?? 0,
	expectedRowCount: positiveCount(publication.expected_row_count) ?? 0,
});

const statsContextMemo = new WeakMap<object, Map<number, Promise<PlayerStatsContext>>>();

const statsContextKey = (requestedEventId: number | null | undefined): number =>
	typeof requestedEventId === "number" && Number.isSafeInteger(requestedEventId)
		? requestedEventId
		: 0;

async function resolvePlayerStatsContextUncached(
	context: GraphQLContext,
	requestedEventId?: number | null
): Promise<PlayerStatsContext> {
	const [season, eventSnapshot] = await Promise.all([
		getCurrentSeason(context),
		getCoreEventSnapshot(context),
	]);
	const upperBound =
		typeof requestedEventId === "number" &&
		Number.isSafeInteger(requestedEventId) &&
		requestedEventId > 0
			? requestedEventId
			: null;
	const event =
		eventSnapshot.currentEventId !== null &&
		(upperBound === null || eventSnapshot.currentEventId <= upperBound)
			? (eventSnapshot.events.find((candidate) => candidate.id === eventSnapshot.currentEventId) ??
				null)
			: ([...eventSnapshot.events]
					.filter((candidate) => upperBound === null || candidate.id <= upperBound)
					.filter((candidate) => candidate.finished || candidate.isCurrent)
					.sort((left, right) => right.id - left.id)[0] ?? null);
	if (!event) {
		return unavailableContext(
			season,
			context.currentSeason.lifecycleState === "preseason" ? "PRESEASON" : "UNAVAILABLE"
		);
	}

	let publication: PublicationRow | null;
	let bundleRows: PlayerEventSnapshotBundleRow[];
	try {
		const result = await context.data
			.read("fpl.player_event_snapshot_bundles")
			.select(
				"event_id, element_id, publication_revision, publication_source_checked_at, publication_published_at, publication_row_count, publication_expected_row_count, publication_content_sha256, publication_baseline_verified_at"
			)
			.eq("event_id", event.id)
			.limit(1000);
		if (result.error) throw result.error;
		bundleRows = (result.data ?? []) as PlayerEventSnapshotBundleRow[];
		const first = bundleRows[0];
		publication = first
			? {
					event_id: first.event_id,
					revision: first.publication_revision,
					source_checked_at: first.publication_source_checked_at,
					published_at: first.publication_published_at,
					row_count: first.publication_row_count,
					expected_row_count: first.publication_expected_row_count,
					baseline_verified_at: first.publication_baseline_verified_at,
				}
			: null;
	} catch (error) {
		context.logger.warn({ err: error, eventId: event.id }, "Player Stats publication unavailable");
		return {
			scope: "CURRENT_SEASON",
			season,
			asOfEventId: event.id,
			status: context.currentSeason.lifecycleState === "preseason" ? "PRESEASON" : "UNAVAILABLE",
			revision: null,
			sourceCheckedAt: null,
			publishedAt: null,
			rowCount: 0,
			expectedRowCount: 0,
		};
	}
	if (!publication) {
		return {
			scope: "CURRENT_SEASON",
			season,
			asOfEventId: event.id,
			status: context.currentSeason.lifecycleState === "preseason" ? "PRESEASON" : "UNAVAILABLE",
			revision: null,
			sourceCheckedAt: null,
			publishedAt: null,
			rowCount: 0,
			expectedRowCount: 0,
		};
	}

	const header = publicationContext(season, event.id, publication, "AVAILABLE");
	if (!header.sourceCheckedAt || !header.publishedAt || !publication.baseline_verified_at) {
		return publicationContext(season, event.id, publication, "UNAVAILABLE");
	}
	if (
		header.rowCount <= 0 ||
		header.expectedRowCount <= 0 ||
		header.rowCount !== header.expectedRowCount
	) {
		return publicationContext(season, event.id, publication, "INCOMPLETE");
	}

	try {
		const ids = bundleRows
			.map((row) => Number(row.element_id))
			.filter((id) => Number.isSafeInteger(id) && id > 0);
		const uniqueIds = new Set(ids);
		if (ids.length !== header.expectedRowCount || uniqueIds.size !== header.expectedRowCount) {
			return publicationContext(season, event.id, publication, "INCOMPLETE");
		}
	} catch (error) {
		context.logger.warn({ err: error, eventId: event.id }, "Player Stats rows unavailable");
		return publicationContext(season, event.id, publication, "INCOMPLETE");
	}

	if (context.currentSeason.lifecycleState === "preseason") {
		return publicationContext(season, event.id, publication, "PRESEASON");
	}
	const nowMs = Date.now();
	const cadence: PlayerStatsFreshnessCadence = event.finished ? "STATIC" : "ACTIVE_EVENT";
	const freshnessBudgetMs = resolvePlayerStatsFreshnessBudgetMs(cadence);
	const sourceAge = nowMs - Date.parse(header.sourceCheckedAt);
	if (!event.finished && (!Number.isFinite(sourceAge) || sourceAge > freshnessBudgetMs)) {
		return publicationContext(season, event.id, publication, "STALE");
	}
	return header;
}

/**
 * Resolve the latest event whose current-season statistics are safe to label
 * from the same request-pinned core snapshot. GraphQL deliberately does not
 * re-derive event state from its local clock.
 */
export async function resolvePlayerStatsContext(
	context: GraphQLContext,
	requestedEventId?: number | null
): Promise<PlayerStatsContext> {
	const scope = context.requestScope ?? context;
	let memo = statsContextMemo.get(scope);
	if (!memo) {
		memo = new Map();
		statsContextMemo.set(scope, memo);
	}
	const key = statsContextKey(requestedEventId);
	const cached = memo.get(key);
	if (cached) return cached;
	const loading = resolvePlayerStatsContextUncached(context, requestedEventId);
	memo.set(key, loading);
	return loading;
}

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
	value.available === true &&
	(value.totalPoints === null || typeof value.totalPoints === "number") &&
	(value.form === null || typeof value.form === "number");

const cacheKey = (
	context: GraphQLContext,
	elementId: number,
	eventId: number,
	revision: string
): string =>
	gqlCacheKey(
		context,
		`players:season-stats:${PLAYER_SEASON_STATS_CACHE_VERSION}:${elementId}:${eventId}:${revision}`
	);

async function isUnfinishedCurrentEvent(
	context: GraphQLContext,
	eventId: number
): Promise<boolean> {
	const snapshot = await getCoreEventSnapshot(context);
	const event = snapshot.events.find((candidate) => candidate.id === eventId);
	return event?.finished !== true;
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

export type PlayerSeasonStatsLoad = Readonly<{
	stats: Map<number, PlayerSeasonStatsAtEvent>;
	sourceAvailable: boolean;
}>;

export async function getPlayerSeasonStatsLoadForContext(
	context: GraphQLContext,
	elementIds: number[],
	statsContext: PlayerStatsContext
): Promise<PlayerSeasonStatsLoad> {
	const uniqueIds = Array.from(
		new Set(elementIds.filter((id) => Number.isSafeInteger(id) && id > 0))
	);
	const result = new Map<number, PlayerSeasonStatsAtEvent>();
	const eventId = statsContext.asOfEventId;
	if (
		uniqueIds.length === 0 ||
		statsContext.scope !== "CURRENT_SEASON" ||
		statsContext.status !== "AVAILABLE" ||
		eventId === null ||
		statsContext.revision === null
	) {
		return { stats: result, sourceAvailable: true };
	}

	const keys = uniqueIds.map((id) => cacheKey(context, id, eventId, statsContext.revision!));
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

	if (missingIds.length === 0) return { stats: result, sourceAvailable: true };
	const cacheTtl = (await isUnfinishedCurrentEvent(context, eventId))
		? QUERY_CACHE_TTL_SECONDS.REPORTING
		: QUERY_CACHE_TTL_SECONDS.HISTORICAL;

	let data: unknown[] | null;
	try {
		const statsResult = await context.data
			.read("fpl.player_event_snapshot_bundles")
			.select(SEASON_STATS_SELECT)
			.eq("event_id", eventId)
			.eq("publication_revision", statsContext.revision)
			.in("element_id", missingIds);
		if (statsResult.error) {
			context.logger.warn(
				{ err: statsResult.error, eventId, playerIds: missingIds },
				"Failed to fetch season-as-of-event player stats"
			);
			return { stats: result, sourceAvailable: false };
		}
		data = (statsResult.data ?? null) as unknown[] | null;
	} catch (error) {
		context.logger.warn(
			{ err: error, eventId, playerIds: missingIds },
			"Failed to fetch season-as-of-event player stats"
		);
		return { stats: result, sourceAvailable: false };
	}

	const found = new Set<number>();
	for (const raw of (data ?? []) as unknown[]) {
		if (!isRecord(raw)) continue;
		const mapped = mapDbRow(eventId, raw);
		if (!mapped) continue;
		found.add(mapped.elementId);
		result.set(mapped.elementId, mapped);
	}
	const unresolvedIds = missingIds.filter((id) => !found.has(id));
	if (unresolvedIds.length > 0) {
		context.logger.warn(
			{
				eventId,
				revision: statsContext.revision,
				missingPlayerCount: unresolvedIds.length,
				playerIds: unresolvedIds.slice(0, 25),
				requestId: context.requestId,
			},
			"Pinned player season-stat revision is missing expected rows"
		);
		return { stats: result, sourceAvailable: false };
	}

	const pipeline = context.redis.pipeline();
	for (const mapped of result.values()) {
		if (!found.has(mapped.elementId)) continue;
		pipeline.set(
			cacheKey(context, mapped.elementId, eventId, statsContext.revision!),
			JSON.stringify(mapped),
			"EX",
			cacheTtl
		);
	}
	try {
		await pipeline.exec();
	} catch (error) {
		context.logger.warn({ err: error, eventId }, "Failed to cache player season stats");
	}

	return { stats: result, sourceAvailable: true };
}

export async function getPlayerSeasonStatsByIdsForContext(
	context: GraphQLContext,
	elementIds: number[],
	statsContext: PlayerStatsContext
): Promise<Map<number, PlayerSeasonStatsAtEvent>> {
	return (await getPlayerSeasonStatsLoadForContext(context, elementIds, statsContext)).stats;
}

export async function getPlayerSeasonStatsForContext(
	context: GraphQLContext,
	elementId: number,
	statsContext: PlayerStatsContext
): Promise<PlayerSeasonStatsAtEvent | null> {
	if (!Number.isSafeInteger(elementId) || elementId <= 0) return null;
	const stats = await getPlayerSeasonStatsByIdsForContext(context, [elementId], statsContext);
	return stats.get(elementId) ?? null;
}
