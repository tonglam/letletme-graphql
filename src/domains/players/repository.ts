import { GraphQLError } from "graphql";
import type { QueryResultRow } from "pg";
import type { DataSqlContractProbe } from "../../contracts/data-sql-contract";
import type { GraphQLContext } from "../../graphql/context";
import { gqlCacheKey } from "../../infra/cache-key";
import { getCoreDataSnapshot } from "../../infra/data-snapshot";
import { QUERY_CACHE_TTL_SECONDS, writeQueryCache } from "../../infra/query-cache";
import { buildPlayerMap } from "../../infra/player-map";
import { buildTeamMap } from "../../infra/team-map";
import type { Player as InfraPlayer, Team as InfraTeam } from "../../infra/types";
import { resolvePlayerStatsContext } from "./season-stats-at-event";
import {
	createMarketPinFailure,
	getMarketSnapshotContext,
	refreshMarketSnapshotContext,
	type MarketSnapshotContext,
} from "../market/context";
import { MARKET_SNAPSHOT_PIN_EXISTS_SQL } from "../market/sql";

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

export type PlayerPickerOwnershipBand = "LE5" | "GT5_LE15" | "GT15_LE40" | "GT40";

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

const eventStatsRevision = async (
	context: GraphQLContext,
	eventId: number
): Promise<string | null> => {
	const statsContext = await resolvePlayerStatsContext(context, eventId);
	return statsContext.status === "AVAILABLE" &&
		statsContext.asOfEventId === eventId &&
		statsContext.revision !== null
		? statsContext.revision
		: null;
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
	| "AUTO"
	| "NAME_ASC"
	| "TOTAL_POINTS_DESC"
	| "FORM_DESC"
	| "PRICE_ASC"
	| "PRICE_DESC"
	| "OWNERSHIP_DESC";

// Keep the GraphQL cursor as an Int. Canonical cursors are negative values that
// bind an offset to the active sort without carrying an internal version.
const PICKER_CURSOR_SORT_STRIDE = 100_000;
const PICKER_SORT_CODES: Record<PlayerPickerSort, number> = {
	AUTO: 7,
	NAME_ASC: 1,
	TOTAL_POINTS_DESC: 2,
	FORM_DESC: 3,
	PRICE_ASC: 4,
	PRICE_DESC: 5,
	OWNERSHIP_DESC: 6,
};

const clampPickerLimit = (limit: number): number =>
	Math.min(Math.max(Number.isFinite(limit) ? Math.trunc(limit) : 20, 1), 50);

type SqlPickerRow = QueryResultRow & {
	id: number;
	web_name: string;
	element_type: number;
	team_id: number;
	team_name: string;
	team_short_name: string;
	price: number;
	selected_by_percent: number | string | null;
	total_points: number | string | null;
	form: number | string | null;
	total_count: number | string;
	market_snapshot_present?: boolean;
};

const pickerOrderSql: Record<Exclude<PlayerPickerSort, "AUTO">, string> = {
	NAME_ASC: "lower(web_name) ASC, id ASC",
	TOTAL_POINTS_DESC: "total_points DESC NULLS LAST, lower(web_name) ASC, id ASC",
	FORM_DESC: "form DESC NULLS LAST, lower(web_name) ASC, id ASC",
	PRICE_ASC: "price ASC, lower(web_name) ASC, id ASC",
	PRICE_DESC: "price DESC, lower(web_name) ASC, id ASC",
	OWNERSHIP_DESC: "selected_by_percent DESC NULLS LAST, lower(web_name) ASC, id ASC",
};

export const buildPlayerPickerSql = (sort: Exclude<PlayerPickerSort, "AUTO">): string => `
	WITH pinned_core AS MATERIALIZED (
		SELECT 1
		FROM ops.dataset_publications
		WHERE dataset = 'fpl:core'
		  AND season_id = $1
		  AND event_id IS NULL
		  AND status = 'active'
		  AND revision::text = $11
		LIMIT 1
	), latest_market AS MATERIALIZED (
		SELECT snapshot_date, captured_at
		FROM fpl.player_market_snapshots
		WHERE season_id = $1
		  AND ($12::date IS NULL OR snapshot_date = $12::date)
		  AND ($13::timestamptz IS NULL OR captured_at = $13::timestamptz)
		  AND ($12::date IS NOT NULL OR captured_at >= NOW() - INTERVAL '36 hours')
		ORDER BY snapshot_date DESC, captured_at DESC
		LIMIT 1
	), picker_rows AS MATERIALIZED (
		SELECT
			player.element_id AS id,
			player.web_name,
			player.element_type,
			player.team_id,
			team.name AS team_name,
			team.short_name AS team_short_name,
			COALESCE(market.price, player.price) AS price,
			COALESCE(market.selected_by_percent, event_stats.selected_by_percent) AS selected_by_percent,
			COALESCE(event_stats.total_points, player.total_points) AS total_points,
			event_stats.form,
			EXISTS (SELECT 1 FROM latest_market) AS market_snapshot_present
		FROM fpl.players player
		JOIN fpl.teams team
		  ON team.season_id = player.season_id AND team.team_id = player.team_id
		LEFT JOIN fpl.player_event_snapshot_publications event_stats_publication
		  ON event_stats_publication.season_id = player.season_id
		 AND event_stats_publication.event_id = $2
		 AND event_stats_publication.revision::text = $14
		LEFT JOIN fpl.player_event_snapshots event_stats
		  ON event_stats.season_id = player.season_id
		 AND event_stats.element_id = player.element_id
		 AND event_stats.event_id = $2
		 AND event_stats_publication.season_id = event_stats.season_id
		 AND event_stats_publication.event_id = event_stats.event_id
		LEFT JOIN latest_market latest ON TRUE
		LEFT JOIN fpl.player_market_snapshots market
		  ON market.season_id = player.season_id
		 AND market.element_id = player.element_id
		 AND market.snapshot_date = latest.snapshot_date
		 AND market.captured_at = latest.captured_at
		WHERE player.season_id = $1
		  AND EXISTS (SELECT 1 FROM pinned_core)
		  AND ($3::text IS NULL OR player.web_name ILIKE '%' || $3 || '%')
		  AND ($4::integer IS NULL OR player.element_type = $4)
		  AND ($5::integer IS NULL OR player.team_id = $5)
		  AND ($6::integer IS NULL OR COALESCE(market.price, player.price) >= $6)
		  AND ($7::integer IS NULL OR COALESCE(market.price, player.price) <= $7)
	), filtered AS (
		SELECT *
		FROM picker_rows
		WHERE $8::text IS NULL
		   OR ($8 = 'LE5' AND selected_by_percent <= 5)
		   OR ($8 = 'GT5_LE15' AND selected_by_percent > 5 AND selected_by_percent <= 15)
		   OR ($8 = 'GT15_LE40' AND selected_by_percent > 15 AND selected_by_percent <= 40)
		   OR ($8 = 'GT40' AND selected_by_percent > 40)
	)
	SELECT filtered.*, count(*) OVER ()::integer AS total_count
	FROM filtered
	ORDER BY ${pickerOrderSql[sort]}
	LIMIT $9 OFFSET $10
`;

export const PLAYERS_DATA_SQL_CONTRACT: readonly DataSqlContractProbe[] = [
	{
		name: "players.market-snapshot-pin",
		sql: MARKET_SNAPSHOT_PIN_EXISTS_SQL,
		values: [2026, "2026-08-10", "2026-08-10T00:00:00.000Z"],
	},
	{
		name: "players.picker",
		sql: buildPlayerPickerSql("NAME_ASC"),
		values: [
			2026,
			1,
			null,
			null,
			null,
			null,
			null,
			null,
			20,
			0,
			"7",
			"2026-08-10",
			"2026-08-10T00:00:00.000Z",
			"1",
		],
	},
];

const pickerPinRetryScopes = new WeakMap<object, number>();

const marketPinPresentForEmptyPicker = async (
	context: GraphQLContext,
	marketContext: MarketSnapshotContext
): Promise<boolean> => {
	try {
		const result = await context.database.query<{ present: boolean | string }>(
			MARKET_SNAPSHOT_PIN_EXISTS_SQL,
			[context.currentSeason.seasonId, marketContext.snapshotDate, marketContext.capturedAt]
		);
		const present = result.rows[0]?.present;
		return present === true || present === "true";
	} catch (error) {
		context.logger.warn({ err: error }, "Player picker market pin verification unavailable");
		return false;
	}
};

const mapSqlPickerRow = (row: SqlPickerRow): PlayerPickerItem => ({
	id: Number(row.id),
	webName: row.web_name,
	position: Number(row.element_type) as Position,
	team: {
		id: Number(row.team_id),
		name: row.team_name,
		shortName: row.team_short_name,
	},
	price: Number(row.price),
	selectedByPercent: asNullableNumber(row.selected_by_percent),
	totalPoints: asNullableNumber(row.total_points),
	form: asNullableNumber(row.form),
});

const encodePickerCursor = (sort: PlayerPickerSort, offset: number): number =>
	-(PICKER_SORT_CODES[sort] * PICKER_CURSOR_SORT_STRIDE + offset + 1);

const decodePickerCursor = (cursor: number | null, sort: PlayerPickerSort): { offset: number } => {
	if (cursor === null || cursor === 0) return { offset: 0 };
	if (cursor > 0) {
		throw new GraphQLError("Positive player cursors are not supported", {
			extensions: { code: "BAD_USER_INPUT" },
		});
	}
	const encoded = -cursor - 1;
	const sortCode = Math.floor(encoded / PICKER_CURSOR_SORT_STRIDE);
	const offset = encoded % PICKER_CURSOR_SORT_STRIDE;
	if (sortCode !== PICKER_SORT_CODES[sort] || offset < 0) {
		throw new GraphQLError("Player cursor does not match the requested sort", {
			extensions: { code: "BAD_USER_INPUT" },
		});
	}
	return { offset };
};

const isPinnedCoreRevisionBackedByPostgres = async (context: GraphQLContext): Promise<boolean> => {
	const revision = context.dataRevision?.match(/^core-(.+)$/)?.[1];
	if (!revision) return false;
	try {
		const result = await context.database.query<{ revision: string }>(
			`SELECT revision::text AS revision
			 FROM ops.dataset_publications
			 WHERE dataset = 'fpl:core'
			   AND season_id = $1
			   AND event_id IS NULL
			   AND status = 'active'
			 LIMIT 1`,
			[context.currentSeason.seasonId]
		);
		return result.rows[0]?.revision === revision;
	} catch (error) {
		context.logger.warn(
			{ err: error },
			"Failed to validate picker core revision against PostgreSQL"
		);
		return false;
	}
};

const pickerItemFromCore = (
	player: Awaited<ReturnType<typeof getCoreDataSnapshot>>["players"][number],
	team: InfraTeam | undefined,
	effectivePrice: number = player.price
): PlayerPickerItem | null => {
	if (!team) return null;
	return {
		id: player.id,
		webName: player.webName,
		position: player.type as Position,
		team: { id: team.id, name: team.name, shortName: team.shortName },
		price: effectivePrice,
		selectedByPercent: player.selectedByPercent,
		totalPoints: player.totalPoints,
		form: null,
	};
};

const readPinnedMarketPrices = async (
	context: GraphQLContext,
	marketContext: MarketSnapshotContext | null
): Promise<Map<number, number>> => {
	if (!marketContext) return new Map();
	try {
		const result = await context.database.query<{
			element_id: number;
			price: number | string | null;
		}>(
			`SELECT element_id, price
			 FROM fpl.player_market_snapshots
			 WHERE season_id = $1
			   AND snapshot_date = $2::date
			   AND captured_at = $3::timestamptz`,
			[context.currentSeason.seasonId, marketContext.snapshotDate, marketContext.capturedAt]
		);
		return new Map(
			result.rows.flatMap((row) => {
				const price = asNullableNumber(row.price);
				return price === null ? [] : [[row.element_id, price] as const];
			})
		);
	} catch (error) {
		context.logger.warn({ err: error }, "Player picker market prices unavailable in core fallback");
		return new Map();
	}
};

const getPlayersForPickerFromPinnedCore = async (
	context: GraphQLContext,
	limit: number,
	cursor: number | null | undefined,
	search: string | null | undefined,
	filter: PlayersFilter | null | undefined,
	sort: Exclude<PlayerPickerSort, "AUTO">,
	ownershipBand: PlayerPickerOwnershipBand | null,
	marketContext: MarketSnapshotContext | null
): Promise<PlayersForPickerPayload> => {
	const snapshot = await getCoreDataSnapshot(context);
	const teams = new Map(snapshot.teams.map((team) => [team.id, team] as const));
	const marketPrices = await readPinnedMarketPrices(context, marketContext);
	const effectivePriceFor = (player: (typeof snapshot.players)[number]): number =>
		marketPrices.get(player.id) ?? player.price;
	const safeSearch = search?.trim().slice(0, 50).toLowerCase() || null;
	const safeFilter = normalizeFilter(filter);
	const matchesBand = (ownership: number | null): boolean => {
		if (ownershipBand === null) return true;
		if (ownership === null) return false;
		if (ownershipBand === "LE5") return ownership <= 5;
		if (ownershipBand === "GT5_LE15") return ownership > 5 && ownership <= 15;
		if (ownershipBand === "GT15_LE40") return ownership > 15 && ownership <= 40;
		return ownership > 40;
	};
	const items = snapshot.players
		.filter((player) => !safeSearch || player.webName.toLowerCase().includes(safeSearch))
		.filter((player) => safeFilter?.position === undefined || player.type === safeFilter.position)
		.filter((player) => safeFilter?.teamId === undefined || player.teamId === safeFilter.teamId)
		.filter(
			(player) =>
				safeFilter?.minPrice === undefined ||
				safeFilter.minPrice === null ||
				effectivePriceFor(player) >= safeFilter.minPrice
		)
		.filter(
			(player) =>
				safeFilter?.maxPrice === undefined ||
				safeFilter.maxPrice === null ||
				effectivePriceFor(player) <= safeFilter.maxPrice
		)
		.filter((player) => matchesBand(player.selectedByPercent))
		.map((player) =>
			pickerItemFromCore(player, teams.get(player.teamId), effectivePriceFor(player))
		)
		.filter((item): item is PlayerPickerItem => item !== null);
	items.sort((left, right) => {
		const text = (value: string): string => value.toLowerCase();
		switch (sort) {
			case "NAME_ASC":
				return text(left.webName).localeCompare(text(right.webName)) || left.id - right.id;
			case "TOTAL_POINTS_DESC":
				return (
					(right.totalPoints ?? -Infinity) - (left.totalPoints ?? -Infinity) || left.id - right.id
				);
			case "FORM_DESC":
				return left.id - right.id;
			case "PRICE_ASC":
				return left.price - right.price || left.id - right.id;
			case "PRICE_DESC":
				return right.price - left.price || left.id - right.id;
			case "OWNERSHIP_DESC":
				return (
					(right.selectedByPercent ?? -Infinity) - (left.selectedByPercent ?? -Infinity) ||
					left.id - right.id
				);
		}
	});
	const decodedCursor = decodePickerCursor(
		cursor && Number.isSafeInteger(cursor) ? cursor : null,
		sort
	);
	const totalCount = items.length;
	const page = items.slice(decodedCursor.offset, decodedCursor.offset + limit);
	const nextOffset = decodedCursor.offset + page.length;
	return {
		items: page,
		nextCursor: nextOffset < totalCount ? encodePickerCursor(sort, nextOffset) : null,
		totalCount,
	};
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
		sort?: PlayerPickerSort,
		ownershipBand?: PlayerPickerOwnershipBand | null
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
// request-pinned immutable Data core publication.

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
	const revision = await eventStatsRevision(context, eventId);
	if (!revision) return [];
	const col = direction === "in" ? "transfers_in_event" : "transfers_out_event";
	const { data, error } = await context.data
		.read("fpl.player_event_snapshot_bundles")
		.select("element_id, event_id, transfers_in_event, transfers_out_event")
		.eq("event_id", eventId)
		.eq("publication_revision", revision)
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
		const [basePlayer, revision] = await Promise.all([
			this.getPlayerById(context, id),
			eventStatsRevision(context, eventId),
		]);

		if (!basePlayer) {
			return null;
		}
		if (!revision) return basePlayer;
		const cacheKey = gqlCacheKey(context, `players:event-stats:${id}:${eventId}:${revision}`);
		const cachedStats = await readJsonCache(context, cacheKey, isPlayerEventStatsOverlay);
		if (cachedStats) {
			return applyPlayerEventStats(basePlayer, cachedStats);
		}

		const statsResult = await context.data
			.read("fpl.player_event_snapshot_bundles")
			.select("total_points, selected_by_percent")
			.eq("event_id", eventId)
			.eq("element_id", id)
			.eq("publication_revision", revision)
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
		const [basePlayers, revision] = await Promise.all([
			this.getPlayersByIds(context, uniqueIds),
			eventStatsRevision(context, eventId),
		]);
		const baseById = new Map(basePlayers.map((player) => [player.id, player]));
		if (!revision) return baseById;
		const keys = uniqueIds.map((id) =>
			gqlCacheKey(context, `players:event-stats:${id}:${eventId}:${revision}`)
		);
		let rawValues: (string | null)[];
		try {
			rawValues = await context.redis.mget(...keys);
		} catch (error) {
			context.logger.warn({ err: error, keys }, "Failed to read player event-stat cache");
			rawValues = Array.from({ length: uniqueIds.length }, () => null);
		}

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
				.read("fpl.player_event_snapshot_bundles")
				.select("element_id, total_points, selected_by_percent")
				.eq("event_id", eventId)
				.eq("publication_revision", revision)
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
						gqlCacheKey(context, `players:event-stats:${id}:${eventId}:${revision}`),
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
		sort: PlayerPickerSort = "AUTO",
		ownershipBand: PlayerPickerOwnershipBand | null = null
	): Promise<PlayersForPickerPayload> {
		const safeLimit = clampPickerLimit(limit);
		const statsContext = await resolvePlayerStatsContext(context);
		const effectiveSort: Exclude<PlayerPickerSort, "AUTO"> =
			sort === "AUTO"
				? statsContext.asOfEventId === null
					? "OWNERSHIP_DESC"
					: "TOTAL_POINTS_DESC"
				: sort;
		const decodedCursor = decodePickerCursor(
			cursor && Number.isSafeInteger(cursor) ? cursor : null,
			effectiveSort
		);
		const safeSearch = search?.trim().slice(0, 50) || null;
		const safeFilter = normalizeFilter(filter);
		const searchKey = safeSearch ? encodeURIComponent(safeSearch.toLowerCase()) : "all";
		const marketContext = await getMarketSnapshotContext(context).catch((error) => {
			context.logger.warn({ err: error }, "Player picker market snapshot context unavailable");
			return null;
		});
		const cacheRevision = marketContext
			? `${context.dataRevision ?? "core-postgres"}.${marketContext.revision}.${statsContext.revision ?? "stats-unavailable"}`
			: `${context.dataRevision ?? "core-postgres"}.${statsContext.revision ?? "stats-unavailable"}`;
		const cacheKey = gqlCacheKey(
			context,
			`players:picker:v2:${statsContext.asOfEventId ?? 0}:${searchKey}:${JSON.stringify(safeFilter ?? {})}:${ownershipBand ?? "ANY"}:${sort}:${safeLimit}:${cursor && Number.isSafeInteger(cursor) ? cursor : 0}`,
			cacheRevision
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
		const pinnedCoreRevision = context.dataRevision?.match(/^core-(\d+)$/)?.[1];
		if (!pinnedCoreRevision) {
			return getPlayersForPickerFromPinnedCore(
				context,
				safeLimit,
				cursor,
				search,
				filter,
				effectiveSort,
				ownershipBand,
				marketContext
			);
		}

		const sql = buildPlayerPickerSql(effectiveSort);
		const pickerParams = [
			context.currentSeason.seasonId,
			statsContext.asOfEventId ?? 0,
			safeSearch,
			safeFilter?.position ?? null,
			safeFilter?.teamId ?? null,
			safeFilter?.minPrice ?? null,
			safeFilter?.maxPrice ?? null,
			ownershipBand,
			safeLimit,
			decodedCursor.offset,
			pinnedCoreRevision,
			marketContext?.snapshotDate ?? null,
			marketContext?.capturedAt ?? null,
			statsContext.revision,
		];
		const result = await context.database.query<SqlPickerRow>(sql, pickerParams);
		const returnedItems = result.rows.map(mapSqlPickerRow);
		const marketPinPresent =
			!marketContext ||
			(result.rows.length > 0
				? result.rows.every((row) => row.market_snapshot_present !== false)
				: await marketPinPresentForEmptyPicker(context, marketContext));
		if (marketContext && !marketPinPresent) {
			const requestScope = context.requestScope ?? context;
			const retries = pickerPinRetryScopes.get(requestScope) ?? 0;
			if (retries >= 1)
				throw createMarketPinFailure(context, "Market snapshot pin changed during picker query");
			pickerPinRetryScopes.set(requestScope, retries + 1);
			try {
				const refreshed = await refreshMarketSnapshotContext(context);
				if (!refreshed)
					throw createMarketPinFailure(context, "Market snapshot pin unavailable after retry");
				return playersRepository.getPlayersForPicker(
					context,
					limit,
					cursor,
					search,
					filter,
					sort,
					ownershipBand
				);
			} finally {
				if (retries === 0) pickerPinRetryScopes.delete(requestScope);
				else pickerPinRetryScopes.set(requestScope, retries);
			}
		}
		if (returnedItems.length === 0 && !(await isPinnedCoreRevisionBackedByPostgres(context))) {
			return getPlayersForPickerFromPinnedCore(
				context,
				safeLimit,
				cursor,
				search,
				filter,
				effectiveSort,
				ownershipBand,
				marketContext
			);
		}
		let totalCount = Number(result.rows[0]?.total_count ?? NaN);
		if (!Number.isFinite(totalCount)) {
			const countResult = await context.database.query<{ total_count: number | string }>(
				`${sql.slice(0, sql.lastIndexOf("SELECT filtered.*"))}SELECT count(*)::integer AS total_count FROM filtered`,
				[
					...pickerParams.slice(0, 8),
					null,
					null,
					pinnedCoreRevision,
					marketContext?.snapshotDate ?? null,
					marketContext?.capturedAt ?? null,
					statsContext.revision,
				]
			);
			totalCount = Number(countResult.rows[0]?.total_count ?? 0);
		}
		const nextOffset = decodedCursor.offset + returnedItems.length;
		const nextCursor =
			nextOffset < totalCount ? encodePickerCursor(effectiveSort, nextOffset) : null;
		const payload: PlayersForPickerPayload = {
			items: returnedItems,
			nextCursor,
			totalCount,
		};

		await writeQueryCache(
			context,
			cacheKey,
			JSON.stringify(payload),
			marketContext?.cacheTtlSeconds ?? QUERY_CACHE_TTL_SECONDS.REPORTING
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
