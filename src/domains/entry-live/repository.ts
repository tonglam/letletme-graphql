import type { GraphQLContext } from "../../graphql/context";
import { gqlCacheKey } from "../../infra/cache-key";
import { isMissingPostgrestColumnError } from "../../infra/postgrest-error";
import { getCurrentSeason } from "../../infra/season";

const NULL_SENTINEL = "__entry-live:null__";

export type EntryEventPick = {
	eventId: number;
	entryId: number;
	chip: string | null;
	transfersCost: number;
	picks: Pick[];
};

export type Pick = {
	eventId: number;
	entryId: number;
	element: number;
	position: number;
	multiplier: number;
	isCaptain: boolean;
	isViceCaptain: boolean;
};

export type EntryEventTransferRow = {
	eventId: number;
	entryId: number;
	elementIn: number;
	elementInCost: number;
	elementOut: number;
	elementOutCost: number;
	time: string | null;
};

export class EntryTransferRepositoryError extends Error {
	readonly code = "ENTRY_TRANSFER_STORAGE_UNAVAILABLE";
	constructor(
		message: string,
		readonly cause?: unknown
	) {
		super(message);
		this.name = "EntryTransferRepositoryError";
	}
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const asNumber = (value: unknown): number | null => {
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	if (typeof value === "string" && value.trim().length > 0) {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : null;
	}
	return null;
};

const asString = (value: unknown): string | null => {
	if (typeof value === "string") return value;
	if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
	return null;
};

const asBoolean = (value: unknown): boolean | null => (typeof value === "boolean" ? value : null);

const deleteMalformedCache = async (context: GraphQLContext, key: string): Promise<void> => {
	try {
		await context.redis.del(key);
	} catch (error) {
		context.logger.warn({ err: error, key }, "Failed to evict malformed entry-live cache");
	}
};

const isEntryEventPick = (value: unknown): value is EntryEventPick => {
	if (!isRecord(value) || !Array.isArray(value.picks)) return false;
	return (
		asNumber(value.entryId) !== null &&
		asNumber(value.eventId) !== null &&
		value.picks.every((pick) => isRecord(pick) && asNumber(pick.element) !== null)
	);
};

const isEntryEventTransferRow = (value: unknown): value is EntryEventTransferRow => {
	if (!isRecord(value)) return false;
	return (
		asNumber(value.entryId) !== null &&
		asNumber(value.eventId) !== null &&
		asNumber(value.elementIn) !== null &&
		asNumber(value.elementInCost) !== null &&
		asNumber(value.elementOut) !== null &&
		asNumber(value.elementOutCost) !== null &&
		(value.time === null || typeof value.time === "string")
	);
};

const parseCachedJson = async <T>(
	context: GraphQLContext,
	key: string,
	validate: (value: unknown) => value is T
): Promise<T | undefined> => {
	let raw: string | null;
	try {
		raw = await context.redis.get(key);
	} catch (error) {
		context.logger.warn({ err: error, key }, "Failed to read entry-live cache");
		return undefined;
	}
	if (raw === null) return undefined;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (validate(parsed)) return parsed;
	} catch (error) {
		context.logger.warn({ err: error, key }, "Malformed entry-live cache");
	}
	await deleteMalformedCache(context, key);
	return undefined;
};

const sortTransferRows = (rows: EntryEventTransferRow[]): EntryEventTransferRow[] => {
	return rows.sort((a, b) => {
		if (a.eventId !== b.eventId) return a.eventId - b.eventId;
		if (a.time === b.time) return a.elementIn - b.elementIn || a.elementOut - b.elementOut;
		if (a.time === null) return 1;
		if (b.time === null) return -1;
		const aTime = Date.parse(a.time);
		const bTime = Date.parse(b.time);
		if (Number.isFinite(aTime) && Number.isFinite(bTime) && aTime !== bTime) return aTime - bTime;
		return a.time.localeCompare(b.time);
	});
};

const parsePick = (raw: unknown, fallback: { eventId: number; entryId: number }): Pick | null => {
	if (!isRecord(raw)) {
		return null;
	}

	const element =
		asNumber(raw.element) ??
		asNumber(raw.element_id) ??
		asNumber(raw.playerId) ??
		asNumber(raw.player_id);
	const position = asNumber(raw.position);
	const multiplier = asNumber(raw.multiplier) ?? 1;

	const isCaptain =
		asBoolean(raw.isCaptain) ?? asBoolean(raw.is_captain) ?? asBoolean(raw.captain) ?? false;
	const isViceCaptain =
		asBoolean(raw.isViceCaptain) ??
		asBoolean(raw.is_vice_captain) ??
		asBoolean(raw.viceCaptain) ??
		false;

	if (!element || !position) {
		return null;
	}

	return {
		eventId: fallback.eventId,
		entryId: fallback.entryId,
		element,
		position,
		multiplier,
		isCaptain,
		isViceCaptain,
	};
};

const parsePicks = (raw: unknown, fallback: { eventId: number; entryId: number }): Pick[] => {
	if (typeof raw === "string") {
		try {
			const parsed = JSON.parse(raw) as unknown;
			return parsePicks(parsed, fallback);
		} catch {
			return [];
		}
	}

	if (!Array.isArray(raw)) {
		return [];
	}

	return raw.map((item) => parsePick(item, fallback)).filter((p): p is Pick => p !== null);
};

type DbEntryEventPickRow = Record<string, unknown>;
type DbEntryEventTransferRow = Record<string, unknown>;

type TransferTimeColumn = "transfer_time" | "time" | "created_at" | null;
type TransferQueryResult = { data: unknown[] | null; error: unknown };
type TransferQueryBuilder = PromiseLike<TransferQueryResult> & {
	select: (columns: string) => TransferQueryBuilder;
	eq: (column: string, value: unknown) => TransferQueryBuilder;
	in: (column: string, values: readonly number[]) => TransferQueryBuilder;
	order: (column: string, options: { ascending: boolean }) => TransferQueryBuilder;
	range: (from: number, to: number) => TransferQueryBuilder;
};

const transferTimeColumnByClient = new WeakMap<object, TransferTimeColumn>();
const transferTimeColumns: readonly TransferTimeColumn[] = [
	"transfer_time",
	"time",
	"created_at",
	null,
];

async function queryTransferRows(
	context: GraphQLContext,
	configure: (query: TransferQueryBuilder) => TransferQueryBuilder,
	leadingOrderColumns: readonly string[],
	range?: { from: number; to: number }
): Promise<TransferQueryResult> {
	const clientKey = context.supabase as object;
	const hasCachedColumn = transferTimeColumnByClient.has(clientKey);
	const cachedColumn = transferTimeColumnByClient.get(clientKey);
	const candidates = hasCachedColumn
		? [cachedColumn ?? null, ...transferTimeColumns.filter((column) => column !== cachedColumn)]
		: [...transferTimeColumns];

	for (const timeColumn of candidates) {
		const projection = [
			"entry_id",
			"event_id",
			"element_in_id",
			"element_in_cost",
			"element_out_id",
			"element_out_cost",
			timeColumn,
		]
			.filter((column): column is string => column !== null)
			.join(", ");
		let query = context.supabase.from("entry_event_transfers") as unknown as TransferQueryBuilder;
		query = configure(query.select(projection));
		for (const column of leadingOrderColumns) {
			query = query.order(column, { ascending: true });
		}
		if (timeColumn) {
			query = query.order(timeColumn, { ascending: true });
		}
		if (range) {
			query = query.range(range.from, range.to);
		}
		const result = await query;
		if (!result.error) {
			transferTimeColumnByClient.set(clientKey, timeColumn);
			return result;
		}
		if (timeColumn && isMissingPostgrestColumnError(result.error, timeColumn)) {
			continue;
		}
		return result;
	}

	return { data: null, error: new Error("No supported entry transfer projection") };
}

interface EntryLiveRepository {
	getEntryEventPick(
		context: GraphQLContext,
		entryId: number,
		eventId: number
	): Promise<EntryEventPick | null>;
	getEntryEventPicksByIds(
		context: GraphQLContext,
		entryIds: number[],
		eventId: number
	): Promise<Map<number, EntryEventPick>>;
	getEntryEventTransfers(
		context: GraphQLContext,
		entryId: number,
		eventId: number
	): Promise<EntryEventTransferRow[]>;
	getEntryEventTransfersByIds(
		context: GraphQLContext,
		entryIds: number[],
		eventId: number
	): Promise<Map<number, EntryEventTransferRow[]>>;
	getEntryTransferHistory(
		context: GraphQLContext,
		entryId: number,
		prefetchedCacheValue?: string | null
	): Promise<EntryEventTransferRow[]>;
}

const mapTransferRow = (
	row: DbEntryEventTransferRow,
	fallback: { entryId: number; eventId: number | null }
): EntryEventTransferRow | null => {
	const elementIn = asNumber(row.element_in_id);
	const elementInCost = asNumber(row.element_in_cost);
	const elementOut = asNumber(row.element_out_id);
	const elementOutCost = asNumber(row.element_out_cost);
	const rowEventId = asNumber(row.event_id) ?? asNumber(row.event);
	const rowEntryId = asNumber(row.entry_id) ?? asNumber(row.entry);
	const eventId = rowEventId ?? fallback.eventId;
	const entryId = rowEntryId ?? fallback.entryId;

	if (!elementIn || !elementOut || !eventId || !entryId) {
		return null;
	}
	if (elementInCost === null || elementOutCost === null) {
		throw new EntryTransferRepositoryError(
			`Stored transfer costs are missing for entry ${entryId}, event ${eventId}`
		);
	}

	return {
		entryId,
		eventId,
		elementIn,
		elementInCost,
		elementOut,
		elementOutCost,
		time: asString(row.transfer_time ?? row.time ?? row.created_at),
	};
};

export const entryLiveRepository: EntryLiveRepository = {
	async getEntryEventPick(
		context: GraphQLContext,
		entryId: number,
		eventId: number
	): Promise<EntryEventPick | null> {
		const season = await getCurrentSeason(context);
		const cacheKey = gqlCacheKey(season, `entries:picks:${entryId}:${eventId}`);
		const cached = await parseCachedJson(context, cacheKey, isEntryEventPick);
		if (cached) {
			return cached;
		}

		const { data, error } = await context.supabase
			.from("entry_event_picks")
			.select("*")
			.eq("entry_id", entryId)
			.eq("event_id", eventId)
			.limit(1);

		if (error) {
			// Graceful degradation: picks are optional for live calc.
			context.logger.error({ err: error, entryId, eventId }, "Failed to fetch entry event picks");
			return null;
		}

		const row = data?.[0] as DbEntryEventPickRow | undefined;
		if (!row) {
			return null;
		}

		const picksRaw = row.picks ?? row.pick_list ?? row.elements ?? null;
		const chip = asString(row.chip) ?? asString(row.active_chip) ?? null;
		const transfersCost =
			asNumber(row.transfers_cost) ??
			asNumber(row.event_transfers_cost) ??
			asNumber(row.transfer_cost) ??
			0;

		const picks = parsePicks(picksRaw, { entryId, eventId });

		const result: EntryEventPick = {
			entryId,
			eventId,
			chip,
			transfersCost,
			picks,
		};

		// Picks are locked after deadline — safe to cache for hours.
		const PICKS_CACHE_TTL = 3600;
		await context.redis.set(cacheKey, JSON.stringify(result), "EX", PICKS_CACHE_TTL);
		return result;
	},

	async getEntryEventPicksByIds(
		context: GraphQLContext,
		entryIds: number[],
		eventId: number
	): Promise<Map<number, EntryEventPick>> {
		const uniqueIds = Array.from(new Set(entryIds.filter((id) => Number.isFinite(id) && id > 0)));
		if (uniqueIds.length === 0) {
			return new Map();
		}

		const PICKS_CACHE_TTL = 3600;
		const season = await getCurrentSeason(context);
		const cacheKeys = uniqueIds.map((id) => gqlCacheKey(season, `entries:picks:${id}:${eventId}`));
		const results = new Map<number, EntryEventPick>();
		const missIds: number[] = [];

		try {
			const cached = await context.redis.mget(...cacheKeys);
			for (let i = 0; i < uniqueIds.length; i++) {
				const raw = cached[i];
				if (raw) {
					try {
						const parsed: unknown = JSON.parse(raw);
						if (isEntryEventPick(parsed)) {
							results.set(uniqueIds[i], parsed);
							continue;
						}
					} catch (error) {
						context.logger.warn(
							{ err: error, key: cacheKeys[i] },
							"Malformed entry-live picks cache"
						);
					}
					await deleteMalformedCache(context, cacheKeys[i]);
					missIds.push(uniqueIds[i]);
				} else {
					missIds.push(uniqueIds[i]);
				}
			}
		} catch {
			missIds.push(...uniqueIds);
		}

		if (missIds.length === 0) {
			return results;
		}

		const { data, error } = await context.supabase
			.from("entry_event_picks")
			// Keep legacy column compatibility during rolling schema upgrades. The
			// batch mapper below intentionally accepts picks/pick_list/elements,
			// chip/active_chip, and all historical transfer-cost names.
			.select("*")
			.in("entry_id", missIds)
			.eq("event_id", eventId);

		if (error) {
			context.logger.error(
				{ err: error, entryIds: missIds, eventId },
				"Failed to batch fetch entry event picks"
			);
			return results;
		}

		const rows = (data as DbEntryEventPickRow[] | null) ?? [];
		const pipeline = context.redis.pipeline();

		for (const row of rows) {
			const rowEntryId = asNumber(row.entry_id) ?? 0;
			if (rowEntryId === 0) continue;

			const picksRaw = row.picks ?? row.pick_list ?? row.elements ?? null;
			const chip = asString(row.chip) ?? asString(row.active_chip) ?? null;
			const transfersCost =
				asNumber(row.transfers_cost) ??
				asNumber(row.event_transfers_cost) ??
				asNumber(row.transfer_cost) ??
				0;

			const picks = parsePicks(picksRaw, { entryId: rowEntryId, eventId });
			const pick: EntryEventPick = {
				entryId: rowEntryId,
				eventId,
				chip,
				transfersCost,
				picks,
			};

			results.set(rowEntryId, pick);
			pipeline.set(
				gqlCacheKey(season, `entries:picks:${rowEntryId}:${eventId}`),
				JSON.stringify(pick),
				"EX",
				PICKS_CACHE_TTL
			);
		}

		await pipeline.exec();
		return results;
	},

	async getEntryEventTransfers(
		context: GraphQLContext,
		entryId: number,
		eventId: number
	): Promise<EntryEventTransferRow[]> {
		const season = await getCurrentSeason(context);
		const cacheKey = gqlCacheKey(season, `entries:transfers:v3:${entryId}:${eventId}`);
		const cached = await context.redis.get(cacheKey);
		if (cached) {
			try {
				const parsed: unknown = JSON.parse(cached);
				if (Array.isArray(parsed) && parsed.every(isEntryEventTransferRow)) {
					return sortTransferRows(parsed);
				}
			} catch (error) {
				context.logger.warn({ err: error, key: cacheKey }, "Malformed entry-live transfer cache");
			}
			await deleteMalformedCache(context, cacheKey);
		}

		const { data, error } = await queryTransferRows(
			context,
			(query) => query.eq("entry_id", entryId).eq("event_id", eventId),
			[]
		);

		if (error) {
			context.logger.error(
				{ err: error, entryId, eventId },
				"Failed to fetch entry event transfers"
			);
			throw new EntryTransferRepositoryError("Failed to fetch entry event transfers", error);
		}

		const rows = (data as DbEntryEventTransferRow[] | null) ?? [];
		const transfers: EntryEventTransferRow[] = rows
			.map((row) => mapTransferRow(row, { entryId, eventId }))
			.filter((t): t is EntryEventTransferRow => t !== null);
		sortTransferRows(transfers);

		// Transfers are locked after deadline — safe to cache for hours.
		const TRANSFERS_CACHE_TTL = 3600;
		try {
			await context.redis.set(cacheKey, JSON.stringify(transfers), "EX", TRANSFERS_CACHE_TTL);
		} catch (error) {
			context.logger.warn({ err: error, cacheKey }, "Failed to cache entry-live transfers");
		}
		return transfers;
	},

	async getEntryEventTransfersByIds(
		context: GraphQLContext,
		entryIds: number[],
		eventId: number
	): Promise<Map<number, EntryEventTransferRow[]>> {
		const uniqueIds = Array.from(new Set(entryIds.filter((id) => Number.isFinite(id) && id > 0)));
		if (uniqueIds.length === 0) {
			return new Map();
		}

		const TRANSFERS_CACHE_TTL = 3600;
		const season = await getCurrentSeason(context);
		const cacheKeys = uniqueIds.map((id) =>
			gqlCacheKey(season, `entries:transfers:v3:${id}:${eventId}`)
		);
		const results = new Map<number, EntryEventTransferRow[]>();
		const missIds: number[] = [];

		try {
			const cached = await context.redis.mget(...cacheKeys);
			for (let i = 0; i < uniqueIds.length; i++) {
				const raw = cached[i];
				if (raw) {
					try {
						const parsed: unknown = JSON.parse(raw);
						if (Array.isArray(parsed) && parsed.every(isEntryEventTransferRow)) {
							results.set(uniqueIds[i], sortTransferRows(parsed));
							continue;
						}
					} catch (error) {
						context.logger.warn(
							{ err: error, key: cacheKeys[i] },
							"Malformed entry-live transfer cache"
						);
					}
					await deleteMalformedCache(context, cacheKeys[i]);
					missIds.push(uniqueIds[i]);
				} else {
					missIds.push(uniqueIds[i]);
				}
			}
		} catch {
			missIds.push(...uniqueIds);
		}

		if (missIds.length === 0) {
			return results;
		}

		const TRANSFER_PAGE_SIZE = 1000;
		const rows: DbEntryEventTransferRow[] = [];
		for (let from = 0; ; from += TRANSFER_PAGE_SIZE) {
			const { data, error } = await queryTransferRows(
				context,
				(query) => query.in("entry_id", missIds).eq("event_id", eventId),
				["entry_id", "element_in_id", "element_out_id"],
				{ from, to: from + TRANSFER_PAGE_SIZE - 1 }
			);
			if (error) {
				context.logger.error(
					{ err: error, entryIds: missIds, eventId },
					"Failed to batch fetch entry event transfers"
				);
				throw new EntryTransferRepositoryError(
					"Failed to batch fetch entry event transfers",
					error
				);
			}
			const page = (data as DbEntryEventTransferRow[] | null) ?? [];
			rows.push(...page);
			if (page.length < TRANSFER_PAGE_SIZE) break;
		}
		const byEntry = new Map<number, EntryEventTransferRow[]>();

		for (const row of rows) {
			const transfer = mapTransferRow(row, { entryId: 0, eventId });
			if (!transfer) continue;

			const existing = byEntry.get(transfer.entryId);
			if (existing) {
				existing.push(transfer);
			} else {
				byEntry.set(transfer.entryId, [transfer]);
			}
		}
		for (const transfers of byEntry.values()) {
			sortTransferRows(transfers);
		}

		try {
			const pipeline = context.redis.pipeline();
			for (const id of missIds) {
				const transfers = byEntry.get(id) ?? [];
				results.set(id, transfers);
				pipeline.set(
					gqlCacheKey(season, `entries:transfers:v3:${id}:${eventId}`),
					JSON.stringify(transfers),
					"EX",
					TRANSFERS_CACHE_TTL
				);
			}
			await pipeline.exec();
		} catch (error) {
			context.logger.warn({ err: error, eventId }, "Failed to cache batched entry-live transfers");
			for (const id of missIds) results.set(id, byEntry.get(id) ?? []);
		}

		return results;
	},

	async getEntryTransferHistory(
		context: GraphQLContext,
		entryId: number,
		prefetchedCacheValue?: string | null
	): Promise<EntryEventTransferRow[]> {
		if (!Number.isFinite(entryId) || entryId <= 0) {
			return [];
		}

		const season = await getCurrentSeason(context);
		const cacheKey = gqlCacheKey(season, `entries:transfers:v3:history:${entryId}`);
		const cached =
			prefetchedCacheValue !== undefined ? prefetchedCacheValue : await context.redis.get(cacheKey);
		if (cached !== null) {
			if (cached === NULL_SENTINEL) {
				return [];
			}
			try {
				const parsed: unknown = JSON.parse(cached);
				if (Array.isArray(parsed) && parsed.every(isEntryEventTransferRow)) {
					return sortTransferRows(parsed);
				}
			} catch (error) {
				context.logger.warn(
					{ err: error, key: cacheKey },
					"Malformed entry transfer history cache"
				);
			}
			if (prefetchedCacheValue === undefined) {
				await deleteMalformedCache(context, cacheKey);
			}
		}

		const { data, error } = await queryTransferRows(
			context,
			(query) => query.eq("entry_id", entryId),
			["event_id"]
		);

		if (error) {
			context.logger.error({ err: error, entryId }, "Failed to fetch entry transfer history");
			throw new EntryTransferRepositoryError("Failed to fetch entry transfer history", error);
		}

		const rows = (data as DbEntryEventTransferRow[] | null) ?? [];
		const transfers: EntryEventTransferRow[] = rows
			.map((row) => mapTransferRow(row, { entryId, eventId: null }))
			.filter((t): t is EntryEventTransferRow => t !== null);
		sortTransferRows(transfers);

		const TRANSFER_HISTORY_TTL = 3600;
		if (transfers.length === 0) {
			await context.redis.set(cacheKey, NULL_SENTINEL, "EX", TRANSFER_HISTORY_TTL);
		} else {
			await context.redis.set(cacheKey, JSON.stringify(transfers), "EX", TRANSFER_HISTORY_TTL);
		}
		return transfers;
	},
};
