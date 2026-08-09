import type { GraphQLContext } from "../../graphql/context";
import { gqlCacheKey } from "../../infra/cache-key";
import { QUERY_CACHE_TTL_SECONDS, writeQueryCache } from "../../infra/query-cache";

const MARKET_RESULT_LIMIT = 10;
const PRICE_CHANGE_LIMIT = 20;
const AVAILABILITY_UPDATE_LIMIT = 20;
const AVAILABILITY_HIGHLIGHT_LIMIT = 5;
const STALE_AFTER_MS = 36 * 60 * 60 * 1000;

export type MarketPosition = "GOALKEEPER" | "DEFENDER" | "MIDFIELDER" | "FORWARD";

export type MarketPlayer = {
	playerId: number;
	playerCode: number;
	webName: string;
	teamId: number;
	teamName: string;
	teamShortName: string;
	position: MarketPosition;
	price: number;
	selectedByPercent: number;
};

export type MarketCoverage = {
	requestedDays: number;
	observedDays: number;
	firstDate: string | null;
	latestDate: string | null;
	capturedAt: string | null;
	complete: boolean;
	stale: boolean;
};

export type MarketAvailabilityUpdate = {
	player: MarketPlayer;
	status: string;
	previousStatus: string | null;
	news: string;
	newsAdded: string | null;
	observedDate: string;
	chanceOfPlayingThisRound: number | null;
	chanceOfPlayingNextRound: number | null;
};

export type MarketPulse = {
	coverage: MarketCoverage;
	mostSelected: MarketPlayer[];
	ownershipMovers: {
		risers: Array<{
			player: MarketPlayer;
			previousSelectedByPercent: number;
			selectedByPercent: number;
			change: number;
		}>;
		fallers: Array<{
			player: MarketPlayer;
			previousSelectedByPercent: number;
			selectedByPercent: number;
			change: number;
		}>;
	};
	transferMovers: Array<{
		player: MarketPlayer;
		transfersIn: number;
		transfersOut: number;
		netTransfers: number;
	}>;
	availabilityUpdates: MarketAvailabilityUpdate[];
	availabilityHighlights: MarketAvailabilityUpdate[];
	newPlayers: Array<{
		player: MarketPlayer;
		firstObservedDate: string;
	}>;
	priceChanges: Array<{
		player: MarketPlayer;
		changeDate: string;
		oldPrice: number;
		newPrice: number;
		change: number;
		direction: "RISE" | "FALL";
	}>;
};

export type MarketSnapshotRow = {
	snapshot_date: string | Date;
	captured_at: string | Date;
	element_id: number;
	player_code: number;
	web_name: string;
	team_id: number;
	team_name: string;
	team_short_name: string;
	element_type: number;
	position: string;
	price: number;
	selected_by_percent: string | number;
	transfers_in: number;
	transfers_out: number;
	status: string;
	news: string;
	news_added: string | Date | null;
	chance_of_playing_this_round: number | null;
	chance_of_playing_next_round: number | null;
	baseline_date: string | Date;
	first_observed_date: string | Date;
	previous_price: number | null;
	previous_transfers_in: number | null;
	previous_transfers_out: number | null;
	previous_status: string | null;
	previous_news: string | null;
	previous_chance_this_round: number | null;
	previous_chance_next_round: number | null;
};

type NormalizedMarketRow = Omit<
	MarketSnapshotRow,
	| "snapshot_date"
	| "captured_at"
	| "news_added"
	| "baseline_date"
	| "first_observed_date"
	| "selected_by_percent"
> & {
	snapshotDate: string;
	capturedAt: string;
	newsAdded: string | null;
	baselineDate: string;
	firstObservedDate: string;
	selectedByPercent: number;
};

type QueryExecutor = {
	query(sql: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
};

export type MarketRepository = {
	getMarketPulse(context: GraphQLContext, requestedDays: number): Promise<MarketPulse>;
};

const MARKET_QUERY = `
	WITH annotated AS (
		SELECT
			snapshot.*,
			MIN(snapshot.snapshot_date) OVER () AS baseline_date,
			MIN(snapshot.snapshot_date) OVER (PARTITION BY snapshot.element_id) AS first_observed_date,
			LAG(snapshot.price) OVER player_days AS previous_price,
			LAG(snapshot.transfers_in) OVER player_days AS previous_transfers_in,
			LAG(snapshot.transfers_out) OVER player_days AS previous_transfers_out,
			LAG(snapshot.status) OVER player_days AS previous_status,
			LAG(snapshot.news) OVER player_days AS previous_news,
			LAG(snapshot.chance_of_playing_this_round) OVER player_days AS previous_chance_this_round,
			LAG(snapshot.chance_of_playing_next_round) OVER player_days AS previous_chance_next_round
		FROM fpl.player_market_snapshots snapshot
		WHERE snapshot.season_id = $1
		WINDOW player_days AS (
			PARTITION BY snapshot.element_id
			ORDER BY snapshot.snapshot_date ASC
		)
	),
	latest AS (
		SELECT MAX(snapshot_date) AS latest_date
		FROM fpl.player_market_snapshots
		WHERE season_id = $1
	)
	SELECT annotated.*
	FROM annotated
	CROSS JOIN latest
	WHERE latest.latest_date IS NOT NULL
		AND annotated.snapshot_date >= latest.latest_date - ($2::integer - 1)
		AND annotated.snapshot_date <= latest.latest_date
	ORDER BY annotated.snapshot_date ASC, annotated.element_id ASC
`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const toNumber = (value: string | number, field: string): number => {
	const parsed = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(parsed)) {
		throw new Error(`Invalid market snapshot ${field}`);
	}
	return parsed;
};

const toCalendarDate = (value: string | Date, field: string): string => {
	if (value instanceof Date) {
		if (Number.isNaN(value.getTime())) throw new Error(`Invalid market snapshot ${field}`);
		const year = value.getFullYear();
		const month = String(value.getMonth() + 1).padStart(2, "0");
		const day = String(value.getDate()).padStart(2, "0");
		return `${year}-${month}-${day}`;
	}
	const match = /^(\d{4}-\d{2}-\d{2})/.exec(value);
	if (!match) throw new Error(`Invalid market snapshot ${field}`);
	return match[1];
};

const toIsoTimestamp = (value: string | Date, field: string): string => {
	const parsed = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(parsed.getTime())) throw new Error(`Invalid market snapshot ${field}`);
	return parsed.toISOString();
};

const toNullableIsoTimestamp = (value: string | Date | null): string | null =>
	value === null ? null : toIsoTimestamp(value, "news_added");

const normalizeRow = (row: MarketSnapshotRow): NormalizedMarketRow => ({
	...row,
	snapshotDate: toCalendarDate(row.snapshot_date, "snapshot_date"),
	capturedAt: toIsoTimestamp(row.captured_at, "captured_at"),
	newsAdded: toNullableIsoTimestamp(row.news_added),
	baselineDate: toCalendarDate(row.baseline_date, "baseline_date"),
	firstObservedDate: toCalendarDate(row.first_observed_date, "first_observed_date"),
	selectedByPercent: toNumber(row.selected_by_percent, "selected_by_percent"),
});

const positionFor = (row: NormalizedMarketRow): MarketPosition => {
	switch (row.position.toUpperCase()) {
		case "GKP":
		case "GOALKEEPER":
			return "GOALKEEPER";
		case "DEF":
		case "DEFENDER":
			return "DEFENDER";
		case "MID":
		case "MIDFIELDER":
			return "MIDFIELDER";
		case "FWD":
		case "FORWARD":
			return "FORWARD";
		default:
			throw new Error(`Invalid market snapshot position for player ${row.element_id}`);
	}
};

const playerFor = (row: NormalizedMarketRow): MarketPlayer => ({
	playerId: row.element_id,
	playerCode: row.player_code,
	webName: row.web_name,
	teamId: row.team_id,
	teamName: row.team_name,
	teamShortName: row.team_short_name,
	position: positionFor(row),
	price: row.price,
	selectedByPercent: row.selectedByPercent,
});

const comparePlayer = (a: MarketPlayer, b: MarketPlayer): number =>
	a.webName.localeCompare(b.webName) || a.playerId - b.playerId;

const addCalendarDays = (date: string, days: number): string => {
	const parsed = new Date(`${date}T00:00:00.000Z`);
	parsed.setUTCDate(parsed.getUTCDate() + days);
	return parsed.toISOString().slice(0, 10);
};

const toMarketCalendarDate = (timestamp: string): string => {
	const parsed = Date.parse(timestamp);
	if (!Number.isFinite(parsed)) throw new Error("Invalid market snapshot news_added");
	return new Date(parsed + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
};

export const emptyMarketPulse = (requestedDays: number): MarketPulse => ({
	coverage: {
		requestedDays,
		observedDays: 0,
		firstDate: null,
		latestDate: null,
		capturedAt: null,
		complete: false,
		stale: false,
	},
	mostSelected: [],
	ownershipMovers: { risers: [], fallers: [] },
	transferMovers: [],
	availabilityUpdates: [],
	availabilityHighlights: [],
	newPlayers: [],
	priceChanges: [],
});

export function buildMarketPulse(
	rawRows: readonly MarketSnapshotRow[],
	requestedDays: number,
	now: Date = new Date()
): MarketPulse {
	if (rawRows.length === 0) return emptyMarketPulse(requestedDays);

	const rows = rawRows.map(normalizeRow);
	const observedDates = Array.from(new Set(rows.map((row) => row.snapshotDate))).sort();
	const firstDate = observedDates[0];
	const latestDate = observedDates.at(-1)!;
	const windowStart = addCalendarDays(latestDate, -(requestedDays - 1));
	const latestRows = rows.filter((row) => row.snapshotDate === latestDate);
	const firstRows = rows.filter((row) => row.snapshotDate === firstDate);
	const latestByPlayer = new Map(latestRows.map((row) => [row.element_id, row]));
	const firstByPlayer = new Map(firstRows.map((row) => [row.element_id, row]));
	const capturedAt = latestRows.map((row) => row.capturedAt).sort((a, b) => b.localeCompare(a))[0];
	const capturedAtMs = Date.parse(capturedAt);

	const mostSelected = latestRows
		.map(playerFor)
		.sort((a, b) => b.selectedByPercent - a.selectedByPercent || comparePlayer(a, b))
		.slice(0, MARKET_RESULT_LIMIT);

	const ownership = latestRows.flatMap((row) => {
		const previous = firstByPlayer.get(row.element_id);
		if (!previous || firstDate === latestDate) return [];
		const change = row.selectedByPercent - previous.selectedByPercent;
		if (Math.abs(change) < 0.0005) return [];
		return [
			{
				player: playerFor(row),
				previousSelectedByPercent: previous.selectedByPercent,
				selectedByPercent: row.selectedByPercent,
				change,
			},
		];
	});
	const risers = ownership
		.filter((mover) => mover.change > 0)
		.sort((a, b) => b.change - a.change || comparePlayer(a.player, b.player))
		.slice(0, MARKET_RESULT_LIMIT);
	const fallers = ownership
		.filter((mover) => mover.change < 0)
		.sort((a, b) => a.change - b.change || comparePlayer(a.player, b.player))
		.slice(0, MARKET_RESULT_LIMIT);

	const transferTotals = new Map<number, { transfersIn: number; transfersOut: number }>();
	for (const row of rows) {
		const current = transferTotals.get(row.element_id) ?? { transfersIn: 0, transfersOut: 0 };
		if (row.previous_transfers_in !== null) {
			current.transfersIn += Math.max(row.transfers_in - row.previous_transfers_in, 0);
		}
		if (row.previous_transfers_out !== null) {
			current.transfersOut += Math.max(row.transfers_out - row.previous_transfers_out, 0);
		}
		transferTotals.set(row.element_id, current);
	}
	const transferMovers = Array.from(transferTotals.entries())
		.flatMap(([elementId, totals]) => {
			const current = latestByPlayer.get(elementId);
			if (!current || (totals.transfersIn === 0 && totals.transfersOut === 0)) return [];
			return [
				{
					player: playerFor(current),
					transfersIn: totals.transfersIn,
					transfersOut: totals.transfersOut,
					netTransfers: totals.transfersIn - totals.transfersOut,
				},
			];
		})
		.sort(
			(a, b) =>
				Math.abs(b.netTransfers) - Math.abs(a.netTransfers) ||
				b.transfersIn + b.transfersOut - (a.transfersIn + a.transfersOut) ||
				comparePlayer(a.player, b.player)
		)
		.slice(0, MARKET_RESULT_LIMIT);

	const changesByPlayer = new Map<
		number,
		{ observedDate: string; previousStatus: string | null }
	>();
	for (const row of rows) {
		const changed =
			row.previous_status !== null &&
			(row.status !== row.previous_status ||
				row.news !== row.previous_news ||
				row.chance_of_playing_this_round !== row.previous_chance_this_round ||
				row.chance_of_playing_next_round !== row.previous_chance_next_round);
		if (changed) {
			changesByPlayer.set(row.element_id, {
				observedDate: row.snapshotDate,
				previousStatus: row.previous_status,
			});
		}
	}
	const availabilityEvidence = latestRows
		.flatMap((row) => {
			const observedChange = changesByPlayer.get(row.element_id);
			const newsDate = row.newsAdded ? toMarketCalendarDate(row.newsAdded) : null;
			const hasRecentOfficialNews =
				row.news.trim().length > 0 &&
				newsDate !== null &&
				newsDate >= windowStart &&
				newsDate <= latestDate;
			if (!observedChange && !hasRecentOfficialNews) return [];
			const observedDate = [observedChange?.observedDate, hasRecentOfficialNews ? newsDate : null]
				.filter((value): value is string => Boolean(value))
				.sort()
				.at(-1)!;
			return [
				{
					player: playerFor(row),
					status: row.status,
					previousStatus: observedChange?.previousStatus ?? null,
					news: row.news,
					newsAdded: row.newsAdded,
					observedDate,
					chanceOfPlayingThisRound: row.chance_of_playing_this_round,
					chanceOfPlayingNextRound: row.chance_of_playing_next_round,
				},
			];
		})
		.sort(
			(a, b) =>
				b.observedDate.localeCompare(a.observedDate) ||
				b.player.selectedByPercent - a.player.selectedByPercent ||
				comparePlayer(a.player, b.player)
		);
	const availabilityUpdates = availabilityEvidence.slice(0, AVAILABILITY_UPDATE_LIMIT);
	const unavailableStatuses = new Set([
		"0",
		"i",
		"injured",
		"n",
		"not-in-squad",
		"not_in_squad",
		"s",
		"suspended",
		"u",
		"unavailable",
	]);
	const doubtfulStatuses = new Set(["d", "doubtful"]);
	const availableStatuses = new Set(["a", "available"]);
	const availabilityPriority = (update: MarketAvailabilityUpdate): number => {
		const status = update.status.trim().toLowerCase();
		const previousStatus = update.previousStatus?.trim().toLowerCase() ?? null;
		const chance = update.chanceOfPlayingThisRound ?? update.chanceOfPlayingNextRound;
		if (chance === 0 || unavailableStatuses.has(status)) return 0;
		if ((chance !== null && chance >= 25 && chance <= 50) || doubtfulStatuses.has(status)) {
			return 1;
		}
		if (chance === 75 || chance === null) return 2;
		if (
			availableStatuses.has(status) &&
			previousStatus !== null &&
			!availableStatuses.has(previousStatus)
		) {
			return 3;
		}
		return 4;
	};
	const availabilityHighlights = [...availabilityEvidence]
		.sort(
			(a, b) =>
				availabilityPriority(a) - availabilityPriority(b) ||
				b.player.selectedByPercent - a.player.selectedByPercent ||
				b.observedDate.localeCompare(a.observedDate) ||
				comparePlayer(a.player, b.player)
		)
		.slice(0, AVAILABILITY_HIGHLIGHT_LIMIT);

	const newPlayers = latestRows
		.filter(
			(row) =>
				row.firstObservedDate > row.baselineDate &&
				row.firstObservedDate >= windowStart &&
				row.firstObservedDate <= latestDate
		)
		.map((row) => ({ player: playerFor(row), firstObservedDate: row.firstObservedDate }))
		.sort(
			(a, b) =>
				b.firstObservedDate.localeCompare(a.firstObservedDate) ||
				b.player.selectedByPercent - a.player.selectedByPercent ||
				comparePlayer(a.player, b.player)
		)
		.slice(0, MARKET_RESULT_LIMIT);

	const priceChanges = rows
		.flatMap((row) => {
			if (row.previous_price === null || row.price === row.previous_price) return [];
			const change = row.price - row.previous_price;
			return [
				{
					player: playerFor(row),
					changeDate: row.snapshotDate,
					oldPrice: row.previous_price,
					newPrice: row.price,
					change,
					direction: change > 0 ? ("RISE" as const) : ("FALL" as const),
				},
			];
		})
		.sort(
			(a, b) =>
				b.changeDate.localeCompare(a.changeDate) ||
				Math.abs(b.change) - Math.abs(a.change) ||
				comparePlayer(a.player, b.player)
		)
		.slice(0, PRICE_CHANGE_LIMIT);

	return {
		coverage: {
			requestedDays,
			observedDays: observedDates.length,
			firstDate,
			latestDate,
			capturedAt,
			complete: observedDates.length === requestedDays,
			stale: Math.max(now.getTime() - capturedAtMs, 0) > STALE_AFTER_MS,
		},
		mostSelected,
		ownershipMovers: { risers, fallers },
		transferMovers,
		availabilityUpdates,
		availabilityHighlights,
		newPlayers,
		priceChanges,
	};
}

const isMarketPulse = (value: unknown): value is MarketPulse =>
	isRecord(value) &&
	isRecord(value.coverage) &&
	typeof value.coverage.requestedDays === "number" &&
	typeof value.coverage.observedDays === "number" &&
	Array.isArray(value.mostSelected) &&
	isRecord(value.ownershipMovers) &&
	Array.isArray(value.ownershipMovers.risers) &&
	Array.isArray(value.ownershipMovers.fallers) &&
	Array.isArray(value.transferMovers) &&
	Array.isArray(value.availabilityUpdates) &&
	Array.isArray(value.availabilityHighlights) &&
	Array.isArray(value.newPlayers) &&
	Array.isArray(value.priceChanges);

export const createMarketRepository = (queryExecutor?: QueryExecutor): MarketRepository => ({
	async getMarketPulse(context: GraphQLContext, requestedDays: number): Promise<MarketPulse> {
		const cacheKey = gqlCacheKey(context, `market-pulse:v3:${requestedDays}`);

		try {
			const cached = await context.redis.get(cacheKey);
			if (cached !== null) {
				try {
					const parsed: unknown = JSON.parse(cached);
					if (isMarketPulse(parsed)) return parsed;
				} catch (error) {
					context.logger.warn({ err: error, cacheKey }, "Malformed market pulse cache");
				}
				await context.redis.del(cacheKey);
			}
		} catch (error) {
			context.logger.warn({ err: error, cacheKey }, "Failed to read market pulse cache");
		}

		let rows: MarketSnapshotRow[];
		try {
			const result = await (queryExecutor ?? context.database).query(MARKET_QUERY, [
				context.currentSeason.seasonId,
				requestedDays,
			]);
			rows = result.rows as MarketSnapshotRow[];
		} catch (error) {
			context.logger.error({ err: error, requestedDays }, "Failed to query market snapshots");
			throw new Error("Failed to query market snapshots", { cause: error });
		}

		const pulse = buildMarketPulse(rows, requestedDays);
		await writeQueryCache(context, cacheKey, JSON.stringify(pulse), QUERY_CACHE_TTL_SECONDS.MARKET);
		return pulse;
	},
});

export const marketRepository = createMarketRepository();
