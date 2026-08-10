import type { GraphQLContext } from "../../graphql/context";
import { gqlCacheKey } from "../../infra/cache-key";
import { getCurrentSeason } from "../../infra/season";
import { buildTeamMap } from "../../infra/team-map";
import type { Player as InfraPlayer, Team as InfraTeam } from "../../infra/types";
import {
	getPlayerSeasonStatsByIdsForContext,
	resolvePlayerStatsContext,
} from "./season-stats-at-event";

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
	total_points?: number | null;
};

const asNullableNumber = (value: unknown): number | null => {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}
	if (typeof value === "string") {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : null;
	}
	return null;
};

const GRAPHQL_INT_MIN = -2_147_483_648;
const GRAPHQL_INT_MAX = 2_147_483_647;

const parseCachedInt = (value: unknown, fallback?: number): number | null => {
	if (value === null || value === undefined) return fallback ?? null;
	if (typeof value !== "number" && typeof value !== "string") return null;
	if (typeof value === "string" && value.trim().length === 0) return null;
	const parsed = typeof value === "string" ? Number(value.trim()) : value;
	if (!Number.isInteger(parsed) || parsed < GRAPHQL_INT_MIN || parsed > GRAPHQL_INT_MAX) {
		return null;
	}
	return parsed;
};

const parseCachedPlayer = (raw: string, id: number): Player | null => {
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!isObject(parsed)) return null;

		const code = parseCachedInt(parsed.code);
		const webName =
			typeof parsed.webName === "string"
				? parsed.webName.trim()
				: typeof parsed.web_name === "string"
					? parsed.web_name.trim()
					: "";
		const teamId = parseCachedInt(parsed.teamId ?? parsed.team_id);
		const position = parseCachedInt(parsed.type ?? parsed.position);
		const price = parseCachedInt(parsed.price, 0);
		const startPrice = parseCachedInt(parsed.startPrice ?? parsed.start_price, 0);
		const totalPoints = parseCachedInt(parsed.totalPoints ?? parsed.total_points, 0);
		const selectedRaw = parsed.selectedByPercent ?? parsed.selected_by_percent;
		const selectedByPercent = asNullableNumber(selectedRaw);
		if (
			code === null ||
			code <= 0 ||
			webName.length === 0 ||
			teamId === null ||
			teamId <= 0 ||
			position === null ||
			position < Position.GOALKEEPER ||
			position > Position.FORWARD ||
			price === null ||
			startPrice === null ||
			totalPoints === null ||
			(selectedRaw !== undefined && selectedRaw !== null && selectedByPercent === null)
		) {
			return null;
		}

		return {
			id,
			code,
			webName,
			firstName:
				typeof parsed.firstName === "string"
					? parsed.firstName
					: typeof parsed.first_name === "string"
						? parsed.first_name
						: null,
			secondName:
				typeof parsed.secondName === "string"
					? parsed.secondName
					: typeof parsed.second_name === "string"
						? parsed.second_name
						: null,
			teamId,
			position: position as Position,
			price,
			startPrice,
			totalPoints,
			selectedByPercent,
		};
	} catch {
		return null;
	}
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
	totalPoints: row.total_points ?? 0,
	selectedByPercent: null,
});

const enrichCurrentSeasonTotals = async (
	context: GraphQLContext,
	players: Player[]
): Promise<Player[]> => {
	if (players.length === 0) return players;
	try {
		const statsContext = await resolvePlayerStatsContext(context);
		const stats = await getPlayerSeasonStatsByIdsForContext(
			context,
			players.map((player) => player.id),
			statsContext
		);
		return players.map((player) => {
			const current = stats.get(player.id);
			return current
				? {
						...player,
						totalPoints: current.totalPoints ?? player.totalPoints,
						selectedByPercent: current.selectedByPercent ?? player.selectedByPercent,
					}
				: player;
		});
	} catch (error) {
		context.logger.warn({ err: error }, "Failed to enrich players with current season totals");
		return players;
	}
};

const evictMalformedCache = async (context: GraphQLContext, key: string): Promise<void> => {
	try {
		await context.redis.del(key);
	} catch (error) {
		context.logger.warn({ err: error, key }, "Failed to evict malformed player cache");
	}
};

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

type PlayerEventStatsOverlay = {
	totalPoints: number | null;
	selectedByPercent: number | null;
};

const isPlayerEventStatsOverlay = (value: unknown): value is PlayerEventStatsOverlay =>
	isObject(value) &&
	(value.totalPoints === null || typeof value.totalPoints === "number") &&
	(value.selectedByPercent === null || typeof value.selectedByPercent === "number");

const applyPlayerEventStats = (player: Player, stats: PlayerEventStatsOverlay): Player => ({
	...player,
	totalPoints: stats.totalPoints ?? player.totalPoints,
	selectedByPercent: stats.selectedByPercent ?? player.selectedByPercent,
});

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
const PICKER_SCAN_BATCH_SIZE = 100;
const MARKET_OWNERSHIP_STALE_AFTER_MS = 36 * 60 * 60 * 1000;

// Keep the GraphQL cursor as an Int for existing clients. New cursors are
// negative, versioned offsets tied to the active sort; positive cursors retain
// the legacy player-ID threshold semantics during a rolling deployment.
const PICKER_CURSOR_VERSION = 2;
const PICKER_CURSOR_VERSION_STRIDE = 200_000_000;
const PICKER_CURSOR_SORT_STRIDE = 20_000_000;
const PICKER_CURSOR_LEGACY_STRIDE = 4_096;
const PICKER_CURSOR_OFFSET_STRIDE = 4_096;
const PICKER_SORT_CODES: Record<PlayerPickerSort, number> = {
	NAME_ASC: 1,
	TOTAL_POINTS_DESC: 2,
	FORM_DESC: 3,
	PRICE_ASC: 4,
	PRICE_DESC: 5,
	OWNERSHIP_DESC: 6,
};

const encodePickerCursor = (
	sort: PlayerPickerSort,
	offset: number,
	legacyId: number | null
): number =>
	-(
		PICKER_CURSOR_VERSION * PICKER_CURSOR_VERSION_STRIDE +
		PICKER_SORT_CODES[sort] * PICKER_CURSOR_SORT_STRIDE +
		(legacyId ?? 0) * PICKER_CURSOR_LEGACY_STRIDE +
		offset +
		1
	);

const decodePickerCursor = (
	cursor: number | null,
	sort: PlayerPickerSort
): { offset: number; legacyId: number | null } => {
	if (cursor === null || cursor === 0) return { offset: 0, legacyId: null };
	if (cursor > 0) return { offset: 0, legacyId: cursor };
	const encoded = -cursor - 1;
	const version = Math.floor(encoded / PICKER_CURSOR_VERSION_STRIDE);
	if (version === PICKER_CURSOR_VERSION) {
		const remainder = encoded % PICKER_CURSOR_VERSION_STRIDE;
		const sortCode = Math.floor(remainder / PICKER_CURSOR_SORT_STRIDE);
		const payload = remainder % PICKER_CURSOR_SORT_STRIDE;
		const legacyId = Math.floor(payload / PICKER_CURSOR_LEGACY_STRIDE);
		const offset = payload % PICKER_CURSOR_OFFSET_STRIDE;
		if (
			sortCode !== PICKER_SORT_CODES[sort] ||
			legacyId < 0 ||
			offset < 0 ||
			(legacyId > 0 && !Number.isSafeInteger(legacyId))
		) {
			return { offset: 0, legacyId: null };
		}
		return { offset, legacyId: legacyId === 0 ? null : legacyId };
	}
	// Accept the previous offset-only cursor format during a rolling deployment.
	const legacyVersion = Math.floor(encoded / 1_000_000);
	const legacySortCode = Math.floor((encoded % 1_000_000) / 100_000);
	const legacyOffset = encoded % 100_000;
	if (legacyVersion !== 1 || legacySortCode !== PICKER_SORT_CODES[sort] || legacyOffset < 0) {
		return { offset: 0, legacyId: null };
	}
	return { offset: legacyOffset, legacyId: null };
};

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
	price: number;
	selectedByPercent: number | null;
	totalPoints: number | null;
	form: number | null;
};

export type PlayersForPickerPayload = {
	items: PlayerPickerItem[];
	nextCursor: number | null;
};

export type PlayerPickerSort =
	"NAME_ASC" | "TOTAL_POINTS_DESC" | "FORM_DESC" | "PRICE_ASC" | "PRICE_DESC" | "OWNERSHIP_DESC";

type DbPickerRow = {
	id: number;
	web_name: string;
	element_type: number;
	team_id: number;
	team_name: string;
	team_short_name: string;
};

type MarketOwnershipRow = {
	element_id: number;
	selected_by_percent: number | string | null;
	captured_at: string | Date | null;
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
	price: 0,
	selectedByPercent: null,
	totalPoints: null,
	form: null,
});

const getLatestMarketOwnershipByIds = async (
	context: GraphQLContext,
	ids: number[]
): Promise<Map<number, number>> => {
	if (ids.length === 0) return new Map();
	try {
		const latestResult = await context.supabase
			.from("player_market_snapshots")
			.select("snapshot_date, captured_at")
			.order("snapshot_date", { ascending: false })
			.order("captured_at", { ascending: false })
			.limit(1);
		if (latestResult.error) {
			context.logger.warn(
				{ err: latestResult.error },
				"Failed to load latest market snapshot date for player picker"
			);
			return new Map();
		}
		const latestSnapshot = latestResult.data?.[0] as
			{ snapshot_date?: string; captured_at?: string | null } | undefined;
		const snapshotDate = latestSnapshot?.snapshot_date;
		if (!snapshotDate) return new Map();
		const capturedAt = latestSnapshot?.captured_at;
		if (
			!capturedAt ||
			!Number.isFinite(Date.parse(capturedAt)) ||
			Date.now() - Date.parse(capturedAt) > MARKET_OWNERSHIP_STALE_AFTER_MS
		) {
			return new Map();
		}

		const ownershipResult = await context.supabase
			.from("player_market_snapshots")
			.select("element_id, selected_by_percent, captured_at")
			.eq("snapshot_date", snapshotDate)
			.in("element_id", ids)
			.order("captured_at", { ascending: false, nullsFirst: false });
		if (ownershipResult.error) {
			context.logger.warn(
				{ err: ownershipResult.error, snapshotDate },
				"Failed to load market ownership for player picker"
			);
			return new Map();
		}

		const ownershipById = new Map<number, number>();
		for (const row of (ownershipResult.data as MarketOwnershipRow[] | null) ?? []) {
			const value = asNullableNumber(row.selected_by_percent);
			if (value !== null && !ownershipById.has(row.element_id)) {
				ownershipById.set(row.element_id, value);
			}
		}
		return ownershipById;
	} catch (error) {
		context.logger.warn({ err: error }, "Failed to load market ownership for player picker");
		return new Map();
	}
};

const enrichPickerItems = async (
	context: GraphQLContext,
	rows: DbPickerRow[],
	statsContext: Awaited<ReturnType<typeof resolvePlayerStatsContext>>,
	teams?: Map<number, InfraTeam>
): Promise<PlayerPickerItem[]> => {
	const items = rows.map(mapPickerRow);
	if (items.length === 0) return items;

	const ids = items.map((item) => item.id);
	const [basePlayers, statsById, marketOwnershipById] = await Promise.all([
		playersRepository.getPlayersByIds(context, ids),
		getPlayerSeasonStatsByIdsForContext(context, ids, statsContext),
		getLatestMarketOwnershipByIds(context, ids),
	]);
	const baseById = new Map(basePlayers.map((player) => [player.id, player]));

	return items.map((item) => {
		const base = baseById.get(item.id);
		const stats = statsById.get(item.id);
		// Update team from current Player hash when it differs from the DB row.
		let team = item.team;
		if (base && teams && base.teamId !== item.team.id) {
			const current = teams.get(base.teamId);
			if (current) {
				team = {
					id: current.id,
					name: current.name,
					shortName: current.shortName,
				};
			}
		}
		return {
			...item,
			team,
			price: base?.price ?? item.price,
			selectedByPercent:
				marketOwnershipById.get(item.id) ??
				base?.selectedByPercent ??
				stats?.selectedByPercent ??
				item.selectedByPercent,
			totalPoints: stats?.available ? stats.totalPoints : null,
			form: stats?.available ? stats.form : null,
		};
	});
};

const matchesPickerFilter = (
	item: PlayerPickerItem,
	filter: PlayersFilter | undefined
): boolean => {
	if (!filter) return true;
	if (
		filter.position !== undefined &&
		filter.position !== null &&
		item.position !== filter.position
	)
		return false;
	if (filter.teamId !== undefined && filter.teamId !== null && item.team.id !== filter.teamId)
		return false;
	if (filter.minPrice !== undefined && filter.minPrice !== null && item.price < filter.minPrice)
		return false;
	if (filter.maxPrice !== undefined && filter.maxPrice !== null && item.price > filter.maxPrice)
		return false;
	return true;
};

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
		cursor: number | null | undefined,
		search?: string | null,
		filter?: PlayersFilter | null,
		sort?: PlayerPickerSort
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

// Only event-stat overlays are cached. Base players contain mutable prices and
// must always come from Player:{season} or PostgreSQL.
const PLAYER_EVENT_STATS_CACHE_TTL = 3600;

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

	return ((data as RawTransferRow[] | null) ?? []).filter((row) =>
		direction === "in" ? (row.transfers_in_event ?? 0) > 0 : (row.transfers_out_event ?? 0) > 0
	);
};

export const playersRepository: PlayersRepository = {
	async getPlayerById(context: GraphQLContext, id: number): Promise<Player | null> {
		const season = await getCurrentSeason(context);

		// Try externally-managed Player:{season} hash before hitting Supabase
		let hashRaw: string | null = null;
		try {
			hashRaw = await context.redis.hget(`Player:${season}`, String(id));
		} catch (error) {
			context.logger.warn({ err: error, season, id }, "Failed to read Player hash");
		}
		if (hashRaw) {
			const player = parseCachedPlayer(hashRaw, id);
			if (player) return player;
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
		return (await enrichCurrentSeasonTotals(context, [player]))[0] ?? player;
	},

	async getPlayerByIdForEvent(
		context: GraphQLContext,
		id: number,
		eventId: number
	): Promise<Player | null> {
		const season = await getCurrentSeason(context);
		const cacheKey = gqlCacheKey(season, `players:event-stats:v1:${id}:${eventId}`);

		const [basePlayer, cachedStats] = await Promise.all([
			this.getPlayerById(context, id),
			readJsonCache(context, cacheKey, isPlayerEventStatsOverlay),
		]);

		if (!basePlayer) {
			return null;
		}
		if (cachedStats) {
			return applyPlayerEventStats(basePlayer, cachedStats);
		}

		const statsResult = await context.supabase
			.from("player_stats")
			.select("total_points, selected_by_percent")
			.eq("event_id", eventId)
			.eq("element_id", id)
			.limit(1);

		if (statsResult.error) {
			context.logger.warn(
				{ err: statsResult.error, eventId, playerId: id },
				"Failed to fetch player event stats; returning base player"
			);
			return basePlayer;
		}

		const row = statsResult.data?.[0] as
			| {
					total_points?: number | null;
					selected_by_percent?: number | string | null;
			  }
			| undefined;

		const overlay: PlayerEventStatsOverlay = {
			totalPoints: row?.total_points ?? null,
			selectedByPercent: asNullableNumber(row?.selected_by_percent),
		};

		try {
			await context.redis.set(
				cacheKey,
				JSON.stringify(overlay),
				"EX",
				PLAYER_EVENT_STATS_CACHE_TTL
			);
		} catch (error) {
			context.logger.warn({ err: error, cacheKey }, "Failed to cache player event stats");
		}
		return applyPlayerEventStats(basePlayer, overlay);
	},

	async getPlayersByIdsForEvent(
		context: GraphQLContext,
		ids: number[],
		eventId: number
	): Promise<Map<number, Player>> {
		const uniqueIds = Array.from(new Set(ids.filter((id) => Number.isFinite(id) && id > 0)));
		if (uniqueIds.length === 0) return new Map();
		const season = await getCurrentSeason(context);
		const keys = uniqueIds.map((id) =>
			gqlCacheKey(season, `players:event-stats:v1:${id}:${eventId}`)
		);
		let rawValues: (string | null)[];
		const basePlayersPromise = this.getPlayersByIds(context, uniqueIds);
		try {
			rawValues = await context.redis.mget(...keys);
		} catch (error) {
			context.logger.warn({ err: error, keys }, "Failed to read player event-stat cache");
			rawValues = Array.from({ length: uniqueIds.length }, () => null);
		}

		const basePlayers = await basePlayersPromise;
		const baseById = new Map(basePlayers.map((player) => [player.id, player]));
		const overlays = new Map<number, PlayerEventStatsOverlay>();
		const missIds: number[] = [];
		for (let i = 0; i < uniqueIds.length; i++) {
			const raw = rawValues[i];
			if (raw) {
				try {
					const parsed: unknown = JSON.parse(raw);
					if (isPlayerEventStatsOverlay(parsed)) {
						overlays.set(uniqueIds[i], parsed);
						continue;
					}
				} catch (error) {
					context.logger.warn({ err: error, key: keys[i] }, "Malformed player event-stat cache");
				}
				await evictMalformedCache(context, keys[i]);
				missIds.push(uniqueIds[i]);
			} else {
				missIds.push(uniqueIds[i]);
			}
		}

		if (missIds.length > 0) {
			const statsResult = await context.supabase
				.from("player_stats")
				.select("element_id, total_points, selected_by_percent")
				.eq("event_id", eventId)
				.in("element_id", missIds);

			if (statsResult.error) {
				context.logger.warn(
					{ err: statsResult.error, eventId, playerIds: missIds },
					"Failed to fetch player event stats; returning fresh base players"
				);
			} else {
				type StatsRow = {
					element_id: number;
					total_points: number | null;
					selected_by_percent: number | string | null;
				};
				const statsById = new Map(
					((statsResult.data ?? []) as StatsRow[]).map((row) => [row.element_id, row])
				);
				const pipeline = context.redis.pipeline();
				for (const id of missIds) {
					const row = statsById.get(id);
					const overlay: PlayerEventStatsOverlay = {
						totalPoints: row?.total_points ?? null,
						selectedByPercent: asNullableNumber(row?.selected_by_percent),
					};
					overlays.set(id, overlay);
					pipeline.set(
						gqlCacheKey(season, `players:event-stats:v1:${id}:${eventId}`),
						JSON.stringify(overlay),
						"EX",
						PLAYER_EVENT_STATS_CACHE_TTL
					);
				}
				try {
					await pipeline.exec();
				} catch (error) {
					context.logger.warn({ err: error, eventId }, "Failed to cache player event stats");
				}
			}
		}

		const result = new Map<number, Player>();
		for (const id of uniqueIds) {
			const base = baseById.get(id);
			if (!base) continue;
			const overlay = overlays.get(id);
			result.set(id, overlay ? applyPlayerEventStats(base, overlay) : base);
		}
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
				const player = parseCachedPlayer(raw, uniqueIds[i]);
				if (player) result.push(player);
				else missIds.push(uniqueIds[i]);
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

		return missIds.length > 0 ? enrichCurrentSeasonTotals(context, result) : result;
	},

	async getPlayersFromRedis(context: GraphQLContext): Promise<Map<number, Player>> {
		try {
			const season = await getCurrentSeason(context);
			const hashKey = `Player:${season}`;
			const hash = await context.redis.hgetall(hashKey);

			if (hash && Object.keys(hash).length > 0) {
				const players = new Map<number, Player>();
				for (const [fieldKey, value] of Object.entries(hash)) {
					const id = Number(fieldKey);
					const player = parseCachedPlayer(value, id);
					if (!player) throw new Error("Malformed Player hash row");
					players.set(id, player);
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
		cursor: number | null | undefined,
		search?: string | null,
		filter?: PlayersFilter | null,
		sort: PlayerPickerSort = "TOTAL_POINTS_DESC"
	): Promise<PlayersForPickerPayload> {
		const safeLimit = clampLimit(limit);
		const safeCursorValue = cursor && Number.isSafeInteger(cursor) ? cursor : null;
		const decodedCursor = decodePickerCursor(safeCursorValue, sort);
		const safeSearch = search?.trim().slice(0, 50) || null;
		const safeFilter = normalizeFilter(filter);
		const season = await getCurrentSeason(context);
		const statsContext = await resolvePlayerStatsContext(context);
		const searchKey = safeSearch ? encodeURIComponent(safeSearch.toLowerCase()) : "all";
		const cacheKey = gqlCacheKey(
			season,
			`players:picker:v8:${statsContext.asOfEventId ?? 0}:${searchKey}:${JSON.stringify(safeFilter ?? {})}:${sort}:${safeLimit}:${safeCursorValue ?? 0}`
		);

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
						typeof item.price === "number" &&
						(item.totalPoints === null || typeof item.totalPoints === "number") &&
						(item.form === null || typeof item.form === "number") &&
						isObject(item.team)
				);
			}
		);
		if (cached) {
			return cached;
		}

		const hasPriceFilter = safeFilter?.minPrice !== undefined || safeFilter?.maxPrice !== undefined;
		// Sorting is applied after enrichment, so every source page must use the
		// same fixed batch size. Using the requested page size here would make a
		// `limit: 1` browse return the first database row rather than the first
		// globally sorted player.
		const scanLimit = PICKER_SCAN_BATCH_SIZE;
		const teams = await buildTeamMap(context);
		const fetchRows = async (pageCursor: number | null): Promise<DbPickerRow[]> => {
			if (safeSearch) {
				const result = await context.supabase.rpc("search_players_for_picker", {
					p_query: safeSearch,
					p_limit: scanLimit,
					p_cursor: pageCursor,
					p_position: safeFilter?.position ?? null,
					p_team_id: null,
					p_min_price: hasPriceFilter ? null : (safeFilter?.minPrice ?? null),
					p_max_price: hasPriceFilter ? null : (safeFilter?.maxPrice ?? null),
				});
				if (result.error) {
					context.logger.error(
						{ err: result.error, limit: safeLimit, cursor: pageCursor, search: safeSearch },
						"Failed to fetch players for picker"
					);
					throw new Error("Failed to fetch players for picker");
				}
				return (result.data as DbPickerRow[] | null) ?? [];
			}

			let query = context.supabase
				.from("players")
				.select("id, web_name, type, team_id, price")
				.order("id", { ascending: true })
				.limit(scanLimit);
			if (pageCursor !== null) query = query.gt("id", pageCursor);
			if (safeFilter?.position !== undefined) query = query.eq("type", safeFilter.position);
			if (!hasPriceFilter && safeFilter?.minPrice !== undefined) {
				query = query.gte("price", safeFilter.minPrice);
			}
			if (!hasPriceFilter && safeFilter?.maxPrice !== undefined) {
				query = query.lte("price", safeFilter.maxPrice);
			}

			const result = await query;
			if (result.error) {
				context.logger.error(
					{ err: result.error, limit: safeLimit, cursor: pageCursor, filter: safeFilter },
					"Failed to browse players for picker"
				);
				throw new Error("Failed to fetch players for picker");
			}
			return (
				(result.data ?? []) as Array<{
					id: number;
					web_name: string;
					type: number;
					team_id: number;
				}>
			).map((row) => ({
				id: row.id,
				web_name: row.web_name,
				element_type: row.type,
				team_id: row.team_id,
				team_name: teams?.get(row.team_id)?.name ?? "",
				team_short_name: teams?.get(row.team_id)?.shortName ?? "",
			}));
		};

		const rows: DbPickerRow[] = [];
		const items: PlayerPickerItem[] = [];
		// The public cursor is an offset in the globally sorted result. Always
		// scan the source from its beginning so changing sort order cannot skip
		// rows based on the old player-ID keyset cursor.
		let pageCursor: number | null = null;
		let hasMoreRows: boolean;
		for (;;) {
			const pageRows = await fetchRows(pageCursor);
			rows.push(...pageRows);
			items.push(
				...(await enrichPickerItems(context, pageRows, statsContext, teams ?? undefined)).filter(
					(item) =>
						(decodedCursor.legacyId === null || item.id > decodedCursor.legacyId) &&
						matchesPickerFilter(item, safeFilter)
				)
			);
			hasMoreRows = pageRows.length >= scanLimit;
			if (!hasMoreRows || pageRows.length === 0) {
				break;
			}
			const nextPageCursor = pageRows[pageRows.length - 1].id;
			if (pageCursor !== null && nextPageCursor <= pageCursor) {
				break;
			}
			pageCursor = nextPageCursor;
		}

		const numberDesc = (left: number | null, right: number | null): number =>
			(right ?? -Infinity) - (left ?? -Infinity);
		const sortedItems = [...items].sort((left, right) => {
			const byName = left.webName.localeCompare(right.webName);
			switch (sort) {
				case "NAME_ASC":
					return byName || left.id - right.id;
				case "FORM_DESC":
					return numberDesc(left.form, right.form) || byName || left.id - right.id;
				case "PRICE_ASC":
					return left.price - right.price || byName || left.id - right.id;
				case "PRICE_DESC":
					return right.price - left.price || byName || left.id - right.id;
				case "OWNERSHIP_DESC":
					return (
						numberDesc(left.selectedByPercent, right.selectedByPercent) ||
						byName ||
						left.id - right.id
					);
				case "TOTAL_POINTS_DESC":
				default:
					return numberDesc(left.totalPoints, right.totalPoints) || byName || left.id - right.id;
			}
		});
		const returnedItems = sortedItems.slice(decodedCursor.offset, decodedCursor.offset + safeLimit);
		const nextOffset = decodedCursor.offset + returnedItems.length;
		const nextCursor =
			nextOffset < sortedItems.length
				? encodePickerCursor(sort, nextOffset, decodedCursor.legacyId)
				: null;
		const payload: PlayersForPickerPayload = { items: returnedItems, nextCursor };

		try {
			await context.redis.set(cacheKey, JSON.stringify(payload), "EX", PICKER_CACHE_TTL);
		} catch (error) {
			context.logger.warn({ err: error, cacheKey }, "Failed to cache players-for-picker result");
		}
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
		return enrichCurrentSeasonTotals(context, players);
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

		const rows = await fetchTopTransferRows(context, eventId, "in", safeLimit);
		const stats = rows.map((row) => ({
			playerId: row.element_id,
			eventId: row.event_id,
			transfersInEvent: row.transfers_in_event ?? 0,
			transfersOutEvent: row.transfers_out_event ?? 0,
		}));
		if (stats.length === 0) return empty;

		const playerMap = await this.getPlayersByIdsForEvent(
			context,
			stats.map((s) => s.playerId),
			eventId
		);
		const players: Record<number, Player> = Object.fromEntries(playerMap);
		return { stats, players };
	},

	async getTopTransfersOutEnriched(
		context: GraphQLContext,
		eventId: number,
		limit: number
	): Promise<TopTransfersEnriched> {
		const empty: TopTransfersEnriched = { stats: [], players: {} };
		if (!Number.isFinite(eventId) || eventId <= 0) return empty;
		const safeLimit = Math.min(Math.max(limit, 1), 100);

		const rows = await fetchTopTransferRows(context, eventId, "out", safeLimit);
		const stats = rows.map((row) => ({
			playerId: row.element_id,
			eventId: row.event_id,
			transfersInEvent: row.transfers_in_event ?? 0,
			transfersOutEvent: row.transfers_out_event ?? 0,
		}));
		if (stats.length === 0) return empty;

		const playerMap = await this.getPlayersByIdsForEvent(
			context,
			stats.map((s) => s.playerId),
			eventId
		);
		const players: Record<number, Player> = Object.fromEntries(playerMap);
		return { stats, players };
	},
};
