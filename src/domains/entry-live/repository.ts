import type { GraphQLContext } from "../../graphql/context";
import { gqlCacheKey } from "../../infra/cache-key";
import { QUERY_CACHE_TTL_SECONDS, writeQueryCache } from "../../infra/query-cache";

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

	const element = asNumber(raw.element);
	const position = asNumber(raw.position);
	const multiplier = asNumber(raw.multiplier) ?? 1;

	const isCaptain = asBoolean(raw.is_captain) ?? false;
	const isViceCaptain = asBoolean(raw.is_vice_captain) ?? false;

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

type TransferQueryResult = { data: unknown[] | null; error: unknown };
type TransferQueryBuilder = PromiseLike<TransferQueryResult> & {
	select: (columns: string) => TransferQueryBuilder;
	eq: (column: string, value: unknown) => TransferQueryBuilder;
	in: (column: string, values: readonly number[]) => TransferQueryBuilder;
	order: (column: string, options: { ascending: boolean }) => TransferQueryBuilder;
};

async function queryTransferRows(
	context: GraphQLContext,
	configure: (query: TransferQueryBuilder) => TransferQueryBuilder,
	leadingOrderColumns: readonly string[]
): Promise<TransferQueryResult> {
	let query = context.data.read(
		"competition.entry_event_transfers"
	) as unknown as TransferQueryBuilder;
	query = configure(
		query.select(
			"entry_id, event_id, element_in_id, element_in_cost, element_out_id, element_out_cost, transfer_time"
		)
	);
	for (const column of leadingOrderColumns) {
		query = query.order(column, { ascending: true });
	}
	return query.order("transfer_time", { ascending: true });
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
		time: asString(row.transfer_time),
	};
};

export const entryLiveRepository: EntryLiveRepository = {
	async getEntryEventPick(
		context: GraphQLContext,
		entryId: number,
		eventId: number
	): Promise<EntryEventPick | null> {
		if (!Number.isSafeInteger(entryId) || entryId <= 0) return null;
		if (!Number.isSafeInteger(eventId) || eventId <= 0) return null;
		const cacheKey = gqlCacheKey(context, `entries:picks:${entryId}:${eventId}`);
		const cached = await parseCachedJson(context, cacheKey, isEntryEventPick);
		if (cached) {
			return cached;
		}

		const { data, error } = await context.data
			.read("competition.entry_event_picks")
			.select("entry_id, event_id, chip, picks, transfers_cost")
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

		const picksRaw = row.picks ?? null;
		const chip = asString(row.chip);
		const transfersCost = asNumber(row.transfers_cost) ?? 0;

		const picks = parsePicks(picksRaw, { entryId, eventId });

		const result: EntryEventPick = {
			entryId,
			eventId,
			chip,
			transfersCost,
			picks,
		};

		// Picks are locked after deadline — safe to use the historical TTL class.
		try {
			await context.redis.set(
				cacheKey,
				JSON.stringify(result),
				"EX",
				QUERY_CACHE_TTL_SECONDS.HISTORICAL
			);
		} catch (error) {
			context.logger.warn({ err: error, cacheKey }, "Failed to cache entry-live picks");
		}
		return result;
	},

	async getEntryEventPicksByIds(
		context: GraphQLContext,
		entryIds: number[],
		eventId: number
	): Promise<Map<number, EntryEventPick>> {
		if (!Number.isSafeInteger(eventId) || eventId <= 0) return new Map();
		const uniqueIds = Array.from(
			new Set(entryIds.filter((id) => Number.isSafeInteger(id) && id > 0))
		);
		if (uniqueIds.length === 0) {
			return new Map();
		}

		const cacheKeys = uniqueIds.map((id) => gqlCacheKey(context, `entries:picks:${id}:${eventId}`));
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

		const { data, error } = await context.data
			.read("competition.entry_event_picks")
			.select("entry_id, event_id, chip, picks, transfers_cost")
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

			const picksRaw = row.picks ?? null;
			const chip = asString(row.chip);
			const transfersCost = asNumber(row.transfers_cost) ?? 0;

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
				gqlCacheKey(context, `entries:picks:${rowEntryId}:${eventId}`),
				JSON.stringify(pick),
				"EX",
				QUERY_CACHE_TTL_SECONDS.HISTORICAL
			);
		}

		try {
			await pipeline.exec();
		} catch (error) {
			context.logger.warn({ err: error, eventId }, "Failed to cache entry-live picks batch");
		}
		return results;
	},

	async getEntryEventTransfers(
		context: GraphQLContext,
		entryId: number,
		eventId: number
	): Promise<EntryEventTransferRow[]> {
		if (!Number.isSafeInteger(entryId) || entryId <= 0) return [];
		if (!Number.isSafeInteger(eventId) || eventId <= 0) return [];
		const cacheKey = gqlCacheKey(context, `entries:transfers:${entryId}:${eventId}`);
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

		// Transfers are locked after deadline — safe to use the historical TTL class.
		try {
			await context.redis.set(
				cacheKey,
				JSON.stringify(transfers),
				"EX",
				QUERY_CACHE_TTL_SECONDS.HISTORICAL
			);
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
		if (!Number.isSafeInteger(eventId) || eventId <= 0) return new Map();
		const uniqueIds = Array.from(
			new Set(entryIds.filter((id) => Number.isSafeInteger(id) && id > 0))
		);
		if (uniqueIds.length === 0) {
			return new Map();
		}

		const cacheKeys = uniqueIds.map((id) =>
			gqlCacheKey(context, `entries:transfers:${id}:${eventId}`)
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

		const { data, error } = await queryTransferRows(
			context,
			(query) => query.in("entry_id", missIds).eq("event_id", eventId),
			["entry_id"]
		);

		if (error) {
			context.logger.error(
				{ err: error, entryIds: missIds, eventId },
				"Failed to batch fetch entry event transfers"
			);
			throw new EntryTransferRepositoryError("Failed to batch fetch entry event transfers", error);
		}

		const rows = (data as DbEntryEventTransferRow[] | null) ?? [];
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
					gqlCacheKey(context, `entries:transfers:${id}:${eventId}`),
					JSON.stringify(transfers),
					"EX",
					QUERY_CACHE_TTL_SECONDS.HISTORICAL
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
		if (!Number.isSafeInteger(entryId) || entryId <= 0) {
			return [];
		}

		const cacheKey = gqlCacheKey(context, `entries:transfers:history:${entryId}`);
		let cached = prefetchedCacheValue ?? null;
		if (prefetchedCacheValue === undefined) {
			try {
				cached = await context.redis.get(cacheKey);
			} catch (error) {
				context.logger.warn(
					{ err: error, cacheKey },
					"Failed to read entry transfer history cache"
				);
			}
		}
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

		await writeQueryCache(
			context,
			cacheKey,
			transfers.length === 0 ? NULL_SENTINEL : JSON.stringify(transfers),
			QUERY_CACHE_TTL_SECONDS.HISTORICAL
		);
		return transfers;
	},
};
