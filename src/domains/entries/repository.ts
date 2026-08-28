import type { GraphQLContext } from "../../graphql/context";
import type { Entry } from "../../contracts/entry";
import type { DataSqlContractProbe } from "../../contracts/data-sql-contract";
import { isPlainRecord as isRecord } from "../../contracts/guards";
import { gqlCacheKey } from "../../infra/cache-key";
import { QUERY_CACHE_TTL_SECONDS, writeQueryCache } from "../../infra/query-cache";

const NULL_SENTINEL = "__entries:null__";
// v4 requires the durable rich-publication timestamp used as final score provenance.
const ENTRY_RESULT_CACHE_VERSION = "v4";
const ENTRY_HISTORY_INFO_CACHE_VERSION = "v2";
// Entry info values must be durable database rows. Bump the namespace so a
// pre-hard-cut FPL fallback can never be interpreted as a persisted entry.
const ENTRY_INFO_CACHE_VERSION = "v2";

export type { Entry } from "../../contracts/entry";

export type EntryEventResult = {
	entryId: number;
	eventId: number;
	eventPoints: number;
	eventRank: number | null;
	overallPoints: number;
	overallRank: number;
	eventTransfers: number;
	eventTransfersCost: number;
	eventNetPoints: number;
	eventBenchPoints: number;
	eventChip: string | null;
	eventPlayedCaptain: number | null;
	eventCaptainPoints: number;
	eventPicks: unknown[];
	eventAutoSub?: unknown[];
	richSyncedAt: string;
	teamValue: number | null;
	bank: number | null;
};

export type EntryHistoryInfo = {
	season: string;
	totalPoints: number;
	overallRank: number;
};

export type EntryNameUsage = {
	entryId: number;
	currentEntryName: string;
	usedEntryNames: string[];
	usedEntryNameCount: number;
};

type DbEntryRow = {
	id: number;
	entry_name: string;
	player_name: string;
	region: string | null;
	started_event: number | null;
	overall_points: number | null;
	overall_rank: number | null;
	bank: number | null;
	team_value: number | null;
	total_transfers: number | null;
	last_event_id: number | null;
	last_overall_points: number | null;
	last_overall_rank: number | null;
	last_team_value: number | null;
	last_bank: number | null;
};

type DbEntryEventResultRow = {
	entry_id: number;
	event_id: number;
	event_points: number;
	event_rank: number | null;
	overall_points: number;
	overall_rank: number;
	event_transfers: number;
	event_transfers_cost: number;
	event_net_points: number;
	event_bench_points?: number | null;
	event_chip?: string | null;
	event_played_captain?: number | null;
	event_captain_points?: number | null;
	event_picks?: unknown;
	event_auto_sub?: unknown;
	rich_synced_at?: string | Date | null;
	team_value: number | null;
	bank: number | null;
};

type DbEntryHistoryInfoRow = {
	season: string;
	total_points: number;
	overall_rank: number;
};

type DbEntryHistoryCheckpointRow = {
	past_seasons_checked_at: string | Date | null;
	past_seasons_count: number | null;
};

type DbEntryNameUsageRow = {
	id: number;
	entry_name: string;
	used_entry_names: unknown;
};

const normalizeUsedEntryNames = (currentEntryName: string, usedEntryNames: unknown): string[] => {
	const names = Array.isArray(usedEntryNames)
		? usedEntryNames.filter((name): name is string => typeof name === "string")
		: [];
	if (!names.includes(currentEntryName)) names.push(currentEntryName);
	return [...new Set(names)];
};

const mapEntry = (row: DbEntryRow): Entry => ({
	id: row.id,
	entryName: row.entry_name,
	playerName: row.player_name,
	region: row.region,
	startedEvent: row.started_event,
	overallPoints: row.overall_points,
	overallRank: row.overall_rank,
	bank: row.bank,
	teamValue: row.team_value,
	totalTransfers: row.total_transfers,
	lastEventId: row.last_event_id,
	lastOverallPoints: row.last_overall_points,
	lastOverallRank: row.last_overall_rank,
	lastTeamValue: row.last_team_value,
	lastBank: row.last_bank,
});

const ENTRY_SELECT_FIELDS =
	"id, entry_name, player_name, region, started_event, overall_points, overall_rank, bank, team_value, total_transfers, last_event_id, last_overall_points, last_overall_rank, last_team_value, last_bank";

const normalizeRichSyncedAt = (value: string | Date | null | undefined): string | null => {
	const timestamp = value instanceof Date ? value.getTime() : Date.parse(value ?? "");
	return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
};

const mapEntryEventResult = (row: DbEntryEventResultRow): EntryEventResult | null => {
	const richSyncedAt = normalizeRichSyncedAt(row.rich_synced_at);
	if (!richSyncedAt) return null;
	return {
		entryId: row.entry_id,
		eventId: row.event_id,
		eventPoints: row.event_points,
		eventRank: row.event_rank,
		overallPoints: row.overall_points,
		overallRank: row.overall_rank,
		eventTransfers: row.event_transfers,
		eventTransfersCost: row.event_transfers_cost,
		eventNetPoints: row.event_net_points,
		eventBenchPoints: row.event_bench_points ?? 0,
		eventChip: row.event_chip ?? null,
		eventPlayedCaptain: row.event_played_captain ?? null,
		eventCaptainPoints: row.event_captain_points ?? 0,
		eventPicks: parseJsonArray(row.event_picks),
		eventAutoSub: parseJsonArray(row.event_auto_sub),
		richSyncedAt,
		teamValue: row.team_value,
		bank: row.bank,
	};
};

const parseJsonArray = (value: unknown): unknown[] => {
	if (Array.isArray(value)) {
		return value;
	}

	if (typeof value !== "string") {
		return [];
	}

	try {
		const parsed = JSON.parse(value) as unknown;
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
};

const mapEntryHistoryInfo = (row: DbEntryHistoryInfoRow): EntryHistoryInfo => ({
	season: row.season,
	totalPoints: row.total_points,
	overallRank: row.overall_rank,
});

const isNullableFiniteNumber = (value: unknown): boolean =>
	value === null || (typeof value === "number" && Number.isFinite(value));

const isEntry = (value: unknown): value is Entry => {
	if (!isRecord(value)) return false;
	return (
		typeof value.id === "number" &&
		Number.isSafeInteger(value.id) &&
		value.id > 0 &&
		typeof value.entryName === "string" &&
		typeof value.playerName === "string" &&
		(value.region === null || typeof value.region === "string") &&
		isNullableFiniteNumber(value.startedEvent) &&
		isNullableFiniteNumber(value.overallPoints) &&
		isNullableFiniteNumber(value.overallRank) &&
		isNullableFiniteNumber(value.bank) &&
		isNullableFiniteNumber(value.teamValue) &&
		isNullableFiniteNumber(value.totalTransfers) &&
		isNullableFiniteNumber(value.lastEventId) &&
		isNullableFiniteNumber(value.lastOverallPoints) &&
		isNullableFiniteNumber(value.lastOverallRank) &&
		isNullableFiniteNumber(value.lastTeamValue) &&
		isNullableFiniteNumber(value.lastBank)
	);
};

const evictMalformedCache = async (context: GraphQLContext, key: string): Promise<void> => {
	try {
		await context.redis.del(key);
	} catch (error) {
		context.logger.warn({ err: error, key }, "Failed to evict malformed entry cache");
	}
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
		context.logger.warn({ err: error, key }, "Failed to read entry cache");
		return undefined;
	}
	if (raw === null) return undefined;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (validate(parsed)) return parsed;
	} catch (error) {
		context.logger.warn({ err: error, key }, "Malformed entry cache");
	}
	await evictMalformedCache(context, key);
	return undefined;
};

const isEntryEventResult = (value: unknown): value is EntryEventResult => {
	if (!isRecord(value)) return false;
	return (
		typeof value.entryId === "number" &&
		Number.isFinite(value.entryId) &&
		typeof value.eventId === "number" &&
		Number.isFinite(value.eventId) &&
		Array.isArray(value.eventAutoSub) &&
		typeof value.richSyncedAt === "string" &&
		Number.isFinite(Date.parse(value.richSyncedAt))
	);
};

const isEntryHistoryInfo = (value: unknown): value is EntryHistoryInfo => {
	if (!isRecord(value)) return false;
	return typeof value.season === "string" && typeof value.totalPoints === "number";
};

export const SEARCH_ENTRIES_DEFAULT_LIMIT = 10;
export const SEARCH_ENTRIES_MAX_LIMIT = 20;
export const SEARCH_ENTRIES_MIN_QUERY_LENGTH = 2;
export const SEARCH_ENTRIES_MAX_QUERY_LENGTH = 50;

const ILIKE_ESCAPE_CLAUSE = "ESCAPE E'\\\\'";

export const SEARCH_ENTRIES_SQL = `
	SELECT
		entry_id AS id,
		entry_name,
		player_name,
		region,
		started_event,
		overall_points,
		overall_rank,
		bank,
		team_value,
		total_transfers,
		last_event_id,
		last_overall_points,
		last_overall_rank,
		last_team_value,
		last_bank
	FROM competition.entries
	WHERE season_id = $1
	  AND (
			entry_name ILIKE '%' || $2 || '%' ${ILIKE_ESCAPE_CLAUSE}
			OR player_name ILIKE '%' || $2 || '%' ${ILIKE_ESCAPE_CLAUSE}
	  )
	ORDER BY
		CASE
			WHEN entry_name ILIKE $2 || '%' ${ILIKE_ESCAPE_CLAUSE} THEN 0
			WHEN player_name ILIKE $2 || '%' ${ILIKE_ESCAPE_CLAUSE} THEN 1
			ELSE 2
		END,
		overall_rank ASC NULLS LAST,
		entry_id ASC
	LIMIT $3
`;

export const ENTRIES_DATA_SQL_CONTRACT: readonly DataSqlContractProbe[] = [
	{
		name: "entries.search",
		sql: SEARCH_ENTRIES_SQL,
		values: [2026, "manager", 10],
	},
];

export const escapeIlikePattern = (value: string): string =>
	value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");

const isEntryArray = (value: unknown): value is Entry[] =>
	Array.isArray(value) && value.every(isEntry);

interface EntriesRepository {
	getEntryById(context: GraphQLContext, id: number): Promise<Entry | null>;
	getEntrySnapshotById(context: GraphQLContext, id: number): Promise<Entry | null>;
	getEntriesByIds(context: GraphQLContext, ids: number[]): Promise<Map<number, Entry>>;
	getEntryNameUsage(context: GraphQLContext, entryId: number): Promise<EntryNameUsage | null>;
	searchEntries(context: GraphQLContext, query: string, limit: number): Promise<Entry[]>;
	getEntryHistory(context: GraphQLContext, entryId: number): Promise<EntryEventResult[]>;
	getEntryHistoryInfo(context: GraphQLContext, entryId: number): Promise<EntryHistoryInfo[]>;
	getEntryEventResult(
		context: GraphQLContext,
		entryId: number,
		eventId: number
	): Promise<EntryEventResult | null>;
	getEntryEventResultsByEntryIds(
		context: GraphQLContext,
		entryIds: number[],
		eventId: number
	): Promise<Map<number, EntryEventResult>>;
}

export const entriesRepository: EntriesRepository = {
	async getEntryById(context: GraphQLContext, id: number): Promise<Entry | null> {
		if (!Number.isSafeInteger(id) || id <= 0) return null;
		return (await this.getEntriesByIds(context, [id])).get(id) ?? null;
	},

	async getEntrySnapshotById(context: GraphQLContext, id: number): Promise<Entry | null> {
		if (!Number.isSafeInteger(id) || id <= 0) return null;

		const { data, error } = await context.data
			.read("competition.entries")
			.select(ENTRY_SELECT_FIELDS)
			.eq("id", id)
			.limit(1);

		if (error) {
			context.logger.error({ err: error, id }, "Failed to fetch persisted entry snapshot");
			throw new Error("Failed to fetch persisted entry snapshot");
		}

		const row = ((data as DbEntryRow[] | null) ?? [])[0];
		return row ? mapEntry(row) : null;
	},

	async getEntryNameUsage(
		context: GraphQLContext,
		entryId: number
	): Promise<EntryNameUsage | null> {
		if (!Number.isSafeInteger(entryId) || entryId <= 0) return null;

		const { data, error } = await context.data
			.read("competition.entries")
			.select("id, entry_name, used_entry_names")
			.eq("id", entryId)
			.limit(1);

		if (error) {
			context.logger.error({ err: error, entryId }, "Failed to fetch entry name usage");
			throw new Error("Failed to fetch entry name usage");
		}

		const row = ((data as DbEntryNameUsageRow[] | null) ?? [])[0];
		if (!row) return null;
		const usedEntryNames = normalizeUsedEntryNames(row.entry_name, row.used_entry_names);
		return {
			entryId: row.id,
			currentEntryName: row.entry_name,
			usedEntryNames,
			usedEntryNameCount: usedEntryNames.length,
		};
	},

	async getEntriesByIds(context: GraphQLContext, ids: number[]): Promise<Map<number, Entry>> {
		const uniqueIds = Array.from(new Set(ids.filter((id) => Number.isSafeInteger(id) && id > 0)));
		if (uniqueIds.length === 0) {
			return new Map();
		}
		const cacheKeys = uniqueIds.map((id) =>
			gqlCacheKey(context, `entries:info:${ENTRY_INFO_CACHE_VERSION}:${id}`)
		);
		const entries = new Map<number, Entry>();
		const missingIds: number[] = [];

		try {
			const values = await context.redis.mget(...cacheKeys);
			for (let index = 0; index < uniqueIds.length; index += 1) {
				const value = values[index];
				if (value === null) {
					missingIds.push(uniqueIds[index]);
					continue;
				}
				try {
					const parsed: unknown = JSON.parse(value);
					if (isEntry(parsed) && parsed.id === uniqueIds[index]) {
						entries.set(parsed.id, parsed);
						continue;
					}
				} catch (error) {
					context.logger.warn({ err: error, key: cacheKeys[index] }, "Malformed entry cache");
				}
				await evictMalformedCache(context, cacheKeys[index]);
				missingIds.push(uniqueIds[index]);
			}
		} catch (error) {
			context.logger.warn({ err: error, ids: uniqueIds }, "Failed to batch read entry caches");
			missingIds.push(...uniqueIds);
		}

		if (missingIds.length === 0) return entries;

		const { data, error } = await context.data
			.read("competition.entries")
			.select(ENTRY_SELECT_FIELDS)
			.in("id", missingIds);

		if (error) {
			context.logger.error({ err: error, ids: missingIds }, "Failed to batch fetch entries");
			throw new Error("Failed to batch fetch entries");
		}

		const rows = (data as DbEntryRow[] | null) ?? [];
		const fetched: Entry[] = [];
		for (const row of rows) {
			const entry = mapEntry(row);
			entries.set(entry.id, entry);
			fetched.push(entry);
		}
		try {
			const pipeline = context.redis.pipeline();
			for (const entry of fetched) {
				pipeline.set(
					gqlCacheKey(context, `entries:info:${ENTRY_INFO_CACHE_VERSION}:${entry.id}`),
					JSON.stringify(entry),
					"EX",
					QUERY_CACHE_TTL_SECONDS.METADATA
				);
			}
			await pipeline.exec();
		} catch (error) {
			context.logger.warn({ err: error, ids: missingIds }, "Failed to cache entries");
		}
		return entries;
	},

	async searchEntries(context: GraphQLContext, query: string, limit: number): Promise<Entry[]> {
		const pattern = escapeIlikePattern(query);
		const cacheKey = gqlCacheKey(context, `entries:search:${limit}:${pattern}`);
		const cached = await readJsonCache(context, cacheKey, isEntryArray);
		if (cached) {
			return cached;
		}

		const result = await context.database.query<DbEntryRow>(SEARCH_ENTRIES_SQL, [
			context.currentSeason.seasonId,
			pattern,
			limit,
		]);
		const entries = result.rows.map(mapEntry);
		await writeQueryCache(
			context,
			cacheKey,
			JSON.stringify(entries),
			QUERY_CACHE_TTL_SECONDS.METADATA
		);
		return entries;
	},

	async getEntryHistory(context: GraphQLContext, entryId: number): Promise<EntryEventResult[]> {
		if (!Number.isSafeInteger(entryId) || entryId <= 0) {
			return [];
		}

		const cacheKey = gqlCacheKey(
			context,
			`entries:history:${ENTRY_RESULT_CACHE_VERSION}:${entryId}`
		);
		let cached: string | null = null;
		try {
			cached = await context.redis.get(cacheKey);
		} catch (error) {
			context.logger.warn({ err: error, cacheKey }, "Failed to read entry history cache");
		}
		if (cached !== null) {
			if (cached === NULL_SENTINEL) return [];
			try {
				const parsed: unknown = JSON.parse(cached);
				if (Array.isArray(parsed) && parsed.every(isEntryEventResult)) {
					return parsed;
				}
			} catch (error) {
				context.logger.warn({ err: error, cacheKey }, "Malformed entry history cache");
			}
			await evictMalformedCache(context, cacheKey);
		}

		const { data, error } = await context.data
			.read("competition.entry_event_results")
			.select(
				"entry_id, event_id, event_points, event_rank, overall_points, overall_rank, event_transfers, event_transfers_cost, event_net_points, event_bench_points, event_chip, event_played_captain, event_captain_points, event_picks, event_auto_sub, rich_synced_at, team_value, bank"
			)
			.eq("entry_id", entryId)
			.order("event_id", { ascending: true });

		if (error) {
			context.logger.error({ err: error, entryId }, "Failed to fetch entry history");
			throw new Error("Failed to fetch entry history");
		}

		const rows = (data as DbEntryEventResultRow[] | null) ?? [];
		const hasPendingRichSync = rows.some(
			(row) => row.rich_synced_at === null || row.rich_synced_at === undefined
		);
		const history = rows
			.map(mapEntryEventResult)
			.filter((row): row is EntryEventResult => row !== null);
		// Rich synchronization advances independently of the Core revision. Do
		// not retain a partial history snapshot for an hour while the latest
		// finalized event is still being enriched.
		if (!hasPendingRichSync) {
			await writeQueryCache(
				context,
				cacheKey,
				history.length === 0 ? NULL_SENTINEL : JSON.stringify(history),
				QUERY_CACHE_TTL_SECONDS.HISTORICAL
			);
		}
		return history;
	},

	async getEntryHistoryInfo(context: GraphQLContext, entryId: number): Promise<EntryHistoryInfo[]> {
		if (!Number.isSafeInteger(entryId) || entryId <= 0) {
			return [];
		}

		const checkpointResult = await context.data
			.read("competition.entries")
			.select("past_seasons_checked_at,past_seasons_count")
			.eq("id", entryId)
			.limit(1);
		if (checkpointResult.error) {
			context.logger.error(
				{ err: checkpointResult.error, entryId },
				"Failed to fetch entry history-info checkpoint"
			);
			throw new Error("Failed to fetch entry history-info checkpoint");
		}
		const checkpoint = ((checkpointResult.data as DbEntryHistoryCheckpointRow[] | null) ?? [])[0];
		const pastSeasonsCount = checkpoint?.past_seasons_count;
		const pastSeasonsCheckedAt = checkpoint?.past_seasons_checked_at;
		if (
			pastSeasonsCheckedAt === null ||
			pastSeasonsCheckedAt === undefined ||
			pastSeasonsCount === null ||
			pastSeasonsCount === undefined ||
			!Number.isSafeInteger(pastSeasonsCount) ||
			pastSeasonsCount < 0
		) {
			return [];
		}

		// Include the successful checkpoint in the key so a new authoritative
		// history replacement cannot reuse an older payload.
		const cacheKey = gqlCacheKey(
			context,
			`entries:history-info:${ENTRY_HISTORY_INFO_CACHE_VERSION}:${entryId}:${String(
				pastSeasonsCheckedAt
			)}:${pastSeasonsCount}`
		);
		let cached: string | null = null;
		try {
			cached = await context.redis.get(cacheKey);
		} catch (error) {
			context.logger.warn({ err: error, cacheKey }, "Failed to read entry history-info cache");
		}
		if (cached !== null) {
			if (cached === NULL_SENTINEL) return [];
			try {
				const parsed: unknown = JSON.parse(cached);
				if (Array.isArray(parsed) && parsed.every(isEntryHistoryInfo)) {
					return parsed;
				}
			} catch (error) {
				context.logger.warn({ err: error, cacheKey }, "Malformed entry history-info cache");
			}
			await evictMalformedCache(context, cacheKey);
		}

		const { data, error } = await context.data
			.read("competition.entry_past_seasons")
			.select("season,total_points,overall_rank")
			.eq("entry_id", entryId)
			.order("id", { ascending: true });

		if (error) {
			context.logger.error({ err: error, entryId }, "Failed to fetch entry history info");
			throw new Error("Failed to fetch entry history info");
		}

		const historyInfo = (data as DbEntryHistoryInfoRow[] | null)?.map(mapEntryHistoryInfo) ?? [];
		if (historyInfo.length !== pastSeasonsCount) {
			// A checkpoint without its complete row set is not proof of a ready
			// result. Do not cache or expose a partial array.
			return [];
		}
		await writeQueryCache(
			context,
			cacheKey,
			historyInfo.length === 0 ? NULL_SENTINEL : JSON.stringify(historyInfo),
			QUERY_CACHE_TTL_SECONDS.HISTORICAL
		);
		return historyInfo;
	},

	async getEntryEventResult(
		context: GraphQLContext,
		entryId: number,
		eventId: number
	): Promise<EntryEventResult | null> {
		if (
			!Number.isSafeInteger(entryId) ||
			entryId <= 0 ||
			!Number.isSafeInteger(eventId) ||
			eventId <= 0
		) {
			return null;
		}

		const cacheKey = gqlCacheKey(
			context,
			`entries:event-result:${ENTRY_RESULT_CACHE_VERSION}:${entryId}:${eventId}`
		);
		const cached = await readJsonCache(context, cacheKey, isEntryEventResult);
		if (cached) {
			return cached;
		}

		const { data, error } = await context.data
			.read("competition.entry_event_results")
			.select(
				"entry_id, event_id, event_points, event_rank, overall_points, overall_rank, event_transfers, event_transfers_cost, event_net_points, event_bench_points, event_chip, event_played_captain, event_captain_points, event_picks, event_auto_sub, rich_synced_at, team_value, bank"
			)
			.eq("entry_id", entryId)
			.eq("event_id", eventId)
			.limit(1);

		if (error) {
			context.logger.error({ err: error, entryId, eventId }, "Failed to fetch entry event result");
			throw new Error("Failed to fetch entry event result");
		}

		const row = data?.[0] as DbEntryEventResultRow | undefined;
		if (!row || row.rich_synced_at === null || row.rich_synced_at === undefined) {
			return null;
		}

		const result = mapEntryEventResult(row);
		if (!result) return null;
		await writeQueryCache(
			context,
			cacheKey,
			JSON.stringify(result),
			QUERY_CACHE_TTL_SECONDS.METADATA
		);
		return result;
	},

	async getEntryEventResultsByEntryIds(
		context: GraphQLContext,
		entryIds: number[],
		eventId: number
	): Promise<Map<number, EntryEventResult>> {
		const uniqueIds = Array.from(
			new Set(entryIds.filter((id) => Number.isSafeInteger(id) && id > 0))
		);
		if (uniqueIds.length === 0 || !Number.isSafeInteger(eventId) || eventId <= 0) {
			return new Map();
		}

		const cacheKeys = uniqueIds.map((entryId) =>
			gqlCacheKey(
				context,
				`entries:event-result:${ENTRY_RESULT_CACHE_VERSION}:${entryId}:${eventId}`
			)
		);
		const results = new Map<number, EntryEventResult>();
		const missIds: number[] = [];
		try {
			const cached = await context.redis.mget(...cacheKeys);
			for (let index = 0; index < uniqueIds.length; index += 1) {
				const raw = cached[index];
				if (raw) {
					try {
						const parsed: unknown = JSON.parse(raw);
						if (
							isEntryEventResult(parsed) &&
							parsed.entryId === uniqueIds[index] &&
							parsed.eventId === eventId
						) {
							results.set(uniqueIds[index], parsed);
							continue;
						}
					} catch (error) {
						context.logger.warn(
							{ err: error, key: cacheKeys[index] },
							"Malformed batched entry event result cache"
						);
					}
					await evictMalformedCache(context, cacheKeys[index]);
				}
				missIds.push(uniqueIds[index]);
			}
		} catch (error) {
			context.logger.warn({ err: error, eventId }, "Failed to batch read entry event caches");
			missIds.push(...uniqueIds);
		}

		if (missIds.length === 0) return results;

		const { data, error } = await context.data
			.read("competition.entry_event_results")
			.select(
				"entry_id, event_id, event_points, event_rank, overall_points, overall_rank, event_transfers, event_transfers_cost, event_net_points, event_bench_points, event_chip, event_played_captain, event_captain_points, event_picks, event_auto_sub, rich_synced_at, team_value, bank"
			)
			.in("entry_id", missIds)
			.eq("event_id", eventId);

		if (error) {
			context.logger.error(
				{ err: error, entryIds: uniqueIds, eventId },
				"Failed to fetch entry event baselines"
			);
			throw new Error("Failed to fetch entry event baselines");
		}

		const pipeline = context.redis.pipeline();
		for (const row of (data as DbEntryEventResultRow[] | null) ?? []) {
			const result = mapEntryEventResult(row);
			if (!result) continue;
			results.set(result.entryId, result);
			pipeline.set(
				gqlCacheKey(
					context,
					`entries:event-result:${ENTRY_RESULT_CACHE_VERSION}:${result.entryId}:${eventId}`
				),
				JSON.stringify(result),
				"EX",
				QUERY_CACHE_TTL_SECONDS.METADATA
			);
		}
		try {
			await pipeline.exec();
		} catch (error) {
			context.logger.warn(
				{ err: error, entryIds: missIds, eventId },
				"Failed to cache entry event baselines"
			);
		}
		return results;
	},
};
