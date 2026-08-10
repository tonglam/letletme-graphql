import type { GraphQLContext } from "../../graphql/context";
import { gqlCacheKey } from "../../infra/cache-key";
import { metrics } from "../../infra/metrics";
import { getCurrentSeason } from "../../infra/season";
import { getActiveSeasonDateWindow } from "../../infra/season-window";

export type PositionEnum = "GOALKEEPER" | "DEFENDER" | "MIDFIELDER" | "FORWARD";

export type PlayerValue = {
	playerId: number;
	playerName: string;
	teamId: number;
	teamName: string;
	teamShortName: string;
	position: string;
	positionEnum: PositionEnum | null;
	price: number;
	value: number;
	lastValue: number;
	points: number;
	selectedBy: number;
	transfersIn: number;
	transfersOut: number;
	netTransfers: number;
	form: number | null;
	totalPoints: number;
	eventPoints: number | null;
};

export type PlayerValueHistoryItem = {
	playerId: number;
	changeDate: Date;
	oldValue: number;
	newValue: number;
	changeType: "RISE" | "FALL" | "UNCHANGED";
	transfersIn: number | null;
	transfersOut: number | null;
};

export type PlayerValueHistoryRepositoryItem = Omit<PlayerValueHistoryItem, "changeType">;

export type GetPlayerValueHistoryArgs = {
	playerId: number;
	fromDate?: Date;
	toDate?: Date;
};

export interface PlayerValuesRepository {
	getPlayerValues(context: GraphQLContext, changeDate: Date): Promise<PlayerValue[]>;
	getPlayerValueHistory(
		context: GraphQLContext,
		args: GetPlayerValueHistoryArgs
	): Promise<PlayerValueHistoryRepositoryItem[]>;
}

function formatDateKey(date: Date, options: { utc?: boolean } = {}): string {
	const year = options.utc ? date.getUTCFullYear() : date.getFullYear();
	const month = String((options.utc ? date.getUTCMonth() : date.getMonth()) + 1).padStart(2, "0");
	const day = String(options.utc ? date.getUTCDate() : date.getDate()).padStart(2, "0");
	return `PlayerValue:${year}${month}${day}`;
}

function getDateKey(changeDate: Date): string {
	return formatDateKey(changeDate, { utc: true });
}

function getCompactDateString(date: Date): string {
	return formatDateKey(date, { utc: true }).replace("PlayerValue:", "");
}

function getIsoDateString(date: Date): string {
	return date.toISOString().split("T")[0];
}

type DbPlayerValueRow = {
	element_id?: number;
	player_id?: number;
	element_type?: number | null;
	event_id?: number | null;
	value: number;
	last_value: number | null;
	change_date: string;
	change_type?: string | null;
};

type DbPlayerValueHistoryRow = {
	element_id: number;
	value: number;
	last_value: number | null;
	change_date: string | Date;
	change_type: string | null;
};

type DbPlayerMetadataRow = {
	id: number;
	web_name: string;
	team_id: number;
	type: number;
	price: number;
};

type DbTeamMetadataRow = {
	id: number;
	name: string;
	short_name: string;
};

type DbPlayerStatMetadataRow = {
	element_id: number;
	event_id: number;
	web_name: string;
	element_type: number;
	team_id: number;
	team_name: string;
	team_short_name: string;
	value: number;
	total_points: number | null;
	form: string | number | null;
	transfers_in_event: number | null;
	transfers_out_event: number | null;
	selected_by_percent: string | number | null;
};

const compactDatePattern = /^\d{8}$/;
const PLAYER_VALUE_HISTORY_PAGE_SIZE = 1000;

const toCompactDate = (date: string): string => date.replace(/-/g, "");

type StoredDateEncoding = "compact" | "iso";

/**
 * The legacy player-values table has existed with both YYYYMMDD and ISO date
 * storage. Detect all encodings present for this player so a publisher format
 * change mid-season does not make one half of the history invisible.
 */
async function resolveHistoryDateEncodings(
	context: GraphQLContext,
	playerId: number
): Promise<StoredDateEncoding[]> {
	try {
		const { data, error } = await context.supabase
			.from("player_values")
			.select("change_date")
			.eq("element_id", playerId)
			.range(0, PLAYER_VALUE_HISTORY_PAGE_SIZE - 1);
		if (error) {
			context.logger.warn(
				{ err: error, playerId },
				"Failed to resolve player-value history date encoding; using compact dates"
			);
			return ["compact"];
		}

		const encodings = new Set<StoredDateEncoding>();
		for (const row of data ?? []) {
			const rawDate = (row as { change_date?: unknown }).change_date;
			if (typeof rawDate === "string" && compactDatePattern.test(rawDate)) {
				encodings.add("compact");
			} else if (rawDate instanceof Date || typeof rawDate === "string") {
				encodings.add("iso");
			}
		}
		return encodings.size > 0 ? [...encodings] : ["compact"];
	} catch (error) {
		context.logger.warn(
			{ err: error, playerId },
			"Failed to resolve player-value history date encoding; using compact dates"
		);
	}
	return ["compact"];
}

function normalizePositionLabel(position: unknown): string {
	if (typeof position === "number" && Number.isInteger(position)) {
		switch (position) {
			case 1:
				return "GKP";
			case 2:
				return "DEF";
			case 3:
				return "MID";
			case 4:
				return "FWD";
		}
	}
	return typeof position === "string" ? position.trim() : "";
}

function toPositionEnum(position: unknown): PositionEnum | null {
	const normalized = normalizePositionLabel(position).toUpperCase();
	if (
		normalized === "GOALKEEPER" ||
		normalized === "GK" ||
		normalized === "GKP" ||
		normalized === "1"
	) {
		return "GOALKEEPER";
	}
	if (normalized === "DEFENDER" || normalized === "DEF" || normalized === "2") {
		return "DEFENDER";
	}
	if (normalized === "MIDFIELDER" || normalized === "MID" || normalized === "3") {
		return "MIDFIELDER";
	}
	if (
		normalized === "FORWARD" ||
		normalized === "FWD" ||
		normalized === "STRIKER" ||
		normalized === "4"
	) {
		return "FORWARD";
	}
	return null;
}

function buildTeamShortName(teamShortName: string | null | undefined, teamName: string): string {
	if (teamShortName && teamShortName.trim().length > 0) {
		return teamShortName.trim();
	}

	const words = teamName
		.split(/\s+/)
		.map((word) => word.trim())
		.filter((word) => word.length > 0);

	if (words.length === 0) {
		return "UNK";
	}
	if (words.length === 1) {
		return words[0].slice(0, 3).toUpperCase();
	}

	return words
		.slice(0, 3)
		.map((word) => word[0].toUpperCase())
		.join("");
}

function parseChangeDate(rawValue: string | Date): Date | null {
	if (rawValue instanceof Date) {
		return Number.isNaN(rawValue.getTime()) ? null : rawValue;
	}

	if (compactDatePattern.test(rawValue)) {
		const year = Number(rawValue.slice(0, 4));
		const month = Number(rawValue.slice(4, 6));
		const day = Number(rawValue.slice(6, 8));
		const parsed = new Date(Date.UTC(year, month - 1, day));
		return Number.isNaN(parsed.getTime()) ? null : parsed;
	}

	const parsed = new Date(rawValue);
	return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function toTenthsValue(value: number | null | undefined): number {
	if (typeof value !== "number" || Number.isNaN(value)) {
		return 0;
	}
	return Math.round(value);
}

function buildHistoryCacheKey(args: GetPlayerValueHistoryArgs): string {
	const from = args.fromDate ? String(args.fromDate.getTime()) : "none";
	const to = args.toDate ? String(args.toDate.getTime()) : "none";
	return `player-value-history:v3:${args.playerId}:${from}:${to}`;
}

const mapDbRowToPlayerValue = (row: DbPlayerValueRow): PlayerValue => {
	const rawId = row.element_id ?? row.player_id;
	const playerId = typeof rawId === "number" && Number.isFinite(rawId) ? rawId : 0;

	return {
		playerId,
		playerName: "",
		teamId: 0,
		teamName: "",
		teamShortName: "UNK",
		position: "",
		positionEnum: null,
		price: 0,
		value: row.value,
		lastValue: row.last_value ?? row.value,
		points: 0,
		selectedBy: 0,
		transfersIn: 0,
		transfersOut: 0,
		netTransfers: 0,
		form: null,
		totalPoints: 0,
		eventPoints: null,
	};
};

const parseNullableNumber = (value: string | number | null): number | null => {
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	if (typeof value !== "string") return null;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : null;
};

function mapHistoryRows(rows: DbPlayerValueHistoryRow[]): PlayerValueHistoryRepositoryItem[] {
	const normalizedRows = rows
		.map((row) => {
			const parsedDate = parseChangeDate(row.change_date);
			if (!parsedDate) {
				return null;
			}
			return {
				row,
				parsedDate,
			};
		})
		.filter((item): item is { row: DbPlayerValueHistoryRow; parsedDate: Date } => item !== null);

	const history: PlayerValueHistoryRepositoryItem[] = [];

	for (let index = 0; index < normalizedRows.length; index += 1) {
		const current = normalizedRows[index];
		const previous = normalizedRows[index + 1];
		const fallbackOldValue = current.row.last_value ?? previous?.row.value ?? current.row.value;

		history.push({
			playerId: current.row.element_id,
			changeDate: current.parsedDate,
			oldValue: toTenthsValue(fallbackOldValue),
			newValue: toTenthsValue(current.row.value),
			transfersIn: null,
			transfersOut: null,
		});
	}

	return history;
}

async function resolveTargetDate(context: GraphQLContext, changeDate: Date): Promise<string> {
	const compactStr = getCompactDateString(changeDate);
	const isoStr = getIsoDateString(changeDate);

	const [exactResult, isoResult] = await Promise.all([
		context.supabase
			.from("player_values")
			.select("change_date")
			.eq("change_date", compactStr)
			.limit(1),
		context.supabase.from("player_values").select("change_date").eq("change_date", isoStr).limit(1),
	]);

	if (exactResult.data && exactResult.data.length > 0) {
		return compactStr;
	}
	if (isoResult.data && isoResult.data.length > 0) {
		return isoStr;
	}
	return compactStr;
}

async function getPlayerValuesFromDatabase(
	context: GraphQLContext,
	changeDate: Date
): Promise<PlayerValue[]> {
	const targetDate = await resolveTargetDate(context, changeDate);

	const { data, error } = await context.supabase
		.from("player_values")
		.select("element_id, element_type, event_id, value, last_value, change_date, change_type")
		.eq("change_date", targetDate);

	if (error) {
		context.logger.error(
			{ err: error, changeDate: changeDate.toISOString(), targetDate },
			"Failed to fetch player values from database"
		);
		throw new Error(error.message, { cause: error });
	}

	const rows = (data as DbPlayerValueRow[] | null) ?? [];
	// Season-baseline rows ("start", last_value = 0) are not price changes.
	// Filtered in JS rather than .neq("change_type", "start") so legacy rows
	// with NULL change_type survive (SQL <> drops NULLs), mirroring
	// mapDbRowToPlayerValue's last_value ?? value fallback.
	const changedRows = rows.filter((row) => {
		if (row.change_type === "start") return false;
		return (row.last_value ?? row.value) > 0;
	});
	if (changedRows.length === 0) {
		context.logger.debug(
			{ changeDate: changeDate.toISOString(), targetDate },
			"No player value changes found in database"
		);
		return [];
	}

	const elementIds = Array.from(
		new Set(
			changedRows
				.map((row) => row.element_id)
				.filter((id): id is number => typeof id === "number" && id > 0)
		)
	);
	const eventIds = Array.from(
		new Set(
			changedRows
				.map((row) => row.event_id)
				.filter((id): id is number => typeof id === "number" && id > 0)
		)
	);

	const [playersResult, statsResult] = await Promise.all([
		context.supabase
			.from("players")
			.select("id, web_name, team_id, type, price")
			.in("id", elementIds),
		eventIds.length > 0
			? context.supabase
					.from("player_stats")
					.select(
						"element_id, event_id, web_name, element_type, team_id, team_name, team_short_name, value, total_points, form, transfers_in_event, transfers_out_event, selected_by_percent"
					)
					.in("element_id", elementIds)
					.in("event_id", eventIds)
			: Promise.resolve({ data: [], error: null }),
	]);
	if (playersResult.error || statsResult.error) {
		const cause = playersResult.error ?? statsResult.error;
		throw new Error("Failed to enrich player values", { cause });
	}

	const players = (playersResult.data as DbPlayerMetadataRow[] | null) ?? [];
	const teamIds = Array.from(new Set(players.map((player) => player.team_id)));
	const teamsResult = await context.supabase
		.from("teams")
		.select("id, name, short_name")
		.in("id", teamIds);
	if (teamsResult.error) {
		throw new Error("Failed to enrich player-value teams", {
			cause: teamsResult.error,
		});
	}

	const playerById = new Map(players.map((player) => [player.id, player]));
	const teamById = new Map(
		((teamsResult.data as DbTeamMetadataRow[] | null) ?? []).map((team) => [
			team.id,
			team,
		]) as Array<[number, DbTeamMetadataRow]>
	);
	const statsByPlayerEvent = new Map(
		((statsResult.data as DbPlayerStatMetadataRow[] | null) ?? []).map((stat) => [
			`${stat.element_id}:${stat.event_id}`,
			stat,
		]) as Array<[string, DbPlayerStatMetadataRow]>
	);

	return changedRows.map((row) => {
		const base = mapDbRowToPlayerValue(row);
		const player = playerById.get(base.playerId);
		const stat = row.event_id
			? statsByPlayerEvent.get(`${base.playerId}:${row.event_id}`)
			: undefined;
		const teamId = stat?.team_id ?? player?.team_id ?? 0;
		const team = teamById.get(teamId);
		const transfersIn = stat?.transfers_in_event ?? 0;
		const transfersOut = stat?.transfers_out_event ?? 0;
		const position = normalizePositionLabel(stat?.element_type ?? player?.type ?? "");

		return {
			...base,
			playerName: stat?.web_name ?? player?.web_name ?? "",
			teamId,
			teamName: stat?.team_name ?? team?.name ?? "",
			teamShortName: stat?.team_short_name ?? team?.short_name ?? base.teamShortName,
			position,
			positionEnum: toPositionEnum(position),
			price: stat?.value ?? player?.price ?? 0,
			points: stat?.total_points ?? 0,
			selectedBy: parseNullableNumber(stat?.selected_by_percent ?? null) ?? 0,
			transfersIn,
			transfersOut,
			netTransfers: transfersIn - transfersOut,
			form: parseNullableNumber(stat?.form ?? null),
			totalPoints: stat?.total_points ?? 0,
			// player_stats.total_points is season-cumulative, not event-scoped.
			// The value table has no authoritative per-event points fallback.
			eventPoints: null,
		};
	});
}

function parsePlayerValuesFromHashData(
	context: GraphQLContext,
	cacheKey: string,
	hashData: Record<string, string>
): PlayerValue[] | null {
	try {
		const parseFiniteNumber = (value: unknown): number | null => {
			if (typeof value === "number") {
				return Number.isFinite(value) ? value : null;
			}
			if (typeof value === "string" && value.trim() !== "") {
				const parsed = Number(value.trim());
				return Number.isFinite(parsed) ? parsed : null;
			}
			return null;
		};
		const isValidOptionalNumber = (row: Record<string, unknown>, key: string): boolean => {
			if (!(key in row) || row[key] === null || row[key] === undefined) return true;
			return parseFiniteNumber(row[key]) !== null;
		};
		const isValidOptionalString = (row: Record<string, unknown>, key: string): boolean => {
			if (!(key in row) || row[key] === null || row[key] === undefined) return true;
			return typeof row[key] === "string";
		};
		const numericFields = [
			"playerId",
			"elementId",
			"teamId",
			"price",
			"nowCost",
			"value",
			"lastValue",
			"points",
			"totalPoints",
			"eventPoints",
			"selectedBy",
			"selectedByPercent",
			"transfersIn",
			"transfersInEvent",
			"transfersOut",
			"transfersOutEvent",
			"netTransfers",
			"form",
		];
		const stringFields = [
			"playerName",
			"webName",
			"teamName",
			"teamShortName",
			"position",
			"elementTypeName",
			"changeType",
		];
		let malformed = false;
		const rawData = Object.entries(hashData)
			.map(([field, value]) => {
				try {
					const parsed: unknown = JSON.parse(value);
					if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
						malformed = true;
						return null;
					}
					const row = parsed as Record<string, unknown>;
					const fieldId = Number(field);
					const playerId = row.playerId ?? row.elementId;
					if (
						!Number.isInteger(fieldId) ||
						fieldId <= 0 ||
						typeof playerId !== "number" ||
						!Number.isInteger(playerId) ||
						playerId <= 0 ||
						playerId !== fieldId
					) {
						malformed = true;
						return null;
					}
					if (
						numericFields.some((key) => !isValidOptionalNumber(row, key)) ||
						stringFields.some((key) => !isValidOptionalString(row, key))
					) {
						malformed = true;
						return null;
					}
					return row;
				} catch (error) {
					malformed = true;
					context.logger.warn({ err: error, cacheKey }, "Failed to parse hash value");
					return null;
				}
			})
			.filter((item): item is Record<string, unknown> => item !== null);
		if (
			rawData.some((item) => {
				const playerId = item.playerId ?? item.elementId;
				return typeof playerId !== "number" || !Number.isFinite(playerId) || playerId <= 0;
			})
		) {
			return null;
		}

		// Start rows are season baselines, not price changes. The lastValue
		// predicate is the deciding filter because legacy cached JSON may not
		// carry changeType at all; rows without a previous value normalize to 0
		// and are dropped since they carry no change information.
		const changedData = rawData.filter((item) => {
			if (item.changeType === "Start") return false;
			const lastValue = parseFiniteNumber(item.lastValue) ?? 0;
			return lastValue > 0;
		});

		const playerValues: PlayerValue[] = changedData.map((item) => {
			const playerId = parseFiniteNumber(item.playerId) ?? parseFiniteNumber(item.elementId) ?? 0;
			const playerName = (item.playerName as string) ?? (item.webName as string) ?? "";
			const teamId = parseFiniteNumber(item.teamId) ?? 0;
			const teamName = (item.teamName as string) ?? "";
			const position = normalizePositionLabel(item.position ?? item.elementTypeName ?? "");
			const price = parseFiniteNumber(item.price) ?? parseFiniteNumber(item.nowCost) ?? 0;
			const value = parseFiniteNumber(item.value) ?? 0;
			const lastValue = parseFiniteNumber(item.lastValue) ?? 0;
			const points = parseFiniteNumber(item.points) ?? parseFiniteNumber(item.totalPoints) ?? 0;
			const selectedBy =
				parseFiniteNumber(item.selectedBy) ?? parseFiniteNumber(item.selectedByPercent) ?? 0;
			const transfersIn =
				parseFiniteNumber(item.transfersIn) ?? parseFiniteNumber(item.transfersInEvent) ?? 0;
			const transfersOut =
				parseFiniteNumber(item.transfersOut) ?? parseFiniteNumber(item.transfersOutEvent) ?? 0;
			const netTransfers = parseFiniteNumber(item.netTransfers) ?? transfersIn - transfersOut;
			const form = parseFiniteNumber(item.form);
			const totalPoints = parseFiniteNumber(item.totalPoints) ?? points;
			const eventPoints = parseFiniteNumber(item.eventPoints) ?? parseFiniteNumber(item.points);

			return {
				playerId,
				playerName,
				teamId,
				teamName,
				teamShortName: buildTeamShortName(
					(item.teamShortName as string | undefined) ?? null,
					teamName
				),
				position,
				positionEnum: toPositionEnum(position),
				price,
				value,
				lastValue,
				points,
				selectedBy,
				transfersIn,
				transfersOut,
				netTransfers,
				form,
				totalPoints,
				eventPoints,
			};
		});

		return malformed ? null : playerValues;
	} catch (error) {
		context.logger.error({ err: error, cacheKey }, "Failed to parse player values from Redis hash");
		return null;
	}
}

async function writePrivatePlayerValuesCache(
	context: GraphQLContext,
	cacheKey: string,
	values: PlayerValue[]
): Promise<void> {
	if (values.length === 0) {
		return;
	}
	await context.redis.set(cacheKey, JSON.stringify(values), "EX", 300);
}

const NULL_SENTINEL = "__pv:null__";
const MISSING_CACHE_TTL_SECONDS = 10 * 60;

function getMissingDateKey(changeDate: Date): string {
	return `PlayerValueMissing:${getCompactDateString(changeDate)}`;
}

export const playerValuesRepository: PlayerValuesRepository = {
	async getPlayerValues(context: GraphQLContext, changeDate: Date): Promise<PlayerValue[]> {
		const cacheKey = getDateKey(changeDate);
		const missingCacheKey = getMissingDateKey(changeDate);
		const season = await getCurrentSeason(context);
		const privateCacheKey = `gql:v2:${season}:player-values:${getCompactDateString(changeDate)}`;
		try {
			const cacheType = await context.redis.type(cacheKey);

			// The shared primary key is hash-only. String support is transitional for
			// sentinels and JSON values written by older GraphQL deployments.
			if (cacheType === "hash") {
				const hashData = await context.redis.hgetall(cacheKey);
				if (Object.keys(hashData).length > 0) {
					metrics.cacheRepositoryEvents.labels("player_values", "shared_hit").inc();
					const parsed = parsePlayerValuesFromHashData(context, cacheKey, hashData);
					if (parsed !== null) return parsed;
					metrics.cacheRepositoryEvents.labels("player_values", "malformed").inc();
				}
			} else if (cacheType === "string") {
				const stringVal = await context.redis.get(cacheKey);
				if (stringVal === NULL_SENTINEL) {
					await context.redis.set(missingCacheKey, "1", "EX", MISSING_CACHE_TTL_SECONDS);
					metrics.cacheRepositoryEvents.labels("player_values", "suppressed_shared_write").inc();
					return [];
				}

				try {
					const parsed = JSON.parse(stringVal ?? "null") as PlayerValue[];
					if (Array.isArray(parsed)) {
						let malformedLegacyRow = false;
						if (parsed.length > 0) {
							const hashData: Record<string, string> = {};
							for (const item of parsed) {
								const id = item.playerId;
								if (typeof id === "number" && Number.isFinite(id)) {
									hashData[String(id)] = JSON.stringify(item);
								} else {
									malformedLegacyRow = true;
								}
							}
							if (!malformedLegacyRow) {
								const normalized = parsePlayerValuesFromHashData(context, cacheKey, hashData);
								if (normalized !== null) {
									await writePrivatePlayerValuesCache(context, privateCacheKey, normalized);
									return normalized;
								}
								// A syntactically valid legacy array can still contain a
								// malformed payload. Do not turn that into a negative cache hit;
								// let the authoritative database path repair it.
								malformedLegacyRow = true;
								metrics.cacheRepositoryEvents.labels("player_values", "malformed").inc();
							} else {
								metrics.cacheRepositoryEvents.labels("player_values", "malformed").inc();
							}
						}
						if (!malformedLegacyRow) {
							await context.redis.set(missingCacheKey, "1", "EX", MISSING_CACHE_TTL_SECONDS);
							return [];
						}
					}
				} catch (err) {
					context.logger.warn(
						{ cacheKey, err },
						"Failed to parse legacy player values cache value"
					);
				}
			} else if (cacheType !== "none") {
				context.logger.warn({ cacheKey, cacheType }, "Unexpected Redis type for player values key");
			}

			if (await context.redis.get(missingCacheKey)) {
				metrics.cacheRepositoryEvents.labels("player_values", "negative_hit").inc();
				return [];
			}

			const privateCached = await context.redis.get(privateCacheKey);
			if (privateCached) {
				try {
					const parsed = JSON.parse(privateCached) as unknown;
					if (Array.isArray(parsed)) {
						// Entries written by pre-fix code can still hold season-baseline
						// rows until their TTL lapses; apply the same lastValue guard.
						const changed = (parsed as PlayerValue[]).filter(
							(item) => typeof item?.lastValue === "number" && item.lastValue > 0
						);
						metrics.cacheRepositoryEvents.labels("player_values", "private_hit").inc();
						return changed;
					}
				} catch (error) {
					context.logger.warn(
						{ err: error, privateCacheKey },
						"Malformed GraphQL player-values cache"
					);
				}
				await context.redis.del(privateCacheKey);
				metrics.cacheRepositoryEvents.labels("player_values", "malformed").inc();
			}
		} catch (error) {
			metrics.cacheRepositoryEvents.labels("player_values", "database_fallback").inc();
			context.logger.warn(
				{ err: error, cacheKey },
				"Player-values cache unavailable; using database"
			);
		}

		const values = await getPlayerValuesFromDatabase(context, changeDate);
		metrics.cacheRepositoryEvents.labels("player_values", "db_fallback").inc();

		try {
			if (values.length === 0) {
				await context.redis.set(missingCacheKey, "1", "EX", MISSING_CACHE_TTL_SECONDS);
			} else {
				await writePrivatePlayerValuesCache(context, privateCacheKey, values);
			}
		} catch (error) {
			context.logger.warn(
				{ err: error, privateCacheKey },
				"Failed to cache player-values database fallback"
			);
		}

		return values;
	},

	async getPlayerValueHistory(
		context: GraphQLContext,
		args: GetPlayerValueHistoryArgs
	): Promise<PlayerValueHistoryRepositoryItem[]> {
		if (!Number.isFinite(args.playerId) || args.playerId <= 0) {
			return [];
		}

		const season = await getCurrentSeason(context);
		const cacheKey = gqlCacheKey(season, buildHistoryCacheKey(args));
		let cached: string | null = null;
		try {
			cached = await context.redis.get(cacheKey);
		} catch (error) {
			context.logger.warn(
				{ err: error, cacheKey },
				"Player-value history cache unavailable; using database"
			);
		}
		if (cached !== null) {
			try {
				if (cached === NULL_SENTINEL) {
					return [];
				}
				const parsed = JSON.parse(cached) as unknown;
				if (!Array.isArray(parsed)) {
					throw new Error("Cached player-value history is not an array");
				}
				return parsed as PlayerValueHistoryRepositoryItem[];
			} catch (error) {
				context.logger.warn(
					{ err: error, cacheKey },
					"Malformed player-value history cache; using database"
				);
				try {
					await context.redis.del(cacheKey);
				} catch (deleteError) {
					context.logger.warn(
						{ err: deleteError, cacheKey },
						"Failed to evict malformed player-value history cache"
					);
				}
			}
		}

		try {
			const seasonWindow = await getActiveSeasonDateWindow(context, season);
			const encodings = await resolveHistoryDateEncodings(context, args.playerId);
			const databaseRowsByEncoding = await Promise.all(
				encodings.map(async (encoding) => {
					const fromDate =
						encoding === "compact" ? toCompactDate(seasonWindow.fromDate) : seasonWindow.fromDate;
					const untilDate =
						encoding === "compact" ? toCompactDate(seasonWindow.untilDate) : seasonWindow.untilDate;
					const rows: DbPlayerValueHistoryRow[] = [];
					for (let from = 0; ; from += PLAYER_VALUE_HISTORY_PAGE_SIZE) {
						let query = context.supabase
							.from("player_values")
							.select("element_id, value, last_value, change_date, change_type")
							.eq("element_id", args.playerId)
							.gte("change_date", fromDate)
							.lt("change_date", untilDate);
						// The column is text in legacy deployments. A format predicate is
						// required in mixed histories because lexical bounds alone can
						// admit the other representation from outside this season.
						query = query.like("change_date", encoding === "compact" ? "________" : "____-__-__%");
						const { data, error } = await query
							.order("change_date", { ascending: true })
							.range(from, from + PLAYER_VALUE_HISTORY_PAGE_SIZE - 1);

						if (error) {
							context.logger.error(
								{ err: error, playerId: args.playerId, from, encoding },
								"Failed to fetch player value history from database"
							);
							throw new Error(error.message, { cause: error });
						}

						const page = (data as DbPlayerValueHistoryRow[] | null) ?? [];
						rows.push(...page);
						if (page.length < PLAYER_VALUE_HISTORY_PAGE_SIZE) break;
					}
					return rows;
				})
			);
			const databaseRows = Array.from(
				new Map(
					databaseRowsByEncoding
						.flat()
						.map((row) => [
							`${row.element_id}:${row.change_date}:${row.value}:${row.last_value ?? "null"}:${row.change_type ?? ""}`,
							row,
						])
				).values()
			);

			const fromEpoch = args.fromDate?.getTime() ?? null;
			const toEpoch = args.toDate?.getTime() ?? null;
			const rows = databaseRows
				.map((row) => ({ row, parsedDate: parseChangeDate(row.change_date) }))
				.filter(
					(item): item is { row: DbPlayerValueHistoryRow; parsedDate: Date } =>
						item.parsedDate !== null &&
						(fromEpoch === null || item.parsedDate.getTime() >= fromEpoch) &&
						(toEpoch === null || item.parsedDate.getTime() <= toEpoch) &&
						item.row.change_type?.toLowerCase() !== "start" &&
						item.row.last_value !== 0
				)
				.sort((a, b) => b.parsedDate.getTime() - a.parsedDate.getTime())
				.map((item) => item.row);
			if (rows.length === 0) {
				try {
					await context.redis.set(cacheKey, NULL_SENTINEL, "EX", 3600);
				} catch (error) {
					context.logger.warn(
						{ err: error, cacheKey },
						"Failed to cache empty player-value history"
					);
				}
				return [];
			}

			const history = mapHistoryRows(rows);
			try {
				await context.redis.set(cacheKey, JSON.stringify(history), "EX", 3600);
			} catch (error) {
				context.logger.warn({ err: error, cacheKey }, "Failed to cache player-value history");
			}
			return history;
		} catch (error) {
			if (error instanceof Error && error.cause) {
				throw error;
			}
			context.logger.error(
				{ err: error, playerId: args.playerId },
				"Failed to query player value history"
			);
			throw error instanceof Error
				? error
				: new Error("Failed to query player value history", { cause: error });
		}
	},
};
