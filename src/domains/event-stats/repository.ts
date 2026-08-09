import type { GraphQLContext } from "../../graphql/context";
import { gqlCacheKey } from "../../infra/cache-key";
import { env } from "../../infra/env";
import { getCurrentSeason } from "../../infra/season";
import { buildPlayerMap } from "../../infra/player-map";
import { buildTeamMap } from "../../infra/team-map";

const privateCacheKey = async (context: GraphQLContext, key: string): Promise<string> =>
	gqlCacheKey(await getCurrentSeason(context), key);

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const evictMalformedCache = async (context: GraphQLContext, key: string): Promise<void> => {
	try {
		await context.redis.del(key);
	} catch (error) {
		context.logger.warn({ err: error, key }, "Failed to evict malformed event-stats cache");
	}
};

const readCachedJson = async (
	context: GraphQLContext,
	key: string
): Promise<unknown | undefined> => {
	let raw: string | null;
	try {
		raw = await context.redis.get(key);
	} catch (error) {
		context.logger.warn({ err: error, key }, "Failed to read event-stats cache");
		return undefined;
	}
	if (raw === null) return undefined;
	try {
		return JSON.parse(raw) as unknown;
	} catch (error) {
		context.logger.warn({ err: error, key }, "Malformed event-stats cache");
		await evictMalformedCache(context, key);
		return undefined;
	}
};

export type SelectionStatPlayer = {
	id: number;
	webName: string;
	teamShortName: string;
	position: string;
	selectedByPercent: number;
	eoByPercent: number | null;
};

export type CaptainStatPlayer = {
	id: number;
	webName: string;
	teamShortName: string;
	position: string;
	captainByPercent: number;
	selectedByPercent: number;
	eoByPercent: number | null;
};

export type TransferStatPlayer = {
	id: number;
	webName: string;
	teamShortName: string;
	position: string;
	transfersEvent: number;
	selectedByPercent: number;
};

export type TournamentSelectionStats = {
	totalEntries: number;
	goalkeepers: SelectionStatPlayer[];
	defenders: SelectionStatPlayer[];
	midfielders: SelectionStatPlayer[];
	forwards: SelectionStatPlayer[];
	captainSelect: CaptainStatPlayer[];
	viceCaptainSelect: CaptainStatPlayer[];
	mostSelectedPlayers: SelectionStatPlayer[];
	mostTransferIn: TransferStatPlayer[];
	mostTransferOut: TransferStatPlayer[];
};

export type DbTournamentSelectionStatRow = {
	element_id: number;
	pick_count: number;
	captain_count: number;
	vice_captain_count: number;
	transfer_in_count: number;
	transfer_out_count: number;
	total_entries: number;
	selection_percentage: number | string;
	captain_percentage: number | string;
	vice_captain_percentage: number | string;
	effective_ownership_percentage: number | string;
};

const positionTypeToEnum = (type: number): string => {
	switch (type) {
		case 1:
			return "GOALKEEPER";
		case 2:
			return "DEFENDER";
		case 3:
			return "MIDFIELDER";
		case 4:
			return "FORWARD";
		default:
			return "MIDFIELDER";
	}
};

async function getPlayerAndTeamMaps(
	context: GraphQLContext,
	playerIds: number[],
	eventId?: number,
	season?: string
): Promise<{
	playerMap: Map<number, { id: number; web_name: string; team_id: number; type: number }>;
	teamMap: Map<number, { id: number; short_name: string }>;
}> {
	if (playerIds.length === 0) {
		return { playerMap: new Map(), teamMap: new Map() };
	}

	const [fullPlayerMap, fullTeamMap] = await Promise.all([
		buildPlayerMap(context, playerIds),
		buildTeamMap(context),
	]);

	const filteredPlayerMap = new Map<
		number,
		{ id: number; web_name: string; team_id: number; type: number }
	>();
	for (const [id, player] of fullPlayerMap) {
		if (playerIds.includes(id)) {
			filteredPlayerMap.set(id, {
				id: player.id,
				web_name: player.webName,
				team_id: player.teamId,
				type: player.position,
			});
		}
	}

	// Resolve player teams at the requested event for historical accuracy.
	if (eventId !== null && eventId !== undefined && season !== null && season !== undefined) {
		try {
			const playerCodes = [...filteredPlayerMap.values()].map((p) => {
				const full = fullPlayerMap.get(p.id);
				return full?.code ?? 0;
			});
			const validCodes = playerCodes.filter((c) => c > 0);
			if (validCodes.length > 0) {
				const { data, error } = await context.data
					.read("fpl.player_fixture_stats")
					.select("player_code, team_id")
					.eq("season", season)
					.in("player_code", validCodes)
					.lte("event_id", eventId)
					.order("event_id", { ascending: false })
					.order("fixture_id", { ascending: false });
				if (!error && data) {
					const eventTeamMap = new Map<number, number>();
					for (const row of data as { player_code: number; team_id: number }[]) {
						if (!eventTeamMap.has(row.player_code)) {
							eventTeamMap.set(row.player_code, row.team_id);
						}
					}
					for (const [id, player] of filteredPlayerMap) {
						const full = fullPlayerMap.get(id);
						const code = full?.code ?? 0;
						const eventTeamId = code > 0 ? eventTeamMap.get(code) : undefined;
						if (eventTeamId !== undefined && eventTeamId > 0) {
							filteredPlayerMap.set(id, { ...player, team_id: eventTeamId });
						}
					}
				}
			}
		} catch (err) {
			context.logger.warn(
				{ err, eventId, season },
				"Failed to resolve event-scoped player teams; using current data"
			);
		}
	}

	const neededTeamIds = new Set([...filteredPlayerMap.values()].map((p) => p.team_id));
	const filteredTeamMap = new Map<number, { id: number; short_name: string }>();
	for (const [id, team] of fullTeamMap) {
		if (neededTeamIds.has(id)) {
			filteredTeamMap.set(id, { id, short_name: team.shortName });
		}
	}

	return { playerMap: filteredPlayerMap, teamMap: filteredTeamMap };
}

const EMPTY_STATS: TournamentSelectionStats = {
	totalEntries: 0,
	goalkeepers: [],
	defenders: [],
	midfielders: [],
	forwards: [],
	captainSelect: [],
	viceCaptainSelect: [],
	mostSelectedPlayers: [],
	mostTransferIn: [],
	mostTransferOut: [],
};

type SelectionStatsSnapshot = {
	pickCounts: Map<number, number>;
	captainCounts: Map<number, number>;
	viceCaptainCounts: Map<number, number>;
	transferInCounts: Map<number, number>;
	transferOutCounts: Map<number, number>;
	selectionPercentages: Map<number, number>;
	captainPercentages: Map<number, number>;
	viceCaptainPercentages: Map<number, number>;
	effectiveOwnershipPercentages: Map<number, number>;
};

async function getReadModelRows(
	context: GraphQLContext,
	tournamentId: number,
	eventId: number
): Promise<DbTournamentSelectionStatRow[] | null> {
	const { data, error } = await context.data
		.read("reporting.tournament_selection_stats")
		.select(
			"element_id,pick_count,captain_count,vice_captain_count,transfer_in_count,transfer_out_count,total_entries,selection_percentage,captain_percentage,vice_captain_percentage,effective_ownership_percentage"
		)
		.eq("tournament_id", tournamentId)
		.eq("event_id", eventId);

	if (error) {
		context.logger.warn(
			{ err: error, tournamentId, eventId },
			"Failed to fetch tournament selection stats materialized view"
		);
		return null;
	}

	return (data as DbTournamentSelectionStatRow[] | null) ?? [];
}

function snapshotFromReadModel(rows: DbTournamentSelectionStatRow[]): {
	snapshot: SelectionStatsSnapshot;
	totalEntries: number;
} | null {
	const snapshot: SelectionStatsSnapshot = {
		pickCounts: new Map(),
		captainCounts: new Map(),
		viceCaptainCounts: new Map(),
		transferInCounts: new Map(),
		transferOutCounts: new Map(),
		selectionPercentages: new Map(),
		captainPercentages: new Map(),
		viceCaptainPercentages: new Map(),
		effectiveOwnershipPercentages: new Map(),
	};
	let totalEntries = 0;

	for (const row of rows) {
		const playerId = Number(row.element_id);
		if (!Number.isFinite(playerId) || playerId <= 0) continue;

		const pickCount = Number(row.pick_count) || 0;
		const captainCount = Number(row.captain_count) || 0;
		const viceCaptainCount = Number(row.vice_captain_count) || 0;
		const transferInCount = Number(row.transfer_in_count) || 0;
		const transferOutCount = Number(row.transfer_out_count) || 0;
		const rowTotalEntries = Number(row.total_entries);
		const selectionPercentage = Number(row.selection_percentage);
		const captainPercentage = Number(row.captain_percentage);
		const viceCaptainPercentage = Number(row.vice_captain_percentage);
		const effectiveOwnershipPercentage = Number(row.effective_ownership_percentage);
		if (
			!Number.isInteger(rowTotalEntries) ||
			rowTotalEntries <= 0 ||
			(totalEntries !== 0 && totalEntries !== rowTotalEntries) ||
			![
				selectionPercentage,
				captainPercentage,
				viceCaptainPercentage,
				effectiveOwnershipPercentage,
			].every(Number.isFinite)
		) {
			return null;
		}
		totalEntries = rowTotalEntries;

		if (pickCount > 0) snapshot.pickCounts.set(playerId, pickCount);
		if (captainCount > 0) snapshot.captainCounts.set(playerId, captainCount);
		if (viceCaptainCount > 0) snapshot.viceCaptainCounts.set(playerId, viceCaptainCount);
		if (transferInCount > 0) snapshot.transferInCounts.set(playerId, transferInCount);
		if (transferOutCount > 0) snapshot.transferOutCounts.set(playerId, transferOutCount);
		snapshot.selectionPercentages.set(playerId, selectionPercentage);
		snapshot.captainPercentages.set(playerId, captainPercentage);
		snapshot.viceCaptainPercentages.set(playerId, viceCaptainPercentage);
		snapshot.effectiveOwnershipPercentages.set(playerId, effectiveOwnershipPercentage);
	}

	return totalEntries > 0 ? { snapshot, totalEntries } : null;
}

async function buildTournamentSelectionStats(
	context: GraphQLContext,
	snapshot: SelectionStatsSnapshot,
	effectiveTotal: number,
	safeLimit: number,
	eventId?: number,
	season?: string
): Promise<TournamentSelectionStats> {
	const {
		pickCounts,
		captainCounts,
		viceCaptainCounts,
		transferInCounts,
		transferOutCounts,
		selectionPercentages,
		captainPercentages,
		viceCaptainPercentages,
		effectiveOwnershipPercentages,
	} = snapshot;

	const allPlayerIds = [
		...new Set([
			...pickCounts.keys(),
			...captainCounts.keys(),
			...viceCaptainCounts.keys(),
			...transferInCounts.keys(),
			...transferOutCounts.keys(),
		]),
	];

	const { playerMap, teamMap } = await getPlayerAndTeamMaps(context, allPlayerIds, eventId, season);

	const buildSelectionPlayer = (playerId: number): SelectionStatPlayer | null => {
		const player = playerMap.get(playerId);
		if (!player) return null;
		const team = teamMap.get(player.team_id);
		const selectedPct = selectionPercentages.get(playerId) ?? 0;
		const effectiveOwnershipPct = effectiveOwnershipPercentages.get(playerId) ?? 0;
		return {
			id: player.id,
			webName: player.web_name,
			teamShortName: team?.short_name ?? "",
			position: positionTypeToEnum(player.type),
			selectedByPercent: Math.round(selectedPct * 100) / 100,
			eoByPercent: Math.round(effectiveOwnershipPct * 100) / 100,
		};
	};

	const sortedByPick = [...pickCounts.entries()].sort((a, b) => b[1] - a[1]);

	const sortByPosition = (type: number): SelectionStatPlayer[] =>
		sortedByPick
			.filter(([playerId]) => playerMap.get(playerId)?.type === type)
			.slice(0, safeLimit)
			.map(([playerId]) => buildSelectionPlayer(playerId))
			.filter((p): p is SelectionStatPlayer => p !== null);

	const buildCaptainPlayer = (
		playerId: number,
		rolePercentage: number
	): CaptainStatPlayer | null => {
		const player = playerMap.get(playerId);
		if (!player) return null;
		const team = teamMap.get(player.team_id);
		const rolePct = rolePercentage;
		const selectedPct = selectionPercentages.get(playerId) ?? 0;
		const effectiveOwnershipPct = effectiveOwnershipPercentages.get(playerId) ?? 0;
		return {
			id: player.id,
			webName: player.web_name,
			teamShortName: team?.short_name ?? "",
			position: positionTypeToEnum(player.type),
			captainByPercent: Math.round(rolePct * 100) / 100,
			selectedByPercent: Math.round(selectedPct * 100) / 100,
			eoByPercent: Math.round(effectiveOwnershipPct * 100) / 100,
		};
	};

	const captainSelect: CaptainStatPlayer[] = [...captainCounts.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, safeLimit)
		.map(([playerId]) => buildCaptainPlayer(playerId, captainPercentages.get(playerId) ?? 0))
		.filter((p): p is CaptainStatPlayer => p !== null);

	const viceCaptainSelect: CaptainStatPlayer[] = [...viceCaptainCounts.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, safeLimit)
		.map(([playerId]) => buildCaptainPlayer(playerId, viceCaptainPercentages.get(playerId) ?? 0))
		.filter((p): p is CaptainStatPlayer => p !== null);

	const mostSelectedPlayers: SelectionStatPlayer[] = sortedByPick
		.slice(0, safeLimit)
		.map(([playerId]) => buildSelectionPlayer(playerId))
		.filter((p): p is SelectionStatPlayer => p !== null);

	const buildTransferPlayer = (
		playerId: number,
		transferCount: number
	): TransferStatPlayer | null => {
		const player = playerMap.get(playerId);
		if (!player) return null;
		const team = teamMap.get(player.team_id);
		const selectedPct = selectionPercentages.get(playerId) ?? 0;
		return {
			id: player.id,
			webName: player.web_name,
			teamShortName: team?.short_name ?? "",
			position: positionTypeToEnum(player.type),
			transfersEvent: transferCount,
			selectedByPercent: Math.round(selectedPct * 100) / 100,
		};
	};

	const mostTransferIn: TransferStatPlayer[] = [...transferInCounts.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, safeLimit)
		.map(([playerId, count]) => buildTransferPlayer(playerId, count))
		.filter((p): p is TransferStatPlayer => p !== null);

	const mostTransferOut: TransferStatPlayer[] = [...transferOutCounts.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, safeLimit)
		.map(([playerId, count]) => buildTransferPlayer(playerId, count))
		.filter((p): p is TransferStatPlayer => p !== null);

	return {
		totalEntries: effectiveTotal,
		goalkeepers: sortByPosition(1),
		defenders: sortByPosition(2),
		midfielders: sortByPosition(3),
		forwards: sortByPosition(4),
		captainSelect,
		viceCaptainSelect,
		mostSelectedPlayers,
		mostTransferIn,
		mostTransferOut,
	};
}

/**
 * Public-safe path: consume only a published aggregate snapshot. It never
 * falls back to entry IDs, picks, or the per-manager aggregation RPCs.
 */
export async function getTournamentSelectionStatsReadModel(
	context: GraphQLContext,
	tournamentId: number,
	eventId: number,
	limit: number
): Promise<TournamentSelectionStats | null> {
	if (!Number.isFinite(tournamentId) || tournamentId <= 0) return null;
	if (!Number.isFinite(eventId) || eventId <= 0) return null;
	const safeLimit = Math.min(Math.max(limit, 1), 12);
	const rows = await getReadModelRows(context, tournamentId, eventId);
	if (!rows || rows.length === 0) return null;
	const parsed = snapshotFromReadModel(rows);
	if (!parsed) return null;
	const { snapshot, totalEntries } = parsed;
	const season = await getCurrentSeason(context);
	return buildTournamentSelectionStats(context, snapshot, totalEntries, safeLimit, eventId, season);
}

export interface EventStatsRepository {
	getTournamentSelectionStats(
		context: GraphQLContext,
		tournamentId: number,
		eventId: number,
		limit: number
	): Promise<TournamentSelectionStats>;
}

export const eventStatsRepository: EventStatsRepository = {
	async getTournamentSelectionStats(
		context: GraphQLContext,
		tournamentId: number,
		eventId: number,
		limit: number
	): Promise<TournamentSelectionStats> {
		if (!Number.isFinite(tournamentId) || tournamentId <= 0) return EMPTY_STATS;
		if (!Number.isFinite(eventId) || eventId <= 0) return EMPTY_STATS;
		const safeLimit = Math.min(Math.max(limit, 1), 100);

		const cacheKey = await privateCacheKey(
			context,
			`tournament-selection-stats:${tournamentId}:${eventId}:${safeLimit}`
		);
		const cached = await readCachedJson(context, cacheKey);
		if (isRecord(cached)) {
			return cached as unknown as TournamentSelectionStats;
		}

		const readModelRows = await getReadModelRows(context, tournamentId, eventId);
		if (readModelRows && readModelRows.length > 0) {
			const parsed = snapshotFromReadModel(readModelRows);
			if (!parsed) return EMPTY_STATS;
			const { snapshot, totalEntries } = parsed;
			const season = await getCurrentSeason(context);
			const result = await buildTournamentSelectionStats(
				context,
				snapshot,
				totalEntries,
				safeLimit,
				eventId,
				season
			);
			await context.redis.set(cacheKey, JSON.stringify(result), "EX", env.CACHE_TTL_SECONDS);
			return result;
		}

		return EMPTY_STATS;
	},
};
