import type { QueryResultRow } from "pg";
import type { GraphQLContext } from "../../graphql/context";
import { gqlCacheKey } from "../../infra/cache-key";
import { getCoreDataSnapshot } from "../../infra/data-snapshot";
import { QUERY_CACHE_TTL_SECONDS, writeQueryCache } from "../../infra/query-cache";
import { buildPlayerMap } from "../../infra/player-map";
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

const MARKET_OWNERSHIP_STALE_AFTER_MS = 36 * 60 * 60 * 1000;

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
	totalCount: number;
};

export type PlayerPickerSort =
	"NAME_ASC" | "TOTAL_POINTS_DESC" | "FORM_DESC" | "PRICE_ASC" | "PRICE_DESC" | "OWNERSHIP_DESC";

// Keep the GraphQL cursor as an Int for existing clients. New cursors are
// negative, versioned offsets tied to the active sort; positive cursors retain
// the legacy player-ID threshold semantics during a rolling deployment.
const PICKER_CURSOR_VERSION = 1;
const PICKER_CURSOR_VERSION_STRIDE = 1_000_000;
const PICKER_CURSOR_SORT_STRIDE = 100_000;
const PICKER_SORT_CODES: Record<PlayerPickerSort, number> = {
	NAME_ASC: 1,
	TOTAL_POINTS_DESC: 2,
	FORM_DESC: 3,
	PRICE_ASC: 4,
	PRICE_DESC: 5,
	OWNERSHIP_DESC: 6,
};

const encodePickerCursor = (sort: PlayerPickerSort, offset: number): number =>
	-(
		PICKER_CURSOR_VERSION * PICKER_CURSOR_VERSION_STRIDE +
		PICKER_SORT_CODES[sort] * PICKER_CURSOR_SORT_STRIDE +
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
	const sortCode = Math.floor((encoded % PICKER_CURSOR_VERSION_STRIDE) / PICKER_CURSOR_SORT_STRIDE);
	const offset = encoded % PICKER_CURSOR_SORT_STRIDE;
	if (version !== PICKER_CURSOR_VERSION || sortCode !== PICKER_SORT_CODES[sort] || offset < 0) {
		return { offset: 0, legacyId: null };
	}
	return { offset, legacyId: null };
};

type DbPickerRow = QueryResultRow & {
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
		const latestResult = await context.data
			.read("fpl.player_market_snapshots")
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

		const ownershipResult = await context.data
			.read("fpl.player_market_snapshots")
			.select("element_id, selected_by_percent")
			.eq("snapshot_date", snapshotDate)
			.eq("captured_at", capturedAt)
			.in("element_id", ids);
		if (ownershipResult.error) {
			context.logger.warn(
				{ err: ownershipResult.error, snapshotDate },
				"Failed to load market ownership for player picker"
			);
			return new Map();
		}

		return new Map(
			((ownershipResult.data as MarketOwnershipRow[] | null) ?? []).flatMap((row) => {
				const value = asNullableNumber(row.selected_by_percent);
				return value === null ? [] : [[row.element_id, value] as const];
			})
		);
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

// Only event-stat overlays are query-cached. Base players always come from the
// request-pinned immutable Data v3 core publication.

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
	const { data, error } = await context.data
		.read("fpl.player_event_snapshots")
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
		if (!Number.isSafeInteger(id) || id <= 0) return null;
		const players = await buildPlayerMap(context, [id]);
		return (players.get(id) as Player | undefined) ?? null;
	},

	async getPlayerByIdForEvent(
		context: GraphQLContext,
		id: number,
		eventId: number
	): Promise<Player | null> {
		if (!Number.isSafeInteger(id) || id <= 0) return null;
		if (!Number.isSafeInteger(eventId) || eventId <= 0) return null;
		const cacheKey = gqlCacheKey(context, `players:event-stats:v1:${id}:${eventId}`);

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

		const statsResult = await context.data
			.read("fpl.player_event_snapshots")
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
				QUERY_CACHE_TTL_SECONDS.HISTORICAL
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
		if (!Number.isSafeInteger(eventId) || eventId <= 0) return new Map();
		const uniqueIds = Array.from(new Set(ids.filter((id) => Number.isSafeInteger(id) && id > 0)));
		if (uniqueIds.length === 0) return new Map();
		const keys = uniqueIds.map((id) =>
			gqlCacheKey(context, `players:event-stats:v1:${id}:${eventId}`)
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
			const statsResult = await context.data
				.read("fpl.player_event_snapshots")
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
						gqlCacheKey(context, `players:event-stats:v1:${id}:${eventId}`),
						JSON.stringify(overlay),
						"EX",
						QUERY_CACHE_TTL_SECONDS.HISTORICAL
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
		const uniqueIds = Array.from(new Set(ids.filter((id) => Number.isSafeInteger(id) && id > 0)));
		if (uniqueIds.length === 0) return [];
		const players = await buildPlayerMap(context, uniqueIds);
		return uniqueIds
			.map((id) => players.get(id) as Player | undefined)
			.filter((player): player is Player => player !== undefined);
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
		const decodedCursor = decodePickerCursor(
			cursor && Number.isSafeInteger(cursor) ? cursor : null,
			sort
		);
		const safeSearch = search?.trim().slice(0, 50) || null;
		const safeFilter = normalizeFilter(filter);
		const statsContext = await resolvePlayerStatsContext(context);
		const searchKey = safeSearch ? encodeURIComponent(safeSearch.toLowerCase()) : "all";
		const cacheKey = gqlCacheKey(
			context,
			`players:picker:v9:${statsContext.asOfEventId ?? 0}:${searchKey}:${JSON.stringify(safeFilter ?? {})}:${sort}:${safeLimit}:${cursor && Number.isSafeInteger(cursor) ? cursor : 0}`
		);

		const cached = await readJsonCache(
			context,
			cacheKey,
			(value): value is PlayersForPickerPayload => {
				if (
					!isObject(value) ||
					!Array.isArray(value.items) ||
					!Number.isSafeInteger(value.totalCount) ||
					(value.totalCount as number) < value.items.length
				) {
					return false;
				}
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

		const [snapshot, teams] = await Promise.all([
			getCoreDataSnapshot(context),
			buildTeamMap(context),
		]);
		const candidates = snapshot.players
			.filter((player) => decodedCursor.legacyId === null || player.id > decodedCursor.legacyId)
			.filter(
				(player) => !safeSearch || player.webName.toLowerCase().includes(safeSearch.toLowerCase())
			)
			.filter((player) => safeFilter?.position === undefined || player.type === safeFilter.position)
			.filter((player) => safeFilter?.teamId === undefined || player.teamId === safeFilter.teamId)
			.filter(
				(player) =>
					safeFilter?.minPrice === undefined ||
					safeFilter.minPrice === null ||
					player.price >= safeFilter.minPrice
			)
			.filter(
				(player) =>
					safeFilter?.maxPrice === undefined ||
					safeFilter.maxPrice === null ||
					player.price <= safeFilter.maxPrice
			);
		const allRows: DbPickerRow[] = candidates.map((player) => ({
			id: player.id,
			web_name: player.webName,
			element_type: player.type,
			team_id: player.teamId,
			team_name: teams.get(player.teamId)?.name ?? "",
			team_short_name: teams.get(player.teamId)?.shortName ?? "",
		}));
		const allItems = (await enrichPickerItems(context, allRows, statsContext, teams)).filter(
			(item) => matchesPickerFilter(item, safeFilter)
		);
		const sortNumberDesc = (left: number | null, right: number | null): number =>
			(right ?? -1) - (left ?? -1);
		const sortedItems = [...allItems].sort((left, right) => {
			switch (sort) {
				case "NAME_ASC":
					return left.webName.localeCompare(right.webName);
				case "FORM_DESC":
					return sortNumberDesc(left.form, right.form) || left.webName.localeCompare(right.webName);
				case "PRICE_ASC":
					return left.price - right.price || left.webName.localeCompare(right.webName);
				case "PRICE_DESC":
					return right.price - left.price || left.webName.localeCompare(right.webName);
				case "OWNERSHIP_DESC":
					return (
						sortNumberDesc(left.selectedByPercent, right.selectedByPercent) ||
						left.webName.localeCompare(right.webName)
					);
				case "TOTAL_POINTS_DESC":
				default:
					return (
						sortNumberDesc(left.totalPoints, right.totalPoints) ||
						left.webName.localeCompare(right.webName)
					);
			}
		});
		const returnedItems = sortedItems.slice(decodedCursor.offset, decodedCursor.offset + safeLimit);
		const nextOffset = decodedCursor.offset + returnedItems.length;
		const nextCursor =
			nextOffset < sortedItems.length ? encodePickerCursor(sort, nextOffset) : null;
		const payload: PlayersForPickerPayload = {
			items: returnedItems,
			nextCursor,
			totalCount: sortedItems.length,
		};

		await writeQueryCache(
			context,
			cacheKey,
			JSON.stringify(payload),
			QUERY_CACHE_TTL_SECONDS.REPORTING
		);
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
		const snapshot = await getCoreDataSnapshot(context);
		return snapshot.players
			.filter(
				(player) =>
					normalizedFilter?.position === undefined || player.type === normalizedFilter.position
			)
			.filter(
				(player) =>
					normalizedFilter?.teamId === undefined || player.teamId === normalizedFilter.teamId
			)
			.filter(
				(player) =>
					normalizedFilter?.minPrice === undefined ||
					normalizedFilter.minPrice === null ||
					player.price >= normalizedFilter.minPrice
			)
			.filter(
				(player) =>
					normalizedFilter?.maxPrice === undefined ||
					normalizedFilter.maxPrice === null ||
					player.price <= normalizedFilter.maxPrice
			)
			.sort((left, right) => left.id - right.id)
			.slice(safeOffset, safeOffset + safeLimit)
			.map((player) => ({ ...player, position: player.type as Position }));
	},

	async getTeamById(context: GraphQLContext, id: number): Promise<Team | null> {
		if (!Number.isSafeInteger(id) || id <= 0) {
			return null;
		}
		const map = await buildTeamMap(context);
		return map.get(id) ?? null;
	},

	async listTeams(context: GraphQLContext): Promise<Team[]> {
		const map = await buildTeamMap(context);
		return Array.from(map.values()).sort((a, b) => a.position - b.position);
	},

	async getTopTransfersInEnriched(
		context: GraphQLContext,
		eventId: number,
		limit: number
	): Promise<TopTransfersEnriched> {
		const empty: TopTransfersEnriched = { stats: [], players: {} };
		if (!Number.isSafeInteger(eventId) || eventId <= 0) return empty;
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
		if (!Number.isSafeInteger(eventId) || eventId <= 0) return empty;
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
