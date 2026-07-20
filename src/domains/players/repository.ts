import type { GraphQLContext } from "../../graphql/context";
import { gqlCacheKey } from "../../infra/cache-key";
import { getCurrentSeason } from "../../infra/season";
import { stableStringify } from "../../infra/stringify";
import { buildTeamMap } from "../../infra/team-map";
import type { Player as InfraPlayer, Team as InfraTeam } from "../../infra/types";

export enum Position {
	GOALKEEPER = 1,
	DEFENDER = 2,
	MIDFIELDER = 3,
	FORWARD = 4,
}

export type Team = InfraTeam;

export type Player = Omit<InfraPlayer, "position"> & {
	position: Position;
};

export type PlayersFilter = {
	position?: Position | null;
	teamId?: number | null;
	minPrice?: number | null;
	maxPrice?: number | null;
};

type DbPlayerRow = {
	id: number;
	code: number;
	web_name: string;
	first_name: string | null;
	second_name: string | null;
	team_id: number;
	type: number;
	price: number;
	start_price: number;
};

const asNullableNumber = (value: number | string | null | undefined): number | null => {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}
	if (typeof value === "string") {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : null;
	}
	return null;
};

const mapPlayer = (row: DbPlayerRow): Player => ({
	id: row.id,
	code: row.code,
	webName: row.web_name,
	firstName: row.first_name,
	secondName: row.second_name,
	teamId: row.team_id,
	position: row.type as Position,
	price: row.price,
	startPrice: row.start_price,
	totalPoints: 0,
	selectedByPercent: null,
});

const evictMalformedCache = async (context: GraphQLContext, key: string): Promise<void> => {
	try {
		await context.redis.del(key);
	} catch (error) {
		context.logger.warn({ err: error, key }, "Failed to evict malformed player cache");
	}
};

const isPlayer = (value: unknown): value is Player => {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const player = value as Record<string, unknown>;
	return (
		typeof player.id === "number" &&
		Number.isFinite(player.id) &&
		typeof player.teamId === "number" &&
		Number.isFinite(player.teamId) &&
		typeof player.position === "number" &&
		Number.isFinite(player.position)
	);
};

const isPlayerList = (value: unknown): value is Player[] =>
	Array.isArray(value) && value.every((item) => isPlayer(item));

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const isTopTransfersEnriched = (value: unknown): value is TopTransfersEnriched => {
	if (!isObject(value) || !Array.isArray(value.stats) || !isObject(value.players)) return false;
	return value.stats.every(
		(stat) =>
			isObject(stat) &&
			typeof stat.playerId === "number" &&
			typeof stat.eventId === "number" &&
			typeof stat.transfersInEvent === "number" &&
			typeof stat.transfersOutEvent === "number"
	);
};

const readJsonCache = async <T>(
	context: GraphQLContext,
	key: string,
	validate: (value: unknown) => value is T
): Promise<T | undefined> => {
	let raw: string | null;
	try {
		raw = await context.redis.get(key);
	} catch (error) {
		context.logger.warn({ err: error, key }, "Failed to read player cache");
		return undefined;
	}
	if (raw === null) return undefined;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (validate(parsed)) return parsed;
	} catch (error) {
		context.logger.warn({ err: error, key }, "Malformed player cache");
	}
	await evictMalformedCache(context, key);
	return undefined;
};

const normalizeFilter = (filter?: PlayersFilter | null): PlayersFilter | undefined => {
	if (!filter) {
		return undefined;
	}
	return {
		position: filter.position ?? undefined,
		teamId: filter.teamId ?? undefined,
		minPrice: filter.minPrice ?? undefined,
		maxPrice: filter.maxPrice ?? undefined,
	};
};

const clampLimit = (limit: number): number => {
	const safeLimit = Number.isFinite(limit) ? limit : 50;
	return Math.min(Math.max(safeLimit, 1), 200);
};

const PICKER_CACHE_TTL = 300;

export type PlayerPickerTeam = {
	id: number;
	name: string;
	shortName: string;
};

export type PlayerPickerItem = {
	id: number;
	webName: string;
	position: Position;
	team: PlayerPickerTeam;
};

export type PlayersForPickerPayload = {
	items: PlayerPickerItem[];
	nextCursor: number | null;
};

type DbPickerRow = {
	id: number;
	web_name: string;
	element_type: number;
	team_id: number;
	team_name: string;
	team_short_name: string;
};

const mapPickerRow = (row: DbPickerRow): PlayerPickerItem => ({
	id: row.id,
	webName: row.web_name,
	position: row.element_type as Position,
	team: {
		id: row.team_id,
		name: row.team_name,
		shortName: row.team_short_name,
	},
});

export type PlayerTransferStats = {
	playerId: number;
	eventId: number;
	transfersInEvent: number;
	transfersOutEvent: number;
};

export type TopTransfersEnriched = {
	stats: PlayerTransferStats[];
	players: Record<number, Player>;
};

interface PlayersRepository {
	getPlayerById(context: GraphQLContext, id: number): Promise<Player | null>;
	getPlayerByIdForEvent(
		context: GraphQLContext,
		id: number,
		eventId: number
	): Promise<Player | null>;
	getPlayersByIdsForEvent(
		context: GraphQLContext,
		ids: number[],
		eventId: number
	): Promise<Map<number, Player>>;
	getPlayersByIds(context: GraphQLContext, ids: number[]): Promise<Player[]>;
	getPlayersFromRedis(context: GraphQLContext): Promise<Map<number, Player>>;
	getPlayersForPicker(
		context: GraphQLContext,
		limit: number,
		cursor: number | null | undefined
	): Promise<PlayersForPickerPayload>;
	listPlayers(
		context: GraphQLContext,
		filter: PlayersFilter | null | undefined,
		limit: number,
		offset: number
	): Promise<Player[]>;
	getTeamById(context: GraphQLContext, id: number): Promise<Team | null>;
	listTeams(context: GraphQLContext): Promise<Team[]>;
	listTeamsFromRedis(context: GraphQLContext): Promise<Team[]>;
	getTopTransfersInEnriched(
		context: GraphQLContext,
		eventId: number,
		limit: number
	): Promise<TopTransfersEnriched>;
	getTopTransfersOutEnriched(
		context: GraphQLContext,
		eventId: number,
		limit: number
	): Promise<TopTransfersEnriched>;
}

// Player data (base info + per-event stats) is stable historical data — 1h TTL.
const PLAYER_CACHE_TTL = 3600;

type RawTransferRow = {
	element_id: number;
	event_id: number;
	transfers_in_event: number | null;
	transfers_out_event: number | null;
};

// Fetches only the top-N transfer rows for an event, sorted server-side.
// Avoids pulling all 800+ rows over the wire just to sort in JS.
const fetchTopTransferRows = async (
	context: GraphQLContext,
	eventId: number,
	direction: "in" | "out",
	limit: number
): Promise<RawTransferRow[]> => {
	const col = direction === "in" ? "transfers_in_event" : "transfers_out_event";
	const { data, error } = await context.supabase
		.from("player_stats")
		.select("element_id, event_id, transfers_in_event, transfers_out_event")
		.eq("event_id", eventId)
		.not(col, "is", null)
		.order(col, { ascending: false })
		.limit(limit);

	if (error) {
		context.logger.error({ err: error, eventId, direction }, "Failed to fetch top transfer rows");
		throw new Error("Failed to fetch top transfer rows");
	}

	return (data as RawTransferRow[] | null) ?? [];
};

export const playersRepository: PlayersRepository = {
	async getPlayerById(context: GraphQLContext, id: number): Promise<Player | null> {
		const season = await getCurrentSeason(context);
		const cacheKey = gqlCacheKey(season, `players:id:${id}`);
		const cached = await readJsonCache(context, cacheKey, isPlayer);
		if (cached) {
			return cached;
		}

		// Try externally-managed Player:{season} hash before hitting Supabase
		let hashRaw: string | null = null;
		try {
			hashRaw = await context.redis.hget(`Player:${season}`, String(id));
		} catch (error) {
			context.logger.warn({ err: error, season, id }, "Failed to read Player hash");
		}
		if (hashRaw) {
			try {
				const parsed = JSON.parse(hashRaw) as Record<string, unknown>;
				const player: Player = {
					id,
					code: Number(parsed.code ?? 0),
					webName: String(parsed.webName ?? parsed.web_name ?? ""),
					firstName: parsed.firstName
						? String(parsed.firstName)
						: parsed.first_name
							? String(parsed.first_name)
							: null,
					secondName: parsed.secondName
						? String(parsed.secondName)
						: parsed.second_name
							? String(parsed.second_name)
							: null,
					teamId: Number(parsed.teamId ?? parsed.team_id ?? 0),
					position: Number(parsed.type ?? parsed.position ?? 0) as Position,
					price: Number(parsed.price ?? 0),
					startPrice: Number(parsed.startPrice ?? parsed.start_price ?? 0),
					totalPoints: Number(parsed.totalPoints ?? 0),
					selectedByPercent:
						typeof parsed.selectedByPercent === "number"
							? parsed.selectedByPercent
							: typeof parsed.selected_by_percent === "number"
								? parsed.selected_by_percent
								: null,
				};
				await context.redis.set(cacheKey, JSON.stringify(player), "EX", PLAYER_CACHE_TTL);
				return player;
			} catch {
				/* fall through to Supabase */
			}
		}

		const { data, error } = await context.supabase
			.from("players")
			.select("id, code, web_name, first_name, second_name, team_id, type, price, start_price")
			.eq("id", id)
			.limit(1);

		if (error) {
			context.logger.error({ err: error, id }, "Failed to fetch player");
			throw new Error("Failed to fetch player");
		}

		const row = data?.[0] as DbPlayerRow | undefined;
		if (!row) {
			return null;
		}

		const player = mapPlayer(row);
		await context.redis.set(cacheKey, JSON.stringify(player), "EX", PLAYER_CACHE_TTL);
		return player;
	},

	async getPlayerByIdForEvent(
		context: GraphQLContext,
		id: number,
		eventId: number
	): Promise<Player | null> {
		const season = await getCurrentSeason(context);
		const cacheKey = gqlCacheKey(season, `players:id:${id}:event:${eventId}`);
		const cached = await readJsonCache(context, cacheKey, isPlayer);
		if (cached) {
			return cached;
		}

		const [basePlayer, statsResult] = await Promise.all([
			this.getPlayerById(context, id),
			context.supabase
				.from("player_stats")
				.select("total_points, selected_by_percent")
				.eq("event_id", eventId)
				.eq("element_id", id)
				.limit(1),
		]);

		if (!basePlayer) {
			return null;
		}

		if (statsResult.error) {
			context.logger.error(
				{ err: statsResult.error, eventId, playerId: id },
				"Failed to fetch player event stats"
			);
			throw new Error("Failed to fetch player event stats", { cause: statsResult.error });
		}

		const row = statsResult.data?.[0] as
			| {
					total_points?: number | null;
					selected_by_percent?: number | string | null;
			  }
			| undefined;

		const playerForEvent: Player = {
			...basePlayer,
			totalPoints: row?.total_points ?? basePlayer.totalPoints,
			selectedByPercent: asNullableNumber(row?.selected_by_percent) ?? basePlayer.selectedByPercent,
		};

		await context.redis.set(cacheKey, JSON.stringify(playerForEvent), "EX", PLAYER_CACHE_TTL);
		return playerForEvent;
	},

	async getPlayersByIdsForEvent(
		context: GraphQLContext,
		ids: number[],
		eventId: number
	): Promise<Map<number, Player>> {
		if (ids.length === 0) return new Map();
		const season = await getCurrentSeason(context);

		// One MGET for all per-event keys instead of N sequential GETs
		const keys = ids.map((id) => gqlCacheKey(season, `players:id:${id}:event:${eventId}`));
		let rawValues: (string | null)[];
		try {
			rawValues = await context.redis.mget(...keys);
		} catch (error) {
			context.logger.warn({ err: error, keys }, "Failed to read player event cache");
			rawValues = Array.from({ length: ids.length }, () => null);
		}

		const result = new Map<number, Player>();
		const missIds: number[] = [];
		for (let i = 0; i < ids.length; i++) {
			const raw = rawValues[i];
			if (raw) {
				try {
					const parsed: unknown = JSON.parse(raw);
					if (isPlayer(parsed)) {
						result.set(ids[i], parsed);
						continue;
					}
				} catch (error) {
					context.logger.warn({ err: error, key: keys[i] }, "Malformed player event cache");
				}
				await evictMalformedCache(context, keys[i]);
				missIds.push(ids[i]);
			} else {
				missIds.push(ids[i]);
			}
		}

		if (missIds.length === 0) return result;

		// Fetch base players (HMGET only miss IDs) and per-event stats in parallel
		const [basePlayers, statsResult] = await Promise.all([
			this.getPlayersByIds(context, missIds),
			context.supabase
				.from("player_stats")
				.select("element_id, total_points, selected_by_percent")
				.eq("event_id", eventId)
				.in("element_id", missIds),
		]);

		const basePlayersMap = new Map(basePlayers.map((p) => [p.id, p]));
		if (statsResult.error) {
			throw new Error("Failed to fetch player event stats", { cause: statsResult.error });
		}

		type StatsRow = {
			element_id: number;
			total_points: number | null;
			selected_by_percent: number | string | null;
		};
		const statsMap = new Map<number, StatsRow>();
		for (const row of (statsResult.data ?? []) as StatsRow[]) {
			statsMap.set(row.element_id, row);
		}

		// Write all merged players in a single pipeline
		const pipeline = context.redis.pipeline();
		for (const id of missIds) {
			const base = basePlayersMap.get(id);
			if (!base) continue;
			const stats = statsMap.get(id);
			const player: Player = {
				...base,
				totalPoints: stats?.total_points ?? base.totalPoints,
				selectedByPercent: asNullableNumber(stats?.selected_by_percent) ?? base.selectedByPercent,
			};
			result.set(id, player);
			pipeline.set(
				gqlCacheKey(season, `players:id:${id}:event:${eventId}`),
				JSON.stringify(player),
				"EX",
				PLAYER_CACHE_TTL
			);
		}
		await pipeline.exec();

		return result;
	},

	async getPlayersByIds(context: GraphQLContext, ids: number[]): Promise<Player[]> {
		const uniqueIds = Array.from(new Set(ids.filter((id) => Number.isFinite(id) && id > 0)));
		if (uniqueIds.length === 0) {
			return [];
		}

		// Use HMGET on Player:{season} to fetch only the needed IDs
		const season = await getCurrentSeason(context);
		const hashKey = `Player:${season}`;
		let values: (string | null)[];
		try {
			values = await context.redis.hmget(hashKey, ...uniqueIds.map(String));
		} catch (error) {
			context.logger.warn({ err: error, hashKey }, "Failed to read Player hash fields");
			values = Array.from({ length: uniqueIds.length }, () => null);
		}

		const result: Player[] = [];
		const missIds: number[] = [];

		for (let i = 0; i < uniqueIds.length; i++) {
			const raw = values[i];
			if (raw) {
				try {
					const parsed = JSON.parse(raw) as Record<string, unknown>;
					result.push({
						id: uniqueIds[i],
						code: Number(parsed.code ?? 0),
						webName: String(parsed.webName ?? parsed.web_name ?? ""),
						firstName: parsed.firstName
							? String(parsed.firstName)
							: parsed.first_name
								? String(parsed.first_name)
								: null,
						secondName: parsed.secondName
							? String(parsed.secondName)
							: parsed.second_name
								? String(parsed.second_name)
								: null,
						teamId: Number(parsed.teamId ?? parsed.team_id ?? 0),
						position: Number(parsed.type ?? parsed.position ?? 0) as Position,
						price: Number(parsed.price ?? 0),
						startPrice: Number(parsed.startPrice ?? parsed.start_price ?? 0),
						totalPoints: Number(parsed.totalPoints ?? 0),
						selectedByPercent:
							typeof parsed.selectedByPercent === "number"
								? parsed.selectedByPercent
								: typeof parsed.selected_by_percent === "number"
									? parsed.selected_by_percent
									: null,
					});
				} catch {
					missIds.push(uniqueIds[i]);
				}
			} else {
				missIds.push(uniqueIds[i]);
			}
		}

		if (missIds.length === 0) {
			return result;
		}

		const { data, error } = await context.supabase
			.from("players")
			.select("id, code, web_name, first_name, second_name, team_id, type, price, start_price")
			.in("id", missIds);

		if (error) {
			context.logger.error({ err: error, ids: missIds }, "Failed to fetch players by ids");
			throw new Error("Failed to fetch players by ids", { cause: error });
		} else {
			result.push(...((data as DbPlayerRow[] | null)?.map(mapPlayer) ?? []));
		}

		return result;
	},

	async getPlayersFromRedis(context: GraphQLContext): Promise<Map<number, Player>> {
		try {
			const season = await getCurrentSeason(context);
			const hashKey = `Player:${season}`;
			const hash = await context.redis.hgetall(hashKey);

			if (hash && Object.keys(hash).length > 0) {
				const players = new Map<number, Player>();
				for (const [fieldKey, value] of Object.entries(hash)) {
					const parsed = JSON.parse(value) as Record<string, unknown>;
					players.set(Number(fieldKey), {
						id: Number(fieldKey),
						code: Number(parsed.code ?? 0),
						webName: String(parsed.webName ?? ""),
						firstName: parsed.firstName ? String(parsed.firstName) : null,
						secondName: parsed.secondName ? String(parsed.secondName) : null,
						teamId: Number(parsed.teamId ?? 0),
						position: Number(parsed.type ?? 0) as Position,
						price: Number(parsed.price ?? 0),
						startPrice: Number(parsed.startPrice ?? 0),
						totalPoints: 0,
						selectedByPercent: null,
					});
				}
				return players;
			}
		} catch (err) {
			context.logger.warn({ err }, "Failed to read Player hash from Redis, falling back to DB");
		}

		// Fallback to DB — do NOT write back to external hash
		const dbPlayers = await this.listPlayers(context, null, 1000, 0);
		return new Map(dbPlayers.map((p) => [p.id, p]));
	},

	async getPlayersForPicker(
		context: GraphQLContext,
		limit: number,
		cursor: number | null | undefined
	): Promise<PlayersForPickerPayload> {
		const safeLimit = clampLimit(limit);
		const safeCursor = cursor && Number.isFinite(cursor) && cursor > 0 ? cursor : null;
		const season = await getCurrentSeason(context);
		const cacheKey = gqlCacheKey(season, `players:picker:${safeLimit}:${safeCursor ?? 0}`);

		const cached = await readJsonCache(
			context,
			cacheKey,
			(value): value is PlayersForPickerPayload => {
				if (!isObject(value) || !Array.isArray(value.items)) return false;
				return value.items.every(
					(item) =>
						isObject(item) &&
						typeof item.id === "number" &&
						typeof item.webName === "string" &&
						isObject(item.team)
				);
			}
		);
		if (cached) {
			return cached;
		}

		const result = await context.supabase.rpc("get_players_for_picker", {
			p_limit: safeLimit,
			p_cursor: safeCursor,
		});

		if (result.error) {
			context.logger.error(
				{ err: result.error, limit: safeLimit, cursor: safeCursor },
				"Failed to fetch players for picker"
			);
			throw new Error("Failed to fetch players for picker");
		}

		const rows = (result.data as DbPickerRow[] | null) ?? [];
		const items = rows.map(mapPickerRow);
		const nextCursor = items.length >= safeLimit ? items[items.length - 1].id : null;
		const payload: PlayersForPickerPayload = { items, nextCursor };

		await context.redis.set(cacheKey, JSON.stringify(payload), "EX", PICKER_CACHE_TTL);
		return payload;
	},

	async listPlayers(
		context: GraphQLContext,
		filter: PlayersFilter | null | undefined,
		limit: number,
		offset: number
	): Promise<Player[]> {
		const normalizedFilter = normalizeFilter(filter);
		const safeLimit = clampLimit(limit);
		const safeOffset = Math.max(Number.isFinite(offset) ? offset : 0, 0);
		const season = await getCurrentSeason(context);
		const cacheKey = gqlCacheKey(
			season,
			`players:list:${stableStringify({
				filter: normalizedFilter ?? null,
				limit: safeLimit,
				offset: safeOffset,
			})}`
		);

		const cached = await readJsonCache(context, cacheKey, isPlayerList);
		if (cached) {
			return cached;
		}

		let query = context.supabase
			.from("players")
			.select("id, code, web_name, first_name, second_name, team_id, type, price, start_price");

		if (normalizedFilter?.position !== undefined) {
			query = query.eq("type", normalizedFilter.position);
		}
		if (normalizedFilter?.teamId !== undefined) {
			query = query.eq("team_id", normalizedFilter.teamId);
		}
		if (normalizedFilter?.minPrice !== undefined) {
			query = query.gte("price", normalizedFilter.minPrice);
		}
		if (normalizedFilter?.maxPrice !== undefined) {
			query = query.lte("price", normalizedFilter.maxPrice);
		}

		const { data, error } = await query
			.order("id", { ascending: true })
			.range(safeOffset, safeOffset + safeLimit - 1);

		if (error) {
			context.logger.error({ err: error, filter: normalizedFilter }, "Failed to fetch players");
			throw new Error("Failed to fetch players");
		}

		const players = (data as DbPlayerRow[] | null)?.map(mapPlayer) ?? [];
		await context.redis.set(cacheKey, JSON.stringify(players), "EX", PLAYER_CACHE_TTL);
		return players;
	},

	async getTeamById(context: GraphQLContext, id: number): Promise<Team | null> {
		if (!Number.isFinite(id) || id <= 0) {
			return null;
		}
		const map = await buildTeamMap(context);
		return map.get(id) ?? null;
	},

	async listTeams(context: GraphQLContext): Promise<Team[]> {
		const map = await buildTeamMap(context);
		return Array.from(map.values()).sort((a, b) => a.position - b.position);
	},

	async listTeamsFromRedis(context: GraphQLContext): Promise<Team[]> {
		const map = await buildTeamMap(context);
		return Array.from(map.values()).sort((a, b) => a.position - b.position);
	},

	async getTopTransfersInEnriched(
		context: GraphQLContext,
		eventId: number,
		limit: number
	): Promise<TopTransfersEnriched> {
		const empty: TopTransfersEnriched = { stats: [], players: {} };
		if (!Number.isFinite(eventId) || eventId <= 0) return empty;
		const safeLimit = Math.min(Math.max(limit, 1), 100);
		const season = await getCurrentSeason(context);
		const cacheKey = gqlCacheKey(season, `players:top-transfers-in:${eventId}:${safeLimit}`);

		const cached = await readJsonCache(context, cacheKey, isTopTransfersEnriched);
		if (cached) return cached;

		const rows = await fetchTopTransferRows(context, eventId, "in", safeLimit);
		const stats = rows.map((row) => ({
			playerId: row.element_id,
			eventId: row.event_id,
			transfersInEvent: row.transfers_in_event ?? 0,
			transfersOutEvent: row.transfers_out_event ?? 0,
		}));

		const playerMap = await this.getPlayersByIdsForEvent(
			context,
			stats.map((s) => s.playerId),
			eventId
		);
		const players: Record<number, Player> = Object.fromEntries(playerMap);
		const enriched: TopTransfersEnriched = { stats, players };
		await context.redis.set(cacheKey, JSON.stringify(enriched), "EX", PLAYER_CACHE_TTL);
		return enriched;
	},

	async getTopTransfersOutEnriched(
		context: GraphQLContext,
		eventId: number,
		limit: number
	): Promise<TopTransfersEnriched> {
		const empty: TopTransfersEnriched = { stats: [], players: {} };
		if (!Number.isFinite(eventId) || eventId <= 0) return empty;
		const safeLimit = Math.min(Math.max(limit, 1), 100);
		const season = await getCurrentSeason(context);
		const cacheKey = gqlCacheKey(season, `players:top-transfers-out:${eventId}:${safeLimit}`);

		const cached = await readJsonCache(context, cacheKey, isTopTransfersEnriched);
		if (cached) return cached;

		const rows = await fetchTopTransferRows(context, eventId, "out", safeLimit);
		const stats = rows.map((row) => ({
			playerId: row.element_id,
			eventId: row.event_id,
			transfersInEvent: row.transfers_in_event ?? 0,
			transfersOutEvent: row.transfers_out_event ?? 0,
		}));

		const playerMap = await this.getPlayersByIdsForEvent(
			context,
			stats.map((s) => s.playerId),
			eventId
		);
		const players: Record<number, Player> = Object.fromEntries(playerMap);
		const enriched: TopTransfersEnriched = { stats, players };
		await context.redis.set(cacheKey, JSON.stringify(enriched), "EX", PLAYER_CACHE_TTL);
		return enriched;
	},
};
