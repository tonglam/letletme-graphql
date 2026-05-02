import type { GraphQLContext } from "../../graphql/context";

const NULL_SENTINEL = "__entry-live:null__";

// Detected once at runtime; avoids 3 sequential retries on every cache miss.
type TransferTimeCol = "time" | "created_at" | "none";
let transferTimeCol: TransferTimeCol | null = null;
let transferTimeColPromise: Promise<TransferTimeCol> | null = null;

const detectTransferTimeCol = (
	context: GraphQLContext,
): Promise<TransferTimeCol> => {
	if (transferTimeCol !== null) return Promise.resolve(transferTimeCol);
	if (transferTimeColPromise) return transferTimeColPromise;

	transferTimeColPromise = (async (): Promise<TransferTimeCol> => {
		const { error: e1 } = await context.supabase
			.from("entry_event_transfers")
			.select("time")
			.limit(0);
		if (!e1) {
			transferTimeCol = "time";
			return "time";
		}
		if (
			e1.message.includes("column entry_event_transfers.time does not exist")
		) {
			const { error: e2 } = await context.supabase
				.from("entry_event_transfers")
				.select("created_at")
				.limit(0);
			if (!e2) {
				transferTimeCol = "created_at";
				return "created_at";
			}
		}
		transferTimeCol = "none";
		return "none";
	})();

	return transferTimeColPromise;
};

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
	elementOut: number;
	time: string | null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const asNumber = (value: unknown): number | null =>
	typeof value === "number" && Number.isFinite(value) ? value : null;

const asString = (value: unknown): string | null =>
	typeof value === "string" ? value : null;

const asBoolean = (value: unknown): boolean | null =>
	typeof value === "boolean" ? value : null;

const parsePick = (
	raw: unknown,
	fallback: { eventId: number; entryId: number },
): Pick | null => {
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
		asBoolean(raw.isCaptain) ??
		asBoolean(raw.is_captain) ??
		asBoolean(raw.captain) ??
		false;
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

const parsePicks = (
	raw: unknown,
	fallback: { eventId: number; entryId: number },
): Pick[] => {
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

	return raw
		.map((item) => parsePick(item, fallback))
		.filter((p): p is Pick => p !== null);
};

type DbEntryEventPickRow = Record<string, unknown>;
type DbEntryEventTransferRow = Record<string, unknown>;

interface EntryLiveRepository {
	getEntryEventPick(
		context: GraphQLContext,
		entryId: number,
		eventId: number,
	): Promise<EntryEventPick | null>;
	getEntryEventPicksByIds(
		context: GraphQLContext,
		entryIds: number[],
		eventId: number,
	): Promise<Map<number, EntryEventPick>>;
	getEntryEventTransfers(
		context: GraphQLContext,
		entryId: number,
		eventId: number,
	): Promise<EntryEventTransferRow[]>;
	getEntryEventTransfersByIds(
		context: GraphQLContext,
		entryIds: number[],
		eventId: number,
	): Promise<Map<number, EntryEventTransferRow[]>>;
	getEntryTransferHistory(
		context: GraphQLContext,
		entryId: number,
		prefetchedCacheValue?: string | null,
	): Promise<EntryEventTransferRow[]>;
}

const mapTransferRow = (
	row: DbEntryEventTransferRow,
	fallback: { entryId: number; eventId: number | null },
): EntryEventTransferRow | null => {
	const elementIn =
		asNumber(row.element_in) ??
		asNumber(row.element_in_id) ??
		asNumber(row.player_in) ??
		asNumber(row.in_element);
	const elementOut =
		asNumber(row.element_out) ??
		asNumber(row.element_out_id) ??
		asNumber(row.player_out) ??
		asNumber(row.out_element);
	const rowEventId = asNumber(row.event_id) ?? asNumber(row.event);
	const rowEntryId = asNumber(row.entry_id) ?? asNumber(row.entry);
	const eventId = rowEventId ?? fallback.eventId;
	const entryId = rowEntryId ?? fallback.entryId;

	if (!elementIn || !elementOut || !eventId || !entryId) {
		return null;
	}

	return {
		entryId,
		eventId,
		elementIn,
		elementOut,
		time: asString(row.time) ?? asString(row.created_at) ?? null,
	};
};

export const entryLiveRepository: EntryLiveRepository = {
	async getEntryEventPick(
		context: GraphQLContext,
		entryId: number,
		eventId: number,
	): Promise<EntryEventPick | null> {
		const cacheKey = `entries:picks:${entryId}:${eventId}`;
		const cached = await context.redis.get(cacheKey);
		if (cached) {
			return JSON.parse(cached) as EntryEventPick;
		}

		const { data, error } = await context.supabase
			.from("entry_event_picks")
			.select("*")
			.eq("entry_id", entryId)
			.eq("event_id", eventId)
			.limit(1);

		if (error) {
			// Graceful degradation: picks are optional for live calc.
			context.logger.error(
				{ err: error, entryId, eventId },
				"Failed to fetch entry event picks",
			);
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
		await context.redis.set(
			cacheKey,
			JSON.stringify(result),
			"EX",
			PICKS_CACHE_TTL,
		);
		return result;
	},

	async getEntryEventPicksByIds(
		context: GraphQLContext,
		entryIds: number[],
		eventId: number,
	): Promise<Map<number, EntryEventPick>> {
		const uniqueIds = Array.from(
			new Set(entryIds.filter((id) => Number.isFinite(id) && id > 0)),
		);
		if (uniqueIds.length === 0) {
			return new Map();
		}

		const PICKS_CACHE_TTL = 3600;
		const cacheKeys = uniqueIds.map((id) => `entries:picks:${id}:${eventId}`);
		const results = new Map<number, EntryEventPick>();
		const missIds: number[] = [];

		try {
			const cached = await context.redis.mget(...cacheKeys);
			for (let i = 0; i < uniqueIds.length; i++) {
				const raw = cached[i];
				if (raw) {
					results.set(uniqueIds[i], JSON.parse(raw) as EntryEventPick);
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
			.select("entry_id, event_id, chip, transfers_cost, picks")
			.in("entry_id", missIds)
			.eq("event_id", eventId);

		if (error) {
			context.logger.error(
				{ err: error, entryIds: missIds, eventId },
				"Failed to batch fetch entry event picks",
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
				`entries:picks:${rowEntryId}:${eventId}`,
				JSON.stringify(pick),
				"EX",
				PICKS_CACHE_TTL,
			);
		}

		await pipeline.exec();
		return results;
	},

	async getEntryEventTransfers(
		context: GraphQLContext,
		entryId: number,
		eventId: number,
	): Promise<EntryEventTransferRow[]> {
		const cacheKey = `entries:transfers:${entryId}:${eventId}`;
		const cached = await context.redis.get(cacheKey);
		if (cached) {
			return JSON.parse(cached) as EntryEventTransferRow[];
		}

		const timeCol = await detectTransferTimeCol(context);
		let baseQuery = context.supabase
			.from("entry_event_transfers")
			.select("*")
			.eq("entry_id", entryId)
			.eq("event_id", eventId);
		if (timeCol !== "none") {
			baseQuery = baseQuery.order(timeCol, { ascending: true });
		}
		const { data, error } = await baseQuery;

		if (error) {
			context.logger.error(
				{ err: error, entryId, eventId },
				"Failed to fetch entry event transfers",
			);
			return [];
		}

		const rows = (data as DbEntryEventTransferRow[] | null) ?? [];
		const transfers: EntryEventTransferRow[] = rows
			.map((row) => mapTransferRow(row, { entryId, eventId }))
			.filter((t): t is EntryEventTransferRow => t !== null);

		// Transfers are locked after deadline — safe to cache for hours.
		const TRANSFERS_CACHE_TTL = 3600;
		await context.redis.set(
			cacheKey,
			JSON.stringify(transfers),
			"EX",
			TRANSFERS_CACHE_TTL,
		);
		return transfers;
	},

	async getEntryEventTransfersByIds(
		context: GraphQLContext,
		entryIds: number[],
		eventId: number,
	): Promise<Map<number, EntryEventTransferRow[]>> {
		const uniqueIds = Array.from(
			new Set(entryIds.filter((id) => Number.isFinite(id) && id > 0)),
		);
		if (uniqueIds.length === 0) {
			return new Map();
		}

		const TRANSFERS_CACHE_TTL = 3600;
		const cacheKeys = uniqueIds.map(
			(id) => `entries:transfers:${id}:${eventId}`,
		);
		const results = new Map<number, EntryEventTransferRow[]>();
		const missIds: number[] = [];

		try {
			const cached = await context.redis.mget(...cacheKeys);
			for (let i = 0; i < uniqueIds.length; i++) {
				const raw = cached[i];
				if (raw) {
					results.set(uniqueIds[i], JSON.parse(raw) as EntryEventTransferRow[]);
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

		const timeCol = await detectTransferTimeCol(context);
		let batchQuery = context.supabase
			.from("entry_event_transfers")
			.select("*")
			.in("entry_id", missIds)
			.eq("event_id", eventId)
			.order("entry_id", { ascending: true });
		if (timeCol !== "none") {
			batchQuery = batchQuery.order(timeCol, { ascending: true });
		}
		const { data, error } = await batchQuery;

		if (error) {
			context.logger.error(
				{ err: error, entryIds: missIds, eventId },
				"Failed to batch fetch entry event transfers",
			);
			return results;
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

		const pipeline = context.redis.pipeline();
		for (const id of missIds) {
			const transfers = byEntry.get(id) ?? [];
			results.set(id, transfers);
			pipeline.set(
				`entries:transfers:${id}:${eventId}`,
				JSON.stringify(transfers),
				"EX",
				TRANSFERS_CACHE_TTL,
			);
		}
		await pipeline.exec();

		return results;
	},

	async getEntryTransferHistory(
		context: GraphQLContext,
		entryId: number,
		prefetchedCacheValue?: string | null,
	): Promise<EntryEventTransferRow[]> {
		if (!Number.isFinite(entryId) || entryId <= 0) {
			return [];
		}

		const cacheKey = `entries:transfers:history:${entryId}`;
		const cached =
			prefetchedCacheValue !== undefined
				? prefetchedCacheValue
				: await context.redis.get(cacheKey);
		if (cached !== null) {
			if (cached === NULL_SENTINEL) {
				return [];
			}
			return JSON.parse(cached) as EntryEventTransferRow[];
		}

		const timeCol = await detectTransferTimeCol(context);
		let historyQuery = context.supabase
			.from("entry_event_transfers")
			.select("*")
			.eq("entry_id", entryId)
			.order("event_id", { ascending: true });
		if (timeCol !== "none") {
			historyQuery = historyQuery.order(timeCol, { ascending: true });
		}
		const { data, error } = await historyQuery;

		if (error) {
			context.logger.error(
				{ err: error, entryId },
				"Failed to fetch entry transfer history",
			);
			return [];
		}

		const rows = (data as DbEntryEventTransferRow[] | null) ?? [];
		const transfers: EntryEventTransferRow[] = rows
			.map((row) => mapTransferRow(row, { entryId, eventId: null }))
			.filter((t): t is EntryEventTransferRow => t !== null);

		const TRANSFER_HISTORY_TTL = 3600;
		if (transfers.length === 0) {
			await context.redis.set(
				cacheKey,
				NULL_SENTINEL,
				"EX",
				TRANSFER_HISTORY_TTL,
			);
		} else {
			await context.redis.set(
				cacheKey,
				JSON.stringify(transfers),
				"EX",
				TRANSFER_HISTORY_TTL,
			);
		}
		return transfers;
	},
};
