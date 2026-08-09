import type { GraphQLContext } from "../../graphql/context";
import { gqlCacheKey } from "../../infra/cache-key";
import { QUERY_CACHE_TTL_SECONDS } from "../../infra/query-cache";
import { getCoreDataSnapshot } from "../../infra/data-snapshot";
import { metrics } from "../../infra/metrics";

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

function getCompactDateString(date: Date): string {
	const year = date.getUTCFullYear();
	const month = String(date.getUTCMonth() + 1).padStart(2, "0");
	const day = String(date.getUTCDate()).padStart(2, "0");
	return `${year}${month}${day}`;
}

type DbPlayerValueRow = {
	element_id?: number;
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

type DbPlayerStatMetadataRow = {
	element_id: number;
	event_id: number;
	total_points: number | null;
	form: string | number | null;
	transfers_in_event: number | null;
	transfers_out_event: number | null;
	selected_by_percent: string | number | null;
};

type DbPlayerFixtureTeamRow = {
	element_id: number;
	event_id: number;
	team_id: number;
};

const compactDatePattern = /^\d{8}$/;

function toPositionEnum(position: string): PositionEnum | null {
	const normalized = position.trim().toUpperCase();
	if (normalized === "GOALKEEPER" || normalized === "GK" || normalized === "GKP") {
		return "GOALKEEPER";
	}
	if (normalized === "DEFENDER" || normalized === "DEF") {
		return "DEFENDER";
	}
	if (normalized === "MIDFIELDER" || normalized === "MID") {
		return "MIDFIELDER";
	}
	if (normalized === "FORWARD" || normalized === "FWD" || normalized === "STRIKER") {
		return "FORWARD";
	}
	return null;
}

function toPositionCode(elementType: number | null | undefined): string {
	switch (elementType) {
		case 1:
			return "GKP";
		case 2:
			return "DEF";
		case 3:
			return "MID";
		case 4:
			return "FWD";
		default:
			return "";
	}
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
	const from = args.fromDate ? getCompactDateString(args.fromDate) : "none";
	const to = args.toDate ? getCompactDateString(args.toDate) : "none";
	return `player-value-history:${args.playerId}:${from}:${to}`;
}

const mapDbRowToPlayerValue = (row: DbPlayerValueRow): PlayerValue => {
	const rawId = row.element_id;
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

async function getPlayerValuesFromDatabase(
	context: GraphQLContext,
	changeDate: Date
): Promise<PlayerValue[]> {
	const targetDate = getCompactDateString(changeDate);

	const { data, error } = await context.data
		.read("reporting.player_value_changes")
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
	// Filtered in JS rather than .neq("change_type", "start") so provenance rows
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

	const [core, statsResult, fixtureTeamsResult] = await Promise.all([
		getCoreDataSnapshot(context),
		eventIds.length > 0
			? context.data
					.read("fpl.player_event_snapshots")
					.select(
						"element_id, event_id, total_points, form, transfers_in_event, transfers_out_event, selected_by_percent"
					)
					.in("element_id", elementIds)
					.in("event_id", eventIds)
			: Promise.resolve({ data: [], error: null }),
		eventIds.length > 0
			? context.data
					.read("fpl.player_fixture_stats")
					.select("element_id, event_id, team_id")
					.in("element_id", elementIds)
					.in("event_id", eventIds)
			: Promise.resolve({ data: [], error: null }),
	]);
	if (statsResult.error || fixtureTeamsResult.error) {
		throw new Error("Failed to enrich player values", { cause: statsResult.error });
	}

	const playerById = new Map(core.players.map((player) => [player.id, player]));
	const teamById = new Map(core.teams.map((team) => [team.id, team]));
	const statsByPlayerEvent = new Map(
		((statsResult.data as DbPlayerStatMetadataRow[] | null) ?? []).map((stat) => [
			`${stat.element_id}:${stat.event_id}`,
			stat,
		]) as Array<[string, DbPlayerStatMetadataRow]>
	);
	const fixtureTeamByPlayerEvent = new Map(
		((fixtureTeamsResult.data as DbPlayerFixtureTeamRow[] | null) ?? [])
			.filter(
				(row) =>
					typeof row.element_id === "number" &&
					typeof row.event_id === "number" &&
					typeof row.team_id === "number"
			)
			.map((row) => [`${row.element_id}:${row.event_id}`, row.team_id] as const)
	);

	return changedRows.map((row) => {
		const base = mapDbRowToPlayerValue(row);
		const player = playerById.get(base.playerId);
		const stat = row.event_id
			? statsByPlayerEvent.get(`${base.playerId}:${row.event_id}`)
			: undefined;
		const teamId =
			(row.event_id
				? fixtureTeamByPlayerEvent.get(`${base.playerId}:${row.event_id}`)
				: undefined) ??
			player?.teamId ??
			0;
		const team = teamById.get(teamId);
		const transfersIn = stat?.transfers_in_event ?? 0;
		const transfersOut = stat?.transfers_out_event ?? 0;
		const position = toPositionCode(row.element_type ?? player?.type);

		return {
			...base,
			playerName: player?.webName ?? "",
			teamId,
			teamName: team?.name ?? "",
			teamShortName: team?.shortName ?? base.teamShortName,
			position,
			positionEnum: toPositionEnum(position),
			price: player?.price ?? 0,
			points: stat?.total_points ?? 0,
			selectedBy:
				parseNullableNumber(stat?.selected_by_percent ?? null) ?? player?.selectedByPercent ?? 0,
			transfersIn,
			transfersOut,
			netTransfers: transfersIn - transfersOut,
			form: parseNullableNumber(stat?.form ?? null),
			totalPoints: stat?.total_points ?? 0,
			// player_event_snapshots.total_points is season-cumulative, not event-scoped.
			// The reporting view has no authoritative per-event points fallback.
			eventPoints: null,
		};
	});
}

const NULL_SENTINEL = "__pv:null__";

const isFiniteNumber = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value);

const isPlayerValue = (value: unknown): value is PlayerValue => {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const row = value as Record<string, unknown>;
	return (
		isFiniteNumber(row.playerId) &&
		row.playerId > 0 &&
		typeof row.playerName === "string" &&
		isFiniteNumber(row.teamId) &&
		typeof row.teamName === "string" &&
		typeof row.teamShortName === "string" &&
		typeof row.position === "string" &&
		isFiniteNumber(row.value) &&
		isFiniteNumber(row.lastValue) &&
		row.lastValue > 0
	);
};

const parsePlayerValuesCache = (raw: string): PlayerValue[] | null => {
	try {
		const parsed: unknown = JSON.parse(raw);
		return Array.isArray(parsed) && parsed.every(isPlayerValue) ? parsed : null;
	} catch {
		return null;
	}
};

const parseHistoryCache = (raw: string): PlayerValueHistoryRepositoryItem[] | null => {
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return null;
		const result: PlayerValueHistoryRepositoryItem[] = [];
		for (const value of parsed) {
			if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
			const row = value as Record<string, unknown>;
			const changeDate =
				typeof row.changeDate === "string" || row.changeDate instanceof Date
					? parseChangeDate(row.changeDate)
					: null;
			if (
				!isFiniteNumber(row.playerId) ||
				row.playerId <= 0 ||
				!changeDate ||
				!isFiniteNumber(row.oldValue) ||
				!isFiniteNumber(row.newValue) ||
				!(row.transfersIn === null || isFiniteNumber(row.transfersIn)) ||
				!(row.transfersOut === null || isFiniteNumber(row.transfersOut))
			) {
				return null;
			}
			result.push({
				playerId: row.playerId,
				changeDate,
				oldValue: row.oldValue,
				newValue: row.newValue,
				transfersIn: row.transfersIn,
				transfersOut: row.transfersOut,
			});
		}
		return result;
	} catch {
		return null;
	}
};

export const playerValuesRepository: PlayerValuesRepository = {
	async getPlayerValues(context: GraphQLContext, changeDate: Date): Promise<PlayerValue[]> {
		const cacheKey = gqlCacheKey(context, `player-values:${getCompactDateString(changeDate)}`);
		try {
			const cached = await context.redis.get(cacheKey);
			if (cached === NULL_SENTINEL) {
				metrics.cacheRepositoryEvents.labels("player_values", "query_hit").inc();
				return [];
			}
			if (cached !== null) {
				const parsed = parsePlayerValuesCache(cached);
				if (parsed) {
					metrics.cacheRepositoryEvents.labels("player_values", "query_hit").inc();
					return parsed;
				}
				await context.redis.del(cacheKey);
				metrics.cacheRepositoryEvents.labels("player_values", "malformed").inc();
			}
		} catch (error) {
			metrics.cacheRepositoryEvents.labels("player_values", "database_fallback").inc();
			context.logger.warn({ err: error, cacheKey }, "Player-values query cache unavailable");
		}

		const values = await getPlayerValuesFromDatabase(context, changeDate);
		metrics.cacheRepositoryEvents.labels("player_values", "database_read").inc();

		try {
			await context.redis.set(
				cacheKey,
				values.length === 0 ? NULL_SENTINEL : JSON.stringify(values),
				"EX",
				QUERY_CACHE_TTL_SECONDS.MARKET
			);
		} catch (error) {
			context.logger.warn({ err: error, cacheKey }, "Failed to write player-values query cache");
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

		const cacheKey = gqlCacheKey(context, buildHistoryCacheKey(args));
		try {
			const cached = await context.redis.get(cacheKey);
			if (cached === NULL_SENTINEL) return [];
			if (cached !== null) {
				const parsed = parseHistoryCache(cached);
				if (parsed) return parsed;
				await context.redis.del(cacheKey);
			}
		} catch (error) {
			context.logger.warn({ err: error, cacheKey }, "Player-value history cache unavailable");
		}

		try {
			let query = context.data
				.read("reporting.player_value_changes")
				.select("element_id, value, last_value, change_date, change_type")
				.eq("element_id", args.playerId)
				.order("change_date", { ascending: false });

			if (args.fromDate) {
				query = query.gte("change_date", getCompactDateString(args.fromDate));
			}

			if (args.toDate) {
				query = query.lte("change_date", getCompactDateString(args.toDate));
			}

			const { data, error } = await query;

			if (error) {
				context.logger.error(
					{ err: error, playerId: args.playerId },
					"Failed to fetch player value history from database"
				);
				throw new Error(error.message, { cause: error });
			}

			const rows = ((data as DbPlayerValueHistoryRow[] | null) ?? []).filter((row) => {
				if (row.change_type?.toLowerCase() === "start") return false;
				return row.last_value !== 0;
			});
			if (rows.length === 0) {
				try {
					await context.redis.set(
						cacheKey,
						NULL_SENTINEL,
						"EX",
						QUERY_CACHE_TTL_SECONDS.HISTORICAL
					);
				} catch (cacheError) {
					context.logger.warn({ err: cacheError, cacheKey }, "History cache write failed");
				}
				return [];
			}

			const history = mapHistoryRows(rows);
			try {
				await context.redis.set(
					cacheKey,
					JSON.stringify(history),
					"EX",
					QUERY_CACHE_TTL_SECONDS.HISTORICAL
				);
			} catch (cacheError) {
				context.logger.warn({ err: cacheError, cacheKey }, "History cache write failed");
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
