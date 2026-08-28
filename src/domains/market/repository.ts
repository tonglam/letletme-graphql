import type { GraphQLContext } from "../../graphql/context";
import type { DataSqlContractProbe } from "../../contracts/data-sql-contract";
import { gqlCacheKey } from "../../infra/cache-key";
import { QUERY_CACHE_TTL_SECONDS, writeQueryCache } from "../../infra/query-cache";
import {
	createMarketPinFailure,
	getMarketSnapshotContext,
	refreshMarketSnapshotContext,
	type MarketSnapshotContext,
} from "./context";

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
	missingDates: string[];
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

export type MarketPriceChange = {
	player: MarketPlayer;
	changeDate: string;
	oldPrice: number;
	newPrice: number;
	change: number;
	direction: "RISE" | "FALL";
};

export type MarketPulse = {
	coverage: MarketCoverage;
	mostSelected: MarketPlayer[];
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
	priceChanges: MarketPriceChange[];
	/** Full, deterministically ordered evidence retained for the paginated API. */
	availabilityEvidence: MarketAvailabilityUpdate[];
	availabilityUpdateCount?: number;
};

export type MarketAvailabilityPage = {
	context: MarketSnapshotContext;
	items: MarketAvailabilityUpdate[];
	totalCount: number;
	nextOffset: number | null;
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
	getMarketAvailabilityPage(
		context: GraphQLContext,
		requestedDays: number,
		limit: number,
		offset: number
	): Promise<MarketAvailabilityPage>;
	getMarketLineup(context: GraphQLContext): Promise<MarketLineup | null>;
};

export function buildMarketAvailabilityPage(
	pulse: MarketPulse,
	context: MarketSnapshotContext,
	limit: number,
	offset: number
): MarketAvailabilityPage {
	const allItems = pulse.availabilityEvidence;
	const end = Math.min(offset + limit, allItems.length);
	return {
		context,
		items: allItems.slice(offset, end),
		totalCount: allItems.length,
		nextOffset: end < allItems.length ? end : null,
	};
}

export const MARKET_QUERY = `
	WITH raw_bounds AS (
		SELECT MIN(snapshot_date) AS baseline_date, MAX(snapshot_date) AS latest_date
		FROM fpl.player_market_snapshots
		WHERE season_id = $1
	), bounds AS (
		SELECT baseline_date,
			COALESCE($3::date, latest_date) AS latest_date,
			$4::timestamptz AS latest_captured_at
		FROM raw_bounds
	), window_rows AS (
		SELECT snapshot.*
		FROM fpl.player_market_snapshots snapshot
		CROSS JOIN bounds
		WHERE snapshot.season_id = $1
	  AND (bounds.latest_captured_at IS NULL
		OR snapshot.snapshot_date < bounds.latest_date
		OR (snapshot.snapshot_date = bounds.latest_date
			AND snapshot.captured_at <= bounds.latest_captured_at))
		  AND snapshot.snapshot_date >= bounds.latest_date - ($2::integer - 1)
		  AND snapshot.snapshot_date <= bounds.latest_date
	), window_elements AS (
		SELECT element_id
		FROM window_rows
		GROUP BY element_id
	), first_seen AS (
		SELECT element_id, MIN(snapshot_date) AS first_observed_date
		FROM fpl.player_market_snapshots
		WHERE season_id = $1
		GROUP BY element_id
	), predecessors AS (
		SELECT predecessor.*
		FROM window_elements element
		CROSS JOIN bounds
		CROSS JOIN LATERAL (
			SELECT snapshot.*
			FROM fpl.player_market_snapshots snapshot
			WHERE snapshot.season_id = $1
			  AND snapshot.element_id = element.element_id
			  AND snapshot.snapshot_date < bounds.latest_date - ($2::integer - 1)
			ORDER BY snapshot.snapshot_date DESC, snapshot.captured_at DESC
			LIMIT 1
		) predecessor
	), eligible AS (
		SELECT * FROM window_rows
		UNION ALL
		SELECT * FROM predecessors
	), annotated AS (
		SELECT
			snapshot.*,
			bounds.baseline_date,
			first_seen.first_observed_date,
			LAG(snapshot.price) OVER player_days AS previous_price,
			LAG(snapshot.transfers_in) OVER player_days AS previous_transfers_in,
			LAG(snapshot.transfers_out) OVER player_days AS previous_transfers_out,
			LAG(snapshot.status) OVER player_days AS previous_status,
			LAG(snapshot.news) OVER player_days AS previous_news,
			LAG(snapshot.chance_of_playing_this_round) OVER player_days AS previous_chance_this_round,
			LAG(snapshot.chance_of_playing_next_round) OVER player_days AS previous_chance_next_round
		FROM eligible snapshot
		CROSS JOIN bounds
		JOIN first_seen ON first_seen.element_id = snapshot.element_id
		WINDOW player_days AS (
			PARTITION BY snapshot.element_id
			ORDER BY snapshot.snapshot_date ASC, snapshot.captured_at ASC
		)
	)
	SELECT COALESCE(
		jsonb_agg(to_jsonb(annotated) ORDER BY annotated.snapshot_date ASC, annotated.element_id ASC),
		'[]'::jsonb
	) AS market_rows
	FROM annotated
	CROSS JOIN bounds
	WHERE bounds.latest_date IS NOT NULL
	  AND annotated.snapshot_date >= bounds.latest_date - ($2::integer - 1)
	  AND annotated.snapshot_date <= bounds.latest_date
	  AND (bounds.latest_captured_at IS NULL
		OR annotated.snapshot_date < bounds.latest_date
		OR (annotated.snapshot_date = bounds.latest_date
			AND annotated.captured_at <= bounds.latest_captured_at))
`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

export const MARKET_DATA_SQL_CONTRACT: readonly DataSqlContractProbe[] = [
	{
		name: "market.snapshot-window",
		sql: MARKET_QUERY,
		values: [2026, 7, "2025-08-28", "2025-08-28T00:00:00.000Z"],
	},
];

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
		missingDates: [],
		capturedAt: null,
		complete: false,
		stale: false,
	},
	mostSelected: [],
	transferMovers: [],
	availabilityUpdates: [],
	availabilityHighlights: [],
	availabilityEvidence: [],
	newPlayers: [],
	priceChanges: [],
	availabilityUpdateCount: 0,
});

export function buildMarketPulse(
	rawRows: readonly MarketSnapshotRow[],
	requestedDays: number,
	now: Date = new Date()
): MarketPulse {
	if (rawRows.length === 0) return emptyMarketPulse(requestedDays);

	const rowsByPlayerDay = new Map<string, NormalizedMarketRow>();
	for (const row of rawRows.map(normalizeRow)) {
		const key = `${row.element_id}:${row.snapshotDate}`;
		const existing = rowsByPlayerDay.get(key);
		if (!existing || row.capturedAt > existing.capturedAt) rowsByPlayerDay.set(key, row);
	}
	const rows = Array.from(rowsByPlayerDay.values());
	const observedDates = Array.from(new Set(rows.map((row) => row.snapshotDate))).sort();
	const firstDate = observedDates[0];
	const latestDate = observedDates.at(-1)!;
	const windowStart = addCalendarDays(latestDate, -(requestedDays - 1));
	const expectedDates = Array.from({ length: requestedDays }, (_, index) =>
		addCalendarDays(windowStart, index)
	);
	const observedDateSet = new Set(observedDates);
	const missingDates = expectedDates.filter((date) => !observedDateSet.has(date));
	const latestRows = rows.filter((row) => row.snapshotDate === latestDate);
	const latestByPlayer = new Map(latestRows.map((row) => [row.element_id, row]));
	const capturedAt = latestRows.map((row) => row.capturedAt).sort((a, b) => b.localeCompare(a))[0];
	const capturedAtMs = Date.parse(capturedAt);

	const mostSelected = latestRows
		.map(playerFor)
		.sort((a, b) => b.selectedByPercent - a.selectedByPercent || comparePlayer(a, b))
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
			missingDates,
			capturedAt,
			complete: missingDates.length === 0,
			stale: Math.max(now.getTime() - capturedAtMs, 0) > STALE_AFTER_MS,
		},
		mostSelected,
		transferMovers,
		availabilityUpdates,
		availabilityHighlights,
		availabilityEvidence,
		availabilityUpdateCount: availabilityEvidence.length,
		newPlayers,
		priceChanges,
	};
}

export type MarketLineupSlot = {
	player: MarketPlayer;
	row: number;
	col: number;
};

export type MarketLineup = {
	formation: string;
	totalOwnershipPercent: number;
	slots: MarketLineupSlot[];
};

/** DEF-MID-FWD counts for each valid FPL formation. */
const VALID_FORMATIONS: ReadonlyArray<readonly [number, number, number]> = [
	[4, 4, 2],
	[4, 3, 3],
	[3, 5, 2],
	[3, 4, 3],
	[4, 5, 1],
	[5, 3, 2],
	[5, 4, 1],
	[5, 2, 3],
];

/**
 * Build the optimal XI from the latest snapshot by maximising total ownership %
 * under valid FPL formation constraints.
 */
export function buildMarketLineup(rawRows: readonly MarketSnapshotRow[]): MarketLineup | null {
	if (rawRows.length === 0) return null;

	const rowsByPlayerDay = new Map<string, NormalizedMarketRow>();
	for (const row of rawRows.map(normalizeRow)) {
		const key = `${row.element_id}:${row.snapshotDate}`;
		const existing = rowsByPlayerDay.get(key);
		if (!existing || row.capturedAt > existing.capturedAt) rowsByPlayerDay.set(key, row);
	}
	const rows = Array.from(rowsByPlayerDay.values());
	const observedDates = Array.from(new Set(rows.map((row) => row.snapshotDate))).sort();
	const latestDate = observedDates.at(-1);
	if (!latestDate) return null;
	const latestRows = rows.filter((row) => row.snapshotDate === latestDate);

	const byPos: Record<string, NormalizedMarketRow[]> = {
		GOALKEEPER: [],
		DEFENDER: [],
		MIDFIELDER: [],
		FORWARD: [],
	};
	for (const row of latestRows) {
		const pos = positionFor(row);
		byPos[pos].push(row);
	}
	for (const key of Object.keys(byPos)) {
		byPos[key].sort(
			(a, b) => b.selectedByPercent - a.selectedByPercent || a.element_id - b.element_id
		);
	}
	if (byPos.GOALKEEPER.length < 1) return null;

	let bestKey = "";
	let bestSum = -1;

	for (const [def, mid, fwd] of VALID_FORMATIONS) {
		if (byPos.DEFENDER.length < def) continue;
		if (byPos.MIDFIELDER.length < mid) continue;
		if (byPos.FORWARD.length < fwd) continue;

		const sum =
			byPos.GOALKEEPER[0].selectedByPercent +
			byPos.DEFENDER.slice(0, def).reduce((s, r) => s + r.selectedByPercent, 0) +
			byPos.MIDFIELDER.slice(0, mid).reduce((s, r) => s + r.selectedByPercent, 0) +
			byPos.FORWARD.slice(0, fwd).reduce((s, r) => s + r.selectedByPercent, 0);

		if (sum > bestSum) {
			bestSum = sum;
			bestKey = `${def}-${mid}-${fwd}`;
		}
	}

	if (!bestKey) return null;

	const [def, mid, fwd] = bestKey.split("-").map(Number);
	const selected: NormalizedMarketRow[] = [
		byPos.GOALKEEPER[0],
		...byPos.DEFENDER.slice(0, def),
		...byPos.MIDFIELDER.slice(0, mid),
		...byPos.FORWARD.slice(0, fwd),
	];

	// Row indices: 0=GK, 1=DEF, 2=MID, 3=FWD. Col is position within the row.
	let rowIdx = 0;
	let colIdx = 0;
	let prevPos = "";
	const slots: MarketLineupSlot[] = selected.map((row) => {
		const pos = positionFor(row);
		if (pos !== prevPos) {
			rowIdx = prevPos ? rowIdx + 1 : 0;
			colIdx = 0;
			prevPos = pos;
		} else {
			colIdx++;
		}
		return { player: playerFor(row), row: rowIdx, col: colIdx };
	});

	return { formation: bestKey, totalOwnershipPercent: bestSum, slots };
}

const isMarketLineup = (value: unknown): value is MarketLineup =>
	isRecord(value) &&
	typeof value.formation === "string" &&
	typeof value.totalOwnershipPercent === "number" &&
	Array.isArray(value.slots);

const isMarketPulse = (value: unknown): value is MarketPulse =>
	isRecord(value) &&
	isRecord(value.coverage) &&
	typeof value.coverage.requestedDays === "number" &&
	typeof value.coverage.observedDays === "number" &&
	Array.isArray(value.coverage.missingDates) &&
	Array.isArray(value.mostSelected) &&
	Array.isArray(value.transferMovers) &&
	Array.isArray(value.availabilityUpdates) &&
	Array.isArray(value.availabilityEvidence) &&
	Array.isArray(value.availabilityHighlights) &&
	Array.isArray(value.newPlayers) &&
	Array.isArray(value.priceChanges) &&
	(typeof value.availabilityUpdateCount === "number" || value.availabilityUpdates.length >= 0);

const marketPulseFlights = new WeakMap<object, Map<string, Promise<MarketPulse>>>();

const runMarketPulseFlight = (
	context: GraphQLContext,
	cacheKey: string,
	load: () => Promise<MarketPulse>
): Promise<MarketPulse> => {
	const identity = context.redis as object;
	let flights = marketPulseFlights.get(identity);
	if (!flights) {
		flights = new Map();
		marketPulseFlights.set(identity, flights);
	}
	const existing = flights.get(cacheKey);
	if (existing) return existing;

	const flight = load();
	flights.set(cacheKey, flight);
	const clearFlight = (): void => {
		if (flights?.get(cacheKey) === flight) flights.delete(cacheKey);
	};
	void flight.then(clearFlight, clearFlight);
	return flight;
};

export const createMarketRepository = (queryExecutor?: QueryExecutor): MarketRepository => ({
	async getMarketPulse(context: GraphQLContext, requestedDays: number): Promise<MarketPulse> {
		let snapshotContext: Awaited<ReturnType<typeof getMarketSnapshotContext>> | null = null;
		try {
			snapshotContext = await getMarketSnapshotContext(context);
		} catch (error) {
			context.logger.warn(
				{ err: error },
				"Market snapshot context unavailable; using request fallback"
			);
		}
		let cacheKey = snapshotContext
			? gqlCacheKey(
					context,
					`market-pulse:v4:${requestedDays}`,
					`${context.dataRevision ?? "core-postgres"}.${snapshotContext.revision}`
				)
			: gqlCacheKey(context, `market-pulse:v4:${requestedDays}`);
		return runMarketPulseFlight(context, cacheKey, async () => {
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

			const readRows = async (
				pin: Awaited<ReturnType<typeof getMarketSnapshotContext>> | null
			): Promise<{ rows: MarketSnapshotRow[]; hasPinnedSnapshot: boolean }> => {
				const queryStartedAt = performance.now();
				const result = await (queryExecutor ?? context.database).query(MARKET_QUERY, [
					context.currentSeason.seasonId,
					requestedDays,
					pin?.snapshotDate ?? null,
					pin?.capturedAt ?? null,
				]);
				const compact = result.rows[0] as { market_rows?: unknown } | undefined;
				rows = Array.isArray(compact?.market_rows)
					? (compact.market_rows as MarketSnapshotRow[])
					: (result.rows as MarketSnapshotRow[]);
				context.logger.info?.(
					{
						requestedDays,
						rowCount: rows.length,
						queryMs: Math.round(performance.now() - queryStartedAt),
						compact: Array.isArray(compact?.market_rows),
					},
					"Market compact query completed"
				);
				const hasPinnedSnapshot =
					!pin ||
					rows.some(
						(row) =>
							toCalendarDate(row.snapshot_date, "snapshot_date") === pin.snapshotDate &&
							toIsoTimestamp(row.captured_at, "captured_at") === pin.capturedAt
					);
				return { rows, hasPinnedSnapshot };
			};
			let rows: MarketSnapshotRow[];
			try {
				let read = await readRows(snapshotContext);
				rows = read.rows;
				if (snapshotContext && !read.hasPinnedSnapshot) {
					snapshotContext = await refreshMarketSnapshotContext(context);
					if (!snapshotContext)
						throw createMarketPinFailure(context, "Market snapshot pin unavailable after retry");
					cacheKey = gqlCacheKey(
						context,
						`market-pulse:v4:${requestedDays}`,
						`${context.dataRevision ?? "core-postgres"}.${snapshotContext.revision}`
					);
					read = await readRows(snapshotContext);
					rows = read.rows;
					if (!read.hasPinnedSnapshot)
						throw createMarketPinFailure(context, "Market snapshot pin changed during query");
				}
			} catch (error) {
				context.logger.error({ err: error, requestedDays }, "Failed to query market snapshots");
				throw new Error("Failed to query market snapshots", { cause: error });
			}

			const pulse = buildMarketPulse(rows, requestedDays);
			await writeQueryCache(
				context,
				cacheKey,
				JSON.stringify(pulse),
				snapshotContext?.cacheTtlSeconds ?? QUERY_CACHE_TTL_SECONDS.MARKET
			);
			return pulse;
		});
	},
	async getMarketAvailabilityPage(
		context: GraphQLContext,
		requestedDays: number,
		limit: number,
		offset: number
	): Promise<MarketAvailabilityPage> {
		const pulse = await this.getMarketPulse(context, requestedDays);
		// Read the context after the pulse so a same-day pin retry cannot pair
		// the refreshed full evidence with the pre-retry revision.
		const snapshotContext = await getMarketSnapshotContext(context);
		if (!snapshotContext) throw new Error("Market snapshot context is unavailable");
		return buildMarketAvailabilityPage(pulse, snapshotContext, limit, offset);
	},
	async getMarketLineup(context: GraphQLContext): Promise<MarketLineup | null> {
		let snapshotContext: Awaited<ReturnType<typeof getMarketSnapshotContext>> | null = null;
		try {
			snapshotContext = await getMarketSnapshotContext(context);
		} catch (error) {
			context.logger.warn(
				{ err: error },
				"Market snapshot context unavailable; using request fallback"
			);
		}
		let cacheKey = snapshotContext
			? gqlCacheKey(
					context,
					"market-lineup:v1",
					`${context.dataRevision ?? "core-postgres"}.${snapshotContext.revision}`
				)
			: gqlCacheKey(context, "market-lineup");
		try {
			const cached = await context.redis.get(cacheKey);
			if (cached !== null) {
				try {
					const parsed: unknown = JSON.parse(cached);
					if (isMarketLineup(parsed)) return parsed;
				} catch (error) {
					context.logger.warn({ err: error, cacheKey }, "Malformed market lineup cache");
				}
				await context.redis.del(cacheKey);
			}
		} catch (error) {
			context.logger.warn({ err: error, cacheKey }, "Failed to read market lineup cache");
		}

		const readRows = async (
			pin: Awaited<ReturnType<typeof getMarketSnapshotContext>> | null
		): Promise<{ rows: MarketSnapshotRow[]; hasPinnedSnapshot: boolean }> => {
			const result = await (queryExecutor ?? context.database).query(MARKET_QUERY, [
				context.currentSeason.seasonId,
				7,
				pin?.snapshotDate ?? null,
				pin?.capturedAt ?? null,
			]);
			const compact = result.rows[0] as { market_rows?: unknown } | undefined;
			rows = Array.isArray(compact?.market_rows)
				? (compact.market_rows as MarketSnapshotRow[])
				: (result.rows as MarketSnapshotRow[]);
			const hasPinnedSnapshot =
				!pin ||
				rows.some(
					(row) =>
						toCalendarDate(row.snapshot_date, "snapshot_date") === pin.snapshotDate &&
						toIsoTimestamp(row.captured_at, "captured_at") === pin.capturedAt
				);
			return { rows, hasPinnedSnapshot };
		};
		let rows: MarketSnapshotRow[];
		try {
			let read = await readRows(snapshotContext);
			rows = read.rows;
			if (snapshotContext && !read.hasPinnedSnapshot) {
				snapshotContext = await refreshMarketSnapshotContext(context);
				if (!snapshotContext)
					throw createMarketPinFailure(context, "Market snapshot pin unavailable after retry");
				cacheKey = gqlCacheKey(
					context,
					"market-lineup:v1",
					`${context.dataRevision ?? "core-postgres"}.${snapshotContext.revision}`
				);
				read = await readRows(snapshotContext);
				rows = read.rows;
				if (!read.hasPinnedSnapshot)
					throw createMarketPinFailure(context, "Market snapshot pin changed during query");
			}
		} catch (error) {
			context.logger.error({ err: error }, "Failed to query market snapshots for lineup");
			throw new Error("Failed to query market snapshots for lineup", { cause: error });
		}

		const lineup = buildMarketLineup(rows);
		if (lineup) {
			await writeQueryCache(
				context,
				cacheKey,
				JSON.stringify(lineup),
				snapshotContext?.cacheTtlSeconds ?? QUERY_CACHE_TTL_SECONDS.MARKET
			);
		}
		return lineup;
	},
});

export const marketRepository = createMarketRepository();
