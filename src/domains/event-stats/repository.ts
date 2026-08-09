import type { GraphQLContext } from "../../graphql/context";
import { gqlCacheKey } from "../../infra/cache-key";
import { env } from "../../infra/env";
import { getCurrentSeason } from "../../infra/season";
import { buildPlayerMap } from "../../infra/player-map";
import { buildTeamMap } from "../../infra/team-map";

const privateCacheKey = async (context: GraphQLContext, key: string): Promise<string> =>
	gqlCacheKey(await getCurrentSeason(context), key);

const SELECTION_STATS_PAGE_SIZE = 1000;
const PLAYER_TEAM_PAGE_SIZE = 1000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const evictMalformedCache = async (context: GraphQLContext, key: string): Promise<void> => {
	try {
		await context.redis.del(key);
	} catch (error) {
		context.logger.warn({ err: error, key }, "Failed to evict malformed event-stats cache");
	}
};

const writeCacheBestEffort = async (
	context: GraphQLContext,
	key: string,
	value: string,
	message: string
): Promise<void> => {
	try {
		await context.redis.set(key, value, "EX", env.CACHE_TTL_SECONDS);
	} catch (error) {
		context.logger.warn({ err: error, key }, message);
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

type DbTournamentInfoRow = {
	league_id: number;
	league_type: string;
};

type RpcCaptainCountRow = {
	captain_id: number;
	count: number;
	total_entries: number;
};

type RpcPickAggregationRow = {
	element_id: number;
	pick_count: number;
	vice_captain_count: number;
};

type RpcTransferAggregationRow = {
	element_id: number;
	transfer_in_count: number | null;
	transfer_out_count: number | null;
};

export type DbTournamentSelectionStatRow = {
	element_id: number;
	pick_count: number;
	captain_count: number;
	vice_captain_count: number;
	transfer_in_count: number;
	transfer_out_count: number;
	total_entries: number;
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
				const eventTeamRows: { player_code: number; team_id: number }[] = [];
				for (let offset = 0; ; offset += PLAYER_TEAM_PAGE_SIZE) {
					const { data, error } = await context.supabase
						.from("fpl_player_fixture_stats")
						.select("player_code, team_id")
						.eq("season", season)
						.in("player_code", validCodes)
						.lte("event_id", eventId)
						.order("event_id", { ascending: false })
						.order("fixture_id", { ascending: false })
						.range(offset, offset + PLAYER_TEAM_PAGE_SIZE - 1);
					if (error) {
						throw new Error(error.message, { cause: error });
					}
					const page = (data as { player_code: number; team_id: number }[] | null) ?? [];
					eventTeamRows.push(...page);
					if (page.length < PLAYER_TEAM_PAGE_SIZE) break;
				}

				const eventTeamMap = new Map<number, number>();
				for (const row of eventTeamRows) {
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

async function getTournamentInfo(
	context: GraphQLContext,
	tournamentId: number
): Promise<DbTournamentInfoRow | null> {
	// Distinct from tournaments domain key `tournament:info:` (full TournamentInfo).
	const cacheKey = await privateCacheKey(context, `tournament:info:league:${tournamentId}`);
	const cached = await readCachedJson(context, cacheKey);
	if (isRecord(cached)) {
		return cached as unknown as DbTournamentInfoRow;
	}

	const { data, error } = await context.supabase
		.from("tournament_infos")
		.select("league_id, league_type")
		.eq("id", tournamentId)
		.limit(1);

	if (error || !data?.[0]) {
		context.logger.error({ err: error, tournamentId }, "Failed to fetch tournament info");
		return null;
	}

	const row = data[0] as DbTournamentInfoRow;
	await writeCacheBestEffort(
		context,
		cacheKey,
		JSON.stringify(row),
		"Failed to write tournament info cache"
	);
	return row;
}

async function getCaptainCounts(
	context: GraphQLContext,
	tournamentId: number,
	leagueId: number,
	leagueType: string,
	eventId: number,
	entryIds: number[]
): Promise<{ captainCounts: Map<number, number>; totalEntries: number }> {
	const cacheKey = await privateCacheKey(
		context,
		`tournament-selection-stats:captain-counts:${tournamentId}:${eventId}`
	);
	const cached = await readCachedJson(context, cacheKey);
	if (isRecord(cached)) {
		const parsed = cached as {
			captainCounts: [number, number][];
			totalEntries: number;
		};
		return {
			captainCounts: new Map(parsed.captainCounts),
			totalEntries: parsed.totalEntries,
		};
	}

	const rpcResult = await context.supabase.rpc("get_captain_counts_for_entries", {
		p_league_id: leagueId,
		p_league_type: leagueType,
		p_event_id: eventId,
		p_entry_ids: entryIds,
	});

	if (rpcResult.error) {
		context.logger.error(
			{ err: rpcResult.error, tournamentId, eventId },
			"Failed to fetch captain counts via RPC"
		);
		throw new Error("Failed to fetch captain counts");
	}

	const rows = (rpcResult.data as RpcCaptainCountRow[] | null) ?? [];
	const captainCounts = new Map<number, number>();
	let totalEntries = 0;

	for (const row of rows) {
		captainCounts.set(row.captain_id, Number(row.count));
		totalEntries = Number(row.total_entries);
	}

	const result = { captainCounts, totalEntries };
	await writeCacheBestEffort(
		context,
		cacheKey,
		JSON.stringify({
			captainCounts: [...captainCounts.entries()],
			totalEntries,
		}),
		"Failed to write captain aggregation cache"
	);

	return result;
}

async function getPickAggregation(
	context: GraphQLContext,
	tournamentId: number,
	entryIds: number[],
	eventId: number
): Promise<{
	pickCounts: Map<number, number>;
	viceCaptainCounts: Map<number, number>;
}> {
	if (entryIds.length === 0) {
		return { pickCounts: new Map(), viceCaptainCounts: new Map() };
	}

	const cacheKey = await privateCacheKey(
		context,
		`tournament-selection-stats:pick-aggregation:${tournamentId}:${eventId}`
	);
	const cached = await readCachedJson(context, cacheKey);
	if (isRecord(cached)) {
		const parsed = cached as {
			pickCounts: [number, number][];
			viceCaptainCounts: [number, number][];
		};
		return {
			pickCounts: new Map(parsed.pickCounts),
			viceCaptainCounts: new Map(parsed.viceCaptainCounts),
		};
	}

	const result = await context.supabase.rpc("get_pick_aggregation", {
		p_event_id: eventId,
		p_entry_ids: entryIds,
	});

	if (result.error) {
		context.logger.error(
			{ err: result.error, eventId, entryCount: entryIds.length },
			"Failed to fetch pick aggregation via RPC"
		);
		throw new Error("Failed to fetch pick aggregation");
	}

	const rows = (result.data as RpcPickAggregationRow[] | null) ?? [];
	const pickCounts = new Map<number, number>();
	const viceCaptainCounts = new Map<number, number>();

	for (const row of rows) {
		pickCounts.set(row.element_id, Number(row.pick_count));
		if (Number(row.vice_captain_count) > 0) {
			viceCaptainCounts.set(row.element_id, Number(row.vice_captain_count));
		}
	}

	await writeCacheBestEffort(
		context,
		cacheKey,
		JSON.stringify({
			pickCounts: [...pickCounts.entries()],
			viceCaptainCounts: [...viceCaptainCounts.entries()],
		}),
		"Failed to write pick aggregation cache"
	);

	return { pickCounts, viceCaptainCounts };
}

async function getTransferAggregation(
	context: GraphQLContext,
	tournamentId: number,
	entryIds: number[],
	eventId: number
): Promise<{
	transferInCounts: Map<number, number>;
	transferOutCounts: Map<number, number>;
}> {
	if (entryIds.length === 0) {
		return { transferInCounts: new Map(), transferOutCounts: new Map() };
	}

	const cacheKey = await privateCacheKey(
		context,
		`tournament-selection-stats:transfer-aggregation:${tournamentId}:${eventId}`
	);
	const cached = await readCachedJson(context, cacheKey);
	if (isRecord(cached)) {
		const parsed = cached as {
			transferInCounts: [number, number][];
			transferOutCounts: [number, number][];
		};
		return {
			transferInCounts: new Map(parsed.transferInCounts),
			transferOutCounts: new Map(parsed.transferOutCounts),
		};
	}

	const result = await context.supabase.rpc("get_transfer_aggregation", {
		p_event_id: eventId,
		p_entry_ids: entryIds,
	});

	if (result.error) {
		context.logger.error(
			{ err: result.error, eventId, entryCount: entryIds.length },
			"Failed to fetch transfer aggregation via RPC"
		);
		throw new Error("Failed to fetch transfer aggregation");
	}

	const rows = (result.data as RpcTransferAggregationRow[] | null) ?? [];
	const transferInCounts = new Map<number, number>();
	const transferOutCounts = new Map<number, number>();

	for (const row of rows) {
		if (row.transfer_in_count !== null && Number(row.transfer_in_count) > 0) {
			transferInCounts.set(row.element_id, Number(row.transfer_in_count));
		}
		if (row.transfer_out_count !== null && Number(row.transfer_out_count) > 0) {
			transferOutCounts.set(row.element_id, Number(row.transfer_out_count));
		}
	}

	await writeCacheBestEffort(
		context,
		cacheKey,
		JSON.stringify({
			transferInCounts: [...transferInCounts.entries()],
			transferOutCounts: [...transferOutCounts.entries()],
		}),
		"Failed to write transfer aggregation cache"
	);

	return { transferInCounts, transferOutCounts };
}

async function getTournamentEntryIdsUncached(
	context: GraphQLContext,
	tournamentId: number
): Promise<number[]> {
	const entryIds: number[] = [];
	for (let from = 0; ; from += SELECTION_STATS_PAGE_SIZE) {
		const { data, error } = await context.supabase
			.from("tournament_entries")
			.select("entry_id")
			.eq("tournament_id", tournamentId)
			.order("entry_id", { ascending: true })
			.range(from, from + SELECTION_STATS_PAGE_SIZE - 1);
		if (error) {
			context.logger.error({ err: error, tournamentId }, "Failed to fetch tournament entry IDs");
			throw new Error("Failed to fetch tournament entry IDs");
		}
		const page = ((data as { entry_id: number }[] | null) ?? []).map((r) => r.entry_id);
		entryIds.push(...page);
		if (page.length < SELECTION_STATS_PAGE_SIZE) break;
	}

	return entryIds;
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

type SelectionStatsCounts = {
	pickCounts: Map<number, number>;
	captainCounts: Map<number, number>;
	viceCaptainCounts: Map<number, number>;
	transferInCounts: Map<number, number>;
	transferOutCounts: Map<number, number>;
};

async function getReadModelRows(
	context: GraphQLContext,
	tournamentId: number,
	eventId: number
): Promise<DbTournamentSelectionStatRow[] | null> {
	const { data, error } = await context.supabase
		.from("tournament_selection_stats")
		.select(
			"element_id,pick_count,captain_count,vice_captain_count,transfer_in_count,transfer_out_count,total_entries"
		)
		.eq("tournament_id", tournamentId)
		.eq("event_id", eventId);

	if (error) {
		context.logger.warn(
			{ err: error, tournamentId, eventId },
			"Failed to fetch tournament selection stats read model; falling back to RPC aggregation"
		);
		return null;
	}

	return (data as DbTournamentSelectionStatRow[] | null) ?? [];
}

function countsFromReadModel(rows: DbTournamentSelectionStatRow[]): {
	counts: SelectionStatsCounts;
	totalEntries: number;
} {
	const counts: SelectionStatsCounts = {
		pickCounts: new Map(),
		captainCounts: new Map(),
		viceCaptainCounts: new Map(),
		transferInCounts: new Map(),
		transferOutCounts: new Map(),
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
		totalEntries = Math.max(totalEntries, Number(row.total_entries) || 0);

		if (pickCount > 0) counts.pickCounts.set(playerId, pickCount);
		if (captainCount > 0) counts.captainCounts.set(playerId, captainCount);
		if (viceCaptainCount > 0) counts.viceCaptainCounts.set(playerId, viceCaptainCount);
		if (transferInCount > 0) counts.transferInCounts.set(playerId, transferInCount);
		if (transferOutCount > 0) counts.transferOutCounts.set(playerId, transferOutCount);
	}

	return { counts, totalEntries };
}

async function buildTournamentSelectionStats(
	context: GraphQLContext,
	counts: SelectionStatsCounts,
	effectiveTotal: number,
	safeLimit: number,
	eventId?: number,
	season?: string
): Promise<TournamentSelectionStats> {
	const { pickCounts, captainCounts, viceCaptainCounts, transferInCounts, transferOutCounts } =
		counts;

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

	const computeEoPercent = (playerId: number, selectedPct: number): number => {
		const captainCount = captainCounts.get(playerId) ?? 0;
		const captainPct = effectiveTotal > 0 ? (captainCount / effectiveTotal) * 100 : 0;
		return selectedPct + captainPct;
	};

	const buildSelectionPlayer = (
		playerId: number,
		pickCount: number
	): SelectionStatPlayer | null => {
		const player = playerMap.get(playerId);
		if (!player) return null;
		const team = teamMap.get(player.team_id);
		const selectedPct = effectiveTotal > 0 ? (pickCount / effectiveTotal) * 100 : 0;
		return {
			id: player.id,
			webName: player.web_name,
			teamShortName: team?.short_name ?? "",
			position: positionTypeToEnum(player.type),
			selectedByPercent: Math.round(selectedPct * 100) / 100,
			eoByPercent: Math.round(computeEoPercent(playerId, selectedPct) * 100) / 100,
		};
	};

	const sortedByPick = [...pickCounts.entries()].sort((a, b) => b[1] - a[1]);

	const sortByPosition = (type: number): SelectionStatPlayer[] =>
		sortedByPick
			.filter(([playerId]) => playerMap.get(playerId)?.type === type)
			.slice(0, safeLimit)
			.map(([playerId, count]) => buildSelectionPlayer(playerId, count))
			.filter((p): p is SelectionStatPlayer => p !== null);

	const buildCaptainPlayer = (playerId: number, roleCount: number): CaptainStatPlayer | null => {
		const player = playerMap.get(playerId);
		if (!player) return null;
		const team = teamMap.get(player.team_id);
		const rolePct = effectiveTotal > 0 ? (roleCount / effectiveTotal) * 100 : 0;
		const pickCount = pickCounts.get(playerId) ?? 0;
		const selectedPct = effectiveTotal > 0 ? (pickCount / effectiveTotal) * 100 : 0;
		return {
			id: player.id,
			webName: player.web_name,
			teamShortName: team?.short_name ?? "",
			position: positionTypeToEnum(player.type),
			captainByPercent: Math.round(rolePct * 100) / 100,
			selectedByPercent: Math.round(selectedPct * 100) / 100,
			eoByPercent: Math.round(computeEoPercent(playerId, selectedPct) * 100) / 100,
		};
	};

	const captainSelect: CaptainStatPlayer[] = [...captainCounts.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, safeLimit)
		.map(([playerId, count]) => buildCaptainPlayer(playerId, count))
		.filter((p): p is CaptainStatPlayer => p !== null);

	const viceCaptainSelect: CaptainStatPlayer[] = [...viceCaptainCounts.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, safeLimit)
		.map(([playerId, count]) => buildCaptainPlayer(playerId, count))
		.filter((p): p is CaptainStatPlayer => p !== null);

	const mostSelectedPlayers: SelectionStatPlayer[] = sortedByPick
		.slice(0, safeLimit)
		.map(([playerId, count]) => buildSelectionPlayer(playerId, count))
		.filter((p): p is SelectionStatPlayer => p !== null);

	const buildTransferPlayer = (
		playerId: number,
		transferCount: number
	): TransferStatPlayer | null => {
		const player = playerMap.get(playerId);
		if (!player) return null;
		const team = teamMap.get(player.team_id);
		const pickCount = pickCounts.get(playerId) ?? 0;
		const selectedPct = effectiveTotal > 0 ? (pickCount / effectiveTotal) * 100 : 0;
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
	const { counts, totalEntries } = countsFromReadModel(rows);
	const season = await getCurrentSeason(context);
	return buildTournamentSelectionStats(context, counts, totalEntries, safeLimit, eventId, season);
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
			const { counts, totalEntries } = countsFromReadModel(readModelRows);
			const season = await getCurrentSeason(context);
			const result = await buildTournamentSelectionStats(
				context,
				counts,
				totalEntries,
				safeLimit,
				eventId,
				season
			);
			try {
				await context.redis.set(cacheKey, JSON.stringify(result), "EX", env.CACHE_TTL_SECONDS);
			} catch (error) {
				context.logger.warn(
					{ err: error, key: cacheKey },
					"Failed to write tournament selection stats cache"
				);
			}
			return result;
		}

		// The resolver has crossed the insights barrier; reread membership so a
		// setup-era roster cache cannot seed a partial aggregate.
		const [tournamentInfo, entryIds] = await Promise.all([
			getTournamentInfo(context, tournamentId),
			getTournamentEntryIdsUncached(context, tournamentId),
		]);
		if (!tournamentInfo) return EMPTY_STATS;

		// Now fan out all three aggregations in one round-trip group
		const [
			{ captainCounts, totalEntries },
			{ pickCounts, viceCaptainCounts },
			{ transferInCounts, transferOutCounts },
		] = await Promise.all([
			getCaptainCounts(
				context,
				tournamentId,
				tournamentInfo.league_id,
				tournamentInfo.league_type,
				eventId,
				entryIds
			),
			getPickAggregation(context, tournamentId, entryIds, eventId),
			getTransferAggregation(context, tournamentId, entryIds, eventId),
		]);

		if (totalEntries === 0 && entryIds.length === 0) return EMPTY_STATS;

		const effectiveTotal = totalEntries > 0 ? totalEntries : entryIds.length;

		const season = await getCurrentSeason(context);
		const result = await buildTournamentSelectionStats(
			context,
			{
				pickCounts,
				captainCounts,
				viceCaptainCounts,
				transferInCounts,
				transferOutCounts,
			},
			effectiveTotal,
			safeLimit,
			eventId,
			season
		);

		try {
			await context.redis.set(cacheKey, JSON.stringify(result), "EX", env.CACHE_TTL_SECONDS);
		} catch (error) {
			context.logger.warn(
				{ err: error, key: cacheKey },
				"Failed to write tournament selection stats cache"
			);
		}
		return result;
	},
};
