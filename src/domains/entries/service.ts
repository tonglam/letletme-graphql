import type { GraphQLContext } from "../../graphql/context";
import { gqlCacheKey } from "../../infra/cache-key";
import { buildPlayerMap } from "../../infra/player-map";
import { getCurrentSeason } from "../../infra/season";
import { buildTeamMap } from "../../infra/team-map";
import type { Player, Team } from "../../infra/types";
import type { ElementEventResultData } from "../entry-live/calc-service";
import type { EntryEventTransferRow } from "../entry-live/repository";
import { entryLiveRepository } from "../entry-live/repository";
import {
	type EntryEventTransfersData,
	enrichTransferRows,
} from "../entry-live/transfer-enrichment";
import type { LivePerformance } from "../live/repository";
import { mapSyncJobLiveRow } from "../live/repository";
import type { Entry, EntryEventResult, EntryHistoryInfo } from "./repository";
import { entriesRepository } from "./repository";

export type EntryGameweekTransfers = {
	eventId: number;
	eventTransfers: number;
	eventTransfersCost: number;
	transfers: EntryEventTransfersData[];
};

const isEntryGameweekTransfersArray = (value: unknown): value is EntryGameweekTransfers[] =>
	Array.isArray(value) &&
	value.every(
		(item) =>
			isRecord(item) &&
			typeof item.eventId === "number" &&
			typeof item.eventTransfers === "number" &&
			typeof item.eventTransfersCost === "number" &&
			Array.isArray(item.transfers) &&
			item.transfers.every(
				(transfer) =>
					isRecord(transfer) &&
					typeof transfer.elementInCost === "number" &&
					Number.isFinite(transfer.elementInCost) &&
					typeof transfer.elementOutCost === "number" &&
					Number.isFinite(transfer.elementOutCost)
			)
	);

const readEnrichedTransferCache = async (
	context: GraphQLContext,
	key: string
): Promise<EntryGameweekTransfers[] | null> => {
	let cached: string | null;
	try {
		cached = await context.redis.get(key);
	} catch (error) {
		context.logger.warn({ err: error, key }, "Failed to read enriched transfer cache");
		return null;
	}
	if (cached === null) return null;
	try {
		const parsed: unknown = JSON.parse(cached);
		if (isEntryGameweekTransfersArray(parsed)) return parsed;
	} catch (error) {
		context.logger.warn({ err: error, key }, "Malformed enriched transfer cache");
	}
	try {
		await context.redis.del(key);
	} catch (error) {
		context.logger.warn({ err: error, key }, "Failed to evict enriched transfer cache");
	}
	return null;
};

const readRawTransferCache = async (
	context: GraphQLContext,
	key: string
): Promise<string | null> => {
	try {
		return await context.redis.get(key);
	} catch (error) {
		context.logger.warn({ err: error, key }, "Failed to read transfer history cache");
		return null;
	}
};

const uniquePositiveIds = (ids: number[]): number[] =>
	Array.from(new Set(ids.filter((id) => Number.isInteger(id) && id > 0)));

const livePerformanceKey = (eventId: number, playerId: number): string => `${eventId}:${playerId}`;

type StoredEntryPick = {
	element: number;
	position: number;
	multiplier: number;
	isCaptain: boolean;
	isViceCaptain: boolean;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const asNumber = (value: unknown): number | null =>
	typeof value === "number" && Number.isFinite(value) ? value : null;

const asBoolean = (value: unknown): boolean | null => (typeof value === "boolean" ? value : null);

const asScaled = (value: number | null | undefined, divisor: number): number =>
	typeof value === "number" ? value / divisor : 0;

const parseNullableFloat = (value: string | null | undefined): number | null => {
	if (!value) {
		return null;
	}
	const parsed = Number.parseFloat(value);
	return Number.isFinite(parsed) ? parsed : null;
};

const elementTypeName = (position: number): string => {
	switch (position) {
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

const mapStoredEntryPick = (raw: unknown): StoredEntryPick | null => {
	if (!isRecord(raw)) {
		return null;
	}

	const element = asNumber(raw.element);
	const position = asNumber(raw.position);
	if (!element || !position) {
		return null;
	}

	return {
		element,
		position,
		multiplier: asNumber(raw.multiplier) ?? 0,
		isCaptain: asBoolean(raw.isCaptain) ?? asBoolean(raw.is_captain) ?? false,
		isViceCaptain: asBoolean(raw.isViceCaptain) ?? asBoolean(raw.is_vice_captain) ?? false,
	};
};

const mapEntryPick = (params: {
	eventId: number;
	pick: StoredEntryPick;
	player: Player | undefined;
	team: Team | undefined;
	live: LivePerformance | undefined;
}): ElementEventResultData => {
	const { eventId, pick, player, team, live } = params;
	const minutes = live?.minutes ?? 0;
	const yellowCards = live?.yellowCards ?? 0;
	const redCards = live?.redCards ?? 0;

	return {
		season: null,
		event: eventId,
		element: pick.element,
		code: player?.code ?? 0,
		webName: player?.webName ?? "",
		price: asScaled(player?.price, 10),
		elementType: player?.position ?? 0,
		elementTypeName: elementTypeName(player?.position ?? 0),
		teamId: player?.teamId ?? 0,
		teamCode: team?.code ?? 0,
		teamName: team?.name ?? "",
		teamShortName: team?.shortName ?? "",
		againstId: 0,
		againstName: "",
		againstShortName: "BLANK",
		wasHome: "",
		score: "",
		position: pick.position,
		multiplier: pick.multiplier,
		isCaptain: pick.isCaptain,
		isViceCaptain: pick.isViceCaptain,
		isGwStarted: true,
		isGwFinished: true,
		isPlayed: minutes > 0 || yellowCards > 0 || redCards > 0,
		playStatus: 4,
		minutes,
		goalsScored: live?.goalsScored ?? 0,
		assists: live?.assists ?? 0,
		cleanSheets: live?.cleanSheets ?? 0,
		goalsConceded: live?.goalsConceded ?? 0,
		defensiveContribution: live?.defensiveContribution ?? 0,
		ownGoals: live?.ownGoals ?? 0,
		penaltiesSaved: live?.penaltiesSaved ?? 0,
		penaltiesMissed: live?.penaltiesMissed ?? 0,
		yellowCards,
		redCards,
		saves: live?.saves ?? 0,
		bonus: live?.bonus ?? 0,
		bps: live?.bps ?? 0,
		totalPoints: live?.totalPoints ?? 0,
		starts: live?.starts ?? null,
		expectedGoals: parseNullableFloat(live?.expectedGoals),
		expectedAssists: parseNullableFloat(live?.expectedAssists),
		expectedGoalInvolvements: parseNullableFloat(live?.expectedGoalInvolvements),
		expectedGoalsConceded: parseNullableFloat(live?.expectedGoalsConceded),
		inDreamTeam: live?.inDreamTeam ?? null,
		pickActive: pick.multiplier > 0,
		autoSub: pick.position > 11 && pick.multiplier > 0,
		bgw: false,
		dgw: false,
	};
};

const EVENT_LIVES_COLS = [
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

async function buildLiveMapForEvents(
	context: GraphQLContext,
	eventIds: number[],
	playerIds: number[],
	playerIdsByEvent?: Map<number, number[]>
): Promise<Map<string, LivePerformance>> {
	const result = new Map<string, LivePerformance>();
	if (eventIds.length === 0 || playerIds.length === 0) return result;

	const season = await getCurrentSeason(context);
	const uniquePlayerIds = uniquePositiveIds(playerIds);

	// Pipeline all HMGET commands — one RTT for all events.
	// When playerIdsByEvent is provided, each event only requests its own players
	// (e.g. 4 fields per event instead of 38), greatly reducing response payload.
	const pipeline = context.redis.pipeline();
	for (const eventId of eventIds) {
		const fields = playerIdsByEvent
			? uniquePositiveIds(playerIdsByEvent.get(eventId) ?? uniquePlayerIds).map(String)
			: uniquePlayerIds.map(String);
		pipeline.hmget(`EventLive:${season}:${eventId}`, ...fields);
	}

	let pipelineResults: Array<[Error | null, (string | null)[] | null]> | null = null;
	try {
		pipelineResults = (await pipeline.exec()) as Array<[Error | null, (string | null)[] | null]>;
	} catch (err) {
		context.logger.warn({ err }, "EventLive pipeline failed, falling back to DB for all events");
	}

	const dbFallbackPlayerIdsByEvent = new Map<number, number[]>();
	const addDbFallback = (eventId: number, requestedIds: number[]): void => {
		if (requestedIds.length > 0) dbFallbackPlayerIdsByEvent.set(eventId, requestedIds);
	};

	if (pipelineResults) {
		for (let i = 0; i < eventIds.length; i++) {
			const [err, values] = pipelineResults[i];
			const requestedIds = playerIdsByEvent
				? uniquePositiveIds(playerIdsByEvent.get(eventIds[i]) ?? uniquePlayerIds)
				: uniquePlayerIds;
			if (err || !values || values.length !== requestedIds.length) {
				addDbFallback(eventIds[i], requestedIds);
				continue;
			}
			let hasUnresolvedField = false;
			for (const [valueIndex, value] of values.entries()) {
				if (!value) {
					hasUnresolvedField = true;
					continue;
				}
				try {
					const parsed = JSON.parse(value) as Record<string, unknown>;
					const perf = mapSyncJobLiveRow(parsed);
					if (perf) {
						result.set(livePerformanceKey(perf.eventId, perf.playerId), perf);
					} else {
						hasUnresolvedField = true;
					}
				} catch {
					hasUnresolvedField = true;
				}
				if (valueIndex >= requestedIds.length) hasUnresolvedField = true;
			}
			if (hasUnresolvedField) addDbFallback(eventIds[i], requestedIds);
		}
	} else {
		for (const eventId of eventIds) {
			const requestedIds = playerIdsByEvent
				? uniquePositiveIds(playerIdsByEvent.get(eventId) ?? uniquePlayerIds)
				: uniquePlayerIds;
			addDbFallback(eventId, requestedIds);
		}
	}

	for (const [eventId, requestedIds] of dbFallbackPlayerIdsByEvent) {
		const { data, error } = await context.supabase
			.from("event_lives")
			.select(EVENT_LIVES_COLS)
			.eq("event_id", eventId)
			.in("element_id", requestedIds);
		if (error) {
			context.logger.error(
				{ err: error, eventId, entryPlayerIds: requestedIds },
				"Failed to fetch live transfer performance fallback"
			);
			throw new Error("Failed to fetch live transfer performance fallback", { cause: error });
		}
		if (data) {
			for (const row of data as unknown as Record<string, unknown>[]) {
				const perf = mapSyncJobLiveRow(row);
				if (perf) result.set(livePerformanceKey(perf.eventId, perf.playerId), perf);
			}
		}
	}

	return result;
}

export const entriesService = {
	getEntryById(context: GraphQLContext, id: number): Promise<Entry | null> {
		return entriesRepository.getEntryById(context, id);
	},

	getEntriesByIds(context: GraphQLContext, ids: number[]): Promise<Map<number, Entry>> {
		return entriesRepository.getEntriesByIds(context, ids);
	},

	getEntriesByIdsFromRedis(context: GraphQLContext, ids: number[]): Promise<Map<number, Entry>> {
		return entriesRepository.getEntriesByIdsFromRedis(context, ids);
	},

	getEntryHistory(context: GraphQLContext, entryId: number): Promise<EntryEventResult[]> {
		return entriesRepository.getEntryHistory(context, entryId);
	},

	getEntryHistoryInfo(context: GraphQLContext, entryId: number): Promise<EntryHistoryInfo[]> {
		return entriesRepository.getEntryHistoryInfo(context, entryId);
	},

	getEntryEventResult(
		context: GraphQLContext,
		entryId: number,
		eventId: number
	): Promise<EntryEventResult | null> {
		return entriesRepository.getEntryEventResult(context, entryId, eventId);
	},

	getEntryEventResultsByEntryIds(
		context: GraphQLContext,
		entryIds: number[],
		eventId: number
	): Promise<Map<number, EntryEventResult>> {
		return entriesRepository.getEntryEventResultsByEntryIds(context, entryIds, eventId);
	},

	async getEntryEventPicks(
		context: GraphQLContext,
		result: EntryEventResult
	): Promise<ElementEventResultData[]> {
		const picks = result.eventPicks
			.map(mapStoredEntryPick)
			.filter((pick): pick is StoredEntryPick => pick !== null)
			.sort((a, b) => a.position - b.position);
		if (picks.length === 0) {
			return [];
		}

		const playerIds = uniquePositiveIds(picks.map((pick) => pick.element));
		const [playerMap, teamMap, liveByPlayer] = await Promise.all([
			buildPlayerMap(context, playerIds),
			buildTeamMap(context),
			buildLiveMapForEvents(context, [result.eventId], playerIds),
		]);

		return picks.map((pick) => {
			const player = playerMap.get(pick.element);
			const team = player ? teamMap.get(player.teamId) : undefined;
			const live = liveByPlayer.get(livePerformanceKey(result.eventId, pick.element));
			return mapEntryPick({
				eventId: result.eventId,
				pick,
				player,
				team,
				live,
			});
		});
	},

	async getEntryTransferHistory(
		context: GraphQLContext,
		entryId: number,
		live = false
	): Promise<EntryGameweekTransfers[]> {
		if (!Number.isFinite(entryId) || entryId <= 0) {
			return [];
		}

		const season = await getCurrentSeason(context);
		const enrichedCacheKey = gqlCacheKey(
			season,
			`entries:transfer-history:enriched:v3:${entryId}${live ? ":live" : ""}`
		);
		const innerCacheKey = gqlCacheKey(season, `entries:transfers:v3:history:${entryId}`);

		// Check both cache keys simultaneously + pre-warm season + start team fetch in parallel
		const teamMapPromise = buildTeamMap(context);
		const [cachedEnriched, cachedInner] = await Promise.all([
			readEnrichedTransferCache(context, enrichedCacheKey),
			readRawTransferCache(context, innerCacheKey),
		]);

		if (cachedEnriched !== null) return cachedEnriched;

		const transferRows = await entryLiveRepository.getEntryTransferHistory(
			context,
			entryId,
			cachedInner
		);
		if (transferRows.length === 0) {
			return [];
		}

		const playerIds = uniquePositiveIds(
			transferRows.flatMap((row) => [row.elementIn, row.elementOut])
		);
		const eventIds = Array.from(new Set(transferRows.map((row) => row.eventId))).sort(
			(a, b) => a - b
		);

		// Build per-event player map so the live pipeline only requests relevant players per event
		const playerIdsByEvent = new Map<number, number[]>();
		for (const row of transferRows) {
			const ids = playerIdsByEvent.get(row.eventId) ?? [];
			if (!ids.includes(row.elementIn)) ids.push(row.elementIn);
			if (!ids.includes(row.elementOut)) ids.push(row.elementOut);
			playerIdsByEvent.set(row.eventId, ids);
		}

		const livePromise = live
			? buildLiveMapForEvents(context, eventIds, playerIds, playerIdsByEvent)
			: Promise.resolve(new Map<string, LivePerformance>());

		const [playerMap, teamMap, liveByEventAndPlayer] = await Promise.all([
			buildPlayerMap(context, playerIds),
			teamMapPromise,
			livePromise,
		]);

		const rowsByEvent = new Map<number, EntryEventTransferRow[]>();
		for (const row of transferRows) {
			const current = rowsByEvent.get(row.eventId);
			if (current) {
				current.push(row);
			} else {
				rowsByEvent.set(row.eventId, [row]);
			}
		}

		const enriched = eventIds.map((eventId): EntryGameweekTransfers => {
			const eventRows = rowsByEvent.get(eventId) ?? [];
			const liveByPlayer = new Map<number, LivePerformance>();
			for (const row of eventRows) {
				const inLive = liveByEventAndPlayer.get(livePerformanceKey(eventId, row.elementIn));
				if (inLive) {
					liveByPlayer.set(row.elementIn, inLive);
				}
				const outLive = liveByEventAndPlayer.get(livePerformanceKey(eventId, row.elementOut));
				if (outLive) {
					liveByPlayer.set(row.elementOut, outLive);
				}
			}

			const transfers = enrichTransferRows({
				entryId,
				eventId,
				transferRows: eventRows,
				playersById: playerMap,
				teamsById: teamMap,
				liveByPlayer,
			});

			return {
				eventId,
				eventTransfers: eventRows.length,
				eventTransfersCost: eventRows.length > 1 ? (eventRows.length - 1) * 4 : 0,
				transfers,
			};
		});

		try {
			await context.redis.set(enrichedCacheKey, JSON.stringify(enriched), "EX", 3600);
		} catch (cacheError) {
			context.logger.warn(
				{ err: cacheError, entryId },
				"Failed to cache enriched entry transfer history"
			);
		}
		return enriched;
	},
};
