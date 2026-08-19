import type { GraphQLContext } from "../../graphql/context";
import { gqlCacheKey } from "../../infra/cache-key";
import {
	MARKET_REVISIONED_TTL_SECONDS,
	QUERY_CACHE_TTL_SECONDS,
	readJsonQueryCache,
	writeJsonQueryCache,
} from "../../infra/query-cache";
import type { Event } from "../events/repository";
import { eventsService } from "../events/service";
import type { MarketPlayer, MarketPosition } from "./repository";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const OWNERSHIP_LOOKBACK_DAYS = 45;
const STALE_AFTER_MS = 36 * 60 * 60 * 1000;

export type MarketOwnershipPeriod = "DAILY" | "GAMEWEEK" | "ROLLING_7D";

export type MarketOwnershipCoverageStatus =
	| "READY"
	| "PARTIAL"
	| "NO_DATA"
	| "BASELINE_MISSING"
	| "NO_PREVIOUS_GAMEWEEK"
	| "NO_UPCOMING_GAMEWEEK";

export type MarketOwnershipCoverage = {
	status: MarketOwnershipCoverageStatus;
	requestedDays: number;
	observedDays: number;
	firstDate: string | null;
	latestDate: string | null;
	fromDate: string | null;
	toDate: string | null;
	missingDates: string[];
	capturedAt: string | null;
	complete: boolean;
	stale: boolean;
};

export type MarketOwnershipChange = {
	player: MarketPlayer;
	fromSelectedByPercent: number;
	toSelectedByPercent: number;
	changePercentagePoints: number;
	fromDate: string;
	toDate: string;
};

export type MarketOwnershipGameweek = {
	id: number;
	name: string;
	deadlineTime: string;
};

export type MarketOwnershipOverview = {
	period: MarketOwnershipPeriod;
	gameweek: MarketOwnershipGameweek | null;
	coverage: MarketOwnershipCoverage;
	risers: MarketOwnershipChange[];
	fallers: MarketOwnershipChange[];
};

export type MarketOwnershipDay = {
	period: "DAILY";
	date: string | null;
	coverage: MarketOwnershipCoverage;
	risers: MarketOwnershipChange[];
	fallers: MarketOwnershipChange[];
};

export type MarketOwnershipSnapshotRow = {
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
};

type OwnershipSnapshot = {
	snapshotDate: string;
	capturedAt: string;
	elementId: number;
	playerCode: number;
	webName: string;
	teamId: number;
	teamName: string;
	teamShortName: string;
	position: MarketPosition;
	price: number;
	selectedByPercent: number;
};

type QueryExecutor = {
	query(sql: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
};

export type MarketOwnershipRepository = {
	getOverview(
		context: GraphQLContext,
		period: MarketOwnershipPeriod,
		limit: number
	): Promise<MarketOwnershipOverview>;
	getDay(context: GraphQLContext, date: Date | null, limit: number): Promise<MarketOwnershipDay>;
};

const OWNERSHIP_QUERY = [
	"WITH latest AS (",
	"  SELECT MAX(snapshot_date) AS latest_date",
	"  FROM fpl.player_market_snapshots",
	"  WHERE season_id = $1",
	"), bounded AS (",
	"  SELECT snapshot_date::text AS snapshot_date, captured_at, element_id, player_code,",
	"         web_name, team_id, team_name, team_short_name, element_type, position,",
	"         price, selected_by_percent",
	"  FROM fpl.player_market_snapshots",
	"  CROSS JOIN latest",
	"  WHERE season_id = $1",
	"    AND latest.latest_date IS NOT NULL",
	"    AND snapshot_date >= latest.latest_date - ($2::integer - 1)",
	"    AND snapshot_date <= latest.latest_date",
	"), deduped AS (",
	"  SELECT DISTINCT ON (snapshot_date, element_id) *",
	"  FROM bounded",
	"  ORDER BY snapshot_date ASC, element_id ASC, captured_at DESC",
	")",
	"SELECT COALESCE(",
	"  jsonb_agg(to_jsonb(deduped) ORDER BY deduped.snapshot_date ASC, deduped.element_id ASC),",
	"  '[]'::jsonb",
	") AS ownership_rows",
	"FROM deduped",
].join("\n");

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const numberValue = (value: unknown, field: string): number => {
	const parsed = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(parsed)) throw new Error("Invalid market ownership " + field);
	return parsed;
};

const integerValue = (value: unknown, field: string): number => {
	const parsed = numberValue(value, field);
	if (!Number.isSafeInteger(parsed)) throw new Error("Invalid market ownership " + field);
	return parsed;
};

const calendarDate = (value: string | Date, field: string): string => {
	if (value instanceof Date) {
		if (Number.isNaN(value.getTime())) throw new Error("Invalid market ownership " + field);
		return value.toISOString().slice(0, 10);
	}
	const match = /^(\d{4}-\d{2}-\d{2})/.exec(value);
	if (!match) throw new Error("Invalid market ownership " + field);
	return match[1];
};

const isoTimestamp = (value: string | Date, field: string): string => {
	const parsed = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(parsed.getTime())) throw new Error("Invalid market ownership " + field);
	return parsed.toISOString();
};

const positionFor = (value: unknown, playerId: number): MarketPosition => {
	const position = String(value).toUpperCase();
	switch (position) {
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
			throw new Error("Invalid market ownership position for player " + playerId);
	}
};

const normalizeRow = (row: MarketOwnershipSnapshotRow): OwnershipSnapshot => {
	const elementId = integerValue(row.element_id, "element_id");
	return {
		snapshotDate: calendarDate(row.snapshot_date, "snapshot_date"),
		capturedAt: isoTimestamp(row.captured_at, "captured_at"),
		elementId,
		playerCode: integerValue(row.player_code, "player_code"),
		webName: String(row.web_name),
		teamId: integerValue(row.team_id, "team_id"),
		teamName: String(row.team_name),
		teamShortName: String(row.team_short_name),
		position: positionFor(row.position, elementId),
		price: integerValue(row.price, "price"),
		selectedByPercent: numberValue(row.selected_by_percent, "selected_by_percent"),
	};
};

const isSnapshotRow = (value: unknown): value is MarketOwnershipSnapshotRow =>
	isRecord(value) &&
	(value.snapshot_date instanceof Date || typeof value.snapshot_date === "string") &&
	(value.captured_at instanceof Date || typeof value.captured_at === "string") &&
	typeof value.web_name === "string" &&
	typeof value.team_name === "string" &&
	typeof value.team_short_name === "string" &&
	typeof value.position === "string" &&
	"element_id" in value &&
	"player_code" in value &&
	"team_id" in value &&
	"price" in value &&
	"selected_by_percent" in value;

const decodeRows = (value: unknown): OwnershipSnapshot[] | null => {
	let parsed = value;
	if (typeof parsed === "string") {
		try {
			parsed = JSON.parse(parsed) as unknown;
		} catch {
			return null;
		}
	}
	if (!Array.isArray(parsed) || !parsed.every(isSnapshotRow)) return null;
	try {
		return parsed.map(normalizeRow);
	} catch {
		return null;
	}
};

const playerFor = (row: OwnershipSnapshot): MarketPlayer => ({
	playerId: row.elementId,
	playerCode: row.playerCode,
	webName: row.webName,
	teamId: row.teamId,
	teamName: row.teamName,
	teamShortName: row.teamShortName,
	position: row.position,
	price: row.price,
	selectedByPercent: row.selectedByPercent,
});

const comparePlayer = (left: MarketPlayer, right: MarketPlayer): number =>
	left.webName.localeCompare(right.webName) || left.playerId - right.playerId;

const addCalendarDays = (date: string, days: number): string => {
	const parsed = new Date(date + "T00:00:00.000Z");
	parsed.setUTCDate(parsed.getUTCDate() + days);
	return parsed.toISOString().slice(0, 10);
};

const datesBetween = (fromDate: string, toDate: string): string[] => {
	const dates: string[] = [];
	let current = fromDate;
	while (current <= toDate) {
		dates.push(current);
		current = addCalendarDays(current, 1);
	}
	return dates;
};

const uniqueSortedDates = (rows: readonly OwnershipSnapshot[]): string[] =>
	Array.from(new Set(rows.map((row) => row.snapshotDate))).sort();

const rowsForDate = (
	rowsByDate: ReadonlyMap<string, OwnershipSnapshot[]>,
	date: string | null
): OwnershipSnapshot[] => (date ? (rowsByDate.get(date) ?? []) : []);

const maxCapturedAt = (rows: readonly OwnershipSnapshot[]): string | null =>
	rows.map((row) => row.capturedAt).sort((left, right) => right.localeCompare(left))[0] ?? null;

const coverageFor = (input: {
	status: MarketOwnershipCoverageStatus;
	expectedDates: readonly string[];
	rows: readonly OwnershipSnapshot[];
	fromDate: string | null;
	toDate: string | null;
	now: Date;
}): MarketOwnershipCoverage => {
	const observedDates = uniqueSortedDates(input.rows);
	const missingDates = input.expectedDates.filter((date) => !observedDates.includes(date));
	const capturedAt = maxCapturedAt(input.rows);
	const capturedAtMs = capturedAt ? Date.parse(capturedAt) : Number.NaN;
	const stale =
		Number.isFinite(capturedAtMs) &&
		Math.max(input.now.getTime() - capturedAtMs, 0) > STALE_AFTER_MS;
	const status = input.status;
	return {
		status,
		requestedDays: input.expectedDates.length,
		observedDays: observedDates.length,
		firstDate: observedDates[0] ?? null,
		latestDate: observedDates.at(-1) ?? null,
		fromDate: input.fromDate,
		toDate: input.toDate,
		missingDates,
		capturedAt,
		complete: status === "READY" && missingDates.length === 0,
		stale,
	};
};

const changesFor = (
	fromRows: readonly OwnershipSnapshot[],
	toRows: readonly OwnershipSnapshot[],
	fromDate: string,
	toDate: string,
	limit: number
): { risers: MarketOwnershipChange[]; fallers: MarketOwnershipChange[] } => {
	const fromByPlayer = new Map(fromRows.map((row) => [row.elementId, row]));
	const changes = toRows.flatMap((row) => {
		const from = fromByPlayer.get(row.elementId);
		if (!from) return [];
		const changePercentagePoints = row.selectedByPercent - from.selectedByPercent;
		if (Math.abs(changePercentagePoints) < 0.0005) return [];
		return [
			{
				player: playerFor(row),
				fromSelectedByPercent: from.selectedByPercent,
				toSelectedByPercent: row.selectedByPercent,
				changePercentagePoints,
				fromDate,
				toDate,
			},
		];
	});
	return {
		risers: changes
			.filter((change) => change.changePercentagePoints > 0)
			.sort(
				(left, right) =>
					right.changePercentagePoints - left.changePercentagePoints ||
					comparePlayer(left.player, right.player)
			)
			.slice(0, limit),
		fallers: changes
			.filter((change) => change.changePercentagePoints < 0)
			.sort(
				(left, right) =>
					left.changePercentagePoints - right.changePercentagePoints ||
					comparePlayer(left.player, right.player)
			)
			.slice(0, limit),
	};
};

const emptyCoverage = (
	status: MarketOwnershipCoverageStatus,
	expectedDates: readonly string[] = [],
	now = new Date()
): MarketOwnershipCoverage =>
	coverageFor({
		status,
		expectedDates,
		rows: [],
		fromDate: null,
		toDate: null,
		now,
	});

const emptyOverview = (
	period: MarketOwnershipPeriod,
	status: MarketOwnershipCoverageStatus,
	now = new Date()
): MarketOwnershipOverview => ({
	period,
	gameweek: null,
	coverage: emptyCoverage(status, [], now),
	risers: [],
	fallers: [],
});

const rowsGroupedByDate = (
	rows: readonly OwnershipSnapshot[]
): Map<string, OwnershipSnapshot[]> => {
	const grouped = new Map<string, OwnershipSnapshot[]>();
	for (const row of rows) {
		const current = grouped.get(row.snapshotDate) ?? [];
		current.push(row);
		grouped.set(row.snapshotDate, current);
	}
	return grouped;
};

const overviewFromEndpoints = (input: {
	period: MarketOwnershipPeriod;
	rows: readonly OwnershipSnapshot[];
	fromRows: readonly OwnershipSnapshot[];
	toRows: readonly OwnershipSnapshot[];
	fromDate: string | null;
	toDate: string | null;
	expectedDates: readonly string[];
	status: MarketOwnershipCoverageStatus;
	limit: number;
	gameweek?: MarketOwnershipGameweek | null;
	now: Date;
}): MarketOwnershipOverview => {
	const changes =
		input.fromDate && input.toDate
			? changesFor(input.fromRows, input.toRows, input.fromDate, input.toDate, input.limit)
			: { risers: [], fallers: [] };
	return {
		period: input.period,
		gameweek: input.gameweek ?? null,
		coverage: coverageFor({
			status: input.status,
			expectedDates: input.expectedDates,
			rows: input.rows,
			fromDate: input.fromDate,
			toDate: input.toDate,
			now: input.now,
		}),
		risers: changes.risers,
		fallers: changes.fallers,
	};
};

const normalizedLimit = (limit: number): number =>
	Math.min(Math.max(Number.isInteger(limit) ? limit : DEFAULT_LIMIT, 1), MAX_LIMIT);

export const buildMarketOwnershipDay = (
	rawRows: readonly MarketOwnershipSnapshotRow[] | readonly OwnershipSnapshot[],
	date: string | null = null,
	limit = DEFAULT_LIMIT,
	now = new Date()
): MarketOwnershipDay => {
	const rows =
		rawRows.length > 0 && "snapshotDate" in rawRows[0]!
			? (rawRows as readonly OwnershipSnapshot[])
			: rawRows.map((row) => normalizeRow(row as MarketOwnershipSnapshotRow));
	const grouped = rowsGroupedByDate(rows);
	const latestAvailable = uniqueSortedDates(rows).at(-1) ?? null;
	const targetDate = date ?? latestAvailable;
	if (!targetDate) {
		return {
			period: "DAILY",
			date: null,
			coverage: emptyCoverage("NO_DATA", [], now),
			risers: [],
			fallers: [],
		};
	}
	const fromDate = addCalendarDays(targetDate, -1);
	const fromRows = rowsForDate(grouped, fromDate);
	const toRows = rowsForDate(grouped, targetDate);
	const status: MarketOwnershipCoverageStatus = !toRows.length
		? "NO_DATA"
		: !fromRows.length
			? "BASELINE_MISSING"
			: "READY";
	const changes =
		status === "READY"
			? changesFor(fromRows, toRows, fromDate, targetDate, normalizedLimit(limit))
			: { risers: [], fallers: [] };
	return {
		period: "DAILY",
		date: targetDate,
		coverage: coverageFor({
			status,
			expectedDates: [fromDate, targetDate],
			rows: [...fromRows, ...toRows],
			fromDate: fromRows.length ? fromDate : null,
			toDate: toRows.length ? targetDate : null,
			now,
		}),
		risers: changes.risers,
		fallers: changes.fallers,
	};
};

const buildRollingOverview = (
	rows: readonly OwnershipSnapshot[],
	limit: number,
	now: Date
): MarketOwnershipOverview => {
	const latestDate = uniqueSortedDates(rows).at(-1) ?? null;
	if (!latestDate) return emptyOverview("ROLLING_7D", "NO_DATA", now);
	const fromDate = addCalendarDays(latestDate, -6);
	const expectedDates = datesBetween(fromDate, latestDate);
	const grouped = rowsGroupedByDate(rows);
	const fromRows = rowsForDate(grouped, fromDate);
	const toRows = rowsForDate(grouped, latestDate);
	let status: MarketOwnershipCoverageStatus = "READY";
	if (!toRows.length) status = "NO_DATA";
	else if (!fromRows.length) status = "BASELINE_MISSING";
	else if (expectedDates.some((date) => !grouped.has(date))) status = "PARTIAL";
	return overviewFromEndpoints({
		period: "ROLLING_7D",
		rows: expectedDates.flatMap((date) => rowsForDate(grouped, date)),
		fromRows,
		toRows,
		fromDate: fromRows.length ? fromDate : null,
		toDate: toRows.length ? latestDate : null,
		expectedDates,
		status,
		limit: normalizedLimit(limit),
		now,
	});
};

const eventDeadlineMs = (event: Pick<Event, "deadlineTime">): number =>
	event.deadlineTime ? Date.parse(event.deadlineTime) : Number.NaN;

const gameweekFor = (
	event: Pick<Event, "id" | "name" | "deadlineTime">
): MarketOwnershipGameweek | null => {
	if (!event.deadlineTime) return null;
	return { id: event.id, name: event.name, deadlineTime: event.deadlineTime };
};

const buildGameweekOverview = (
	rows: readonly OwnershipSnapshot[],
	events: readonly Event[],
	limit: number,
	now: Date
): MarketOwnershipOverview => {
	const latestCapturedAt = maxCapturedAt(rows);
	const latestDate = uniqueSortedDates(rows).at(-1) ?? null;
	if (!latestCapturedAt || !latestDate) return emptyOverview("GAMEWEEK", "NO_DATA", now);
	const latestCapturedAtMs = Date.parse(latestCapturedAt);
	const orderedEvents = [...events]
		.filter((event) => Number.isFinite(eventDeadlineMs(event)))
		.sort((left, right) => left.id - right.id);
	const upcoming = orderedEvents.filter((event) => eventDeadlineTimeMs(event) > latestCapturedAtMs);
	const target = upcoming[0];
	if (!target) return emptyOverview("GAMEWEEK", "NO_UPCOMING_GAMEWEEK", now);
	const previous = orderedEvents.filter((event) => event.id < target.id).at(-1);
	const gameweek = gameweekFor(target);
	if (!previous || !gameweek) {
		return {
			period: "GAMEWEEK",
			gameweek,
			coverage: coverageFor({
				status: "NO_PREVIOUS_GAMEWEEK",
				expectedDates: [latestDate],
				rows: rows.filter((row) => row.snapshotDate === latestDate),
				fromDate: null,
				toDate: latestDate,
				now,
			}),
			risers: [],
			fallers: [],
		};
	}
	const previousDeadlineMs = eventDeadlineMs(previous);
	const rowsBeforeDeadline = rows.filter((row) => Date.parse(row.capturedAt) <= previousDeadlineMs);
	const baselineDate =
		rowsBeforeDeadline
			.map((row) => row.snapshotDate)
			.sort()
			.at(-1) ?? null;
	const fromRows = rowsBeforeDeadline.filter((row) => row.snapshotDate === baselineDate);
	const rowsAfterDeadline = rows.filter((row) => Date.parse(row.capturedAt) > previousDeadlineMs);
	const toDate =
		rowsAfterDeadline
			.map((row) => row.snapshotDate)
			.sort()
			.at(-1) ?? null;
	const toRows = rowsAfterDeadline.filter((row) => row.snapshotDate === toDate);
	const expectedDates = baselineDate && toDate ? datesBetween(baselineDate, toDate) : [latestDate];
	const relevantRows = expectedDates.flatMap((date) =>
		rows.filter((row) => row.snapshotDate === date)
	);
	let status: MarketOwnershipCoverageStatus = "READY";
	if (!toRows.length) status = "NO_DATA";
	else if (!fromRows.length) status = "BASELINE_MISSING";
	else if (expectedDates.some((date) => !relevantRows.some((row) => row.snapshotDate === date))) {
		status = "PARTIAL";
	}
	return overviewFromEndpoints({
		period: "GAMEWEEK",
		gameweek,
		rows: relevantRows,
		fromRows,
		toRows,
		fromDate: fromRows.length && baselineDate ? baselineDate : null,
		toDate: toRows.length && toDate ? toDate : null,
		expectedDates,
		status,
		limit: normalizedLimit(limit),
		now,
	});
};

const eventDeadlineTimeMs = (event: Pick<Event, "deadlineTime">): number => eventDeadlineMs(event);

export const buildMarketOwnershipOverview = (
	rawRows: readonly MarketOwnershipSnapshotRow[] | readonly OwnershipSnapshot[],
	period: MarketOwnershipPeriod,
	limit = DEFAULT_LIMIT,
	events: readonly Event[] = [],
	now = new Date()
): MarketOwnershipOverview => {
	const rows =
		rawRows.length > 0 && "snapshotDate" in rawRows[0]!
			? (rawRows as readonly OwnershipSnapshot[])
			: rawRows.map((row) => normalizeRow(row as MarketOwnershipSnapshotRow));
	switch (period) {
		case "DAILY": {
			const day = buildMarketOwnershipDay(rows, null, limit, now);
			return {
				period: "DAILY",
				gameweek: null,
				coverage: day.coverage,
				risers: day.risers,
				fallers: day.fallers,
			};
		}
		case "ROLLING_7D":
			return buildRollingOverview(rows, limit, now);
		case "GAMEWEEK":
			return buildGameweekOverview(rows, events, normalizedLimit(limit), now);
	}
};

const rowsMemo = new WeakMap<object, Promise<OwnershipSnapshot[]>>();

const loadRows = async (
	context: GraphQLContext,
	queryExecutor?: QueryExecutor
): Promise<OwnershipSnapshot[]> => {
	const requestScope = context.requestScope ?? context;
	const existing = rowsMemo.get(requestScope);
	if (existing) return existing;
	const load = (async (): Promise<OwnershipSnapshot[]> => {
		const revision = context.marketRevision ?? context.dataRevision ?? "core-postgres";
		const cacheKey = gqlCacheKey(context, "market-ownership:v3:rows", revision);
		const cached = await readJsonQueryCache(context, cacheKey, decodeRows);
		if (cached) return cached;
		const executor = queryExecutor ?? context.database;
		const result = await executor.query(OWNERSHIP_QUERY, [
			context.currentSeason.seasonId,
			OWNERSHIP_LOOKBACK_DAYS,
		]);
		const compact = result.rows[0] as { ownership_rows?: unknown } | undefined;
		const decoded = decodeRows(compact?.ownership_rows ?? result.rows);
		if (!decoded) throw new Error("Invalid market ownership query result");
		await writeJsonQueryCache(
			context,
			cacheKey,
			decoded,
			context.marketRevision ? MARKET_REVISIONED_TTL_SECONDS : QUERY_CACHE_TTL_SECONDS.MARKET
		);
		return decoded;
	})();
	rowsMemo.set(requestScope, load);
	try {
		return await load;
	} catch (error) {
		if (rowsMemo.get(requestScope) === load) rowsMemo.delete(requestScope);
		throw error;
	}
};

const dateInput = (date: Date | null): string | null => {
	if (date === null) return null;
	if (Number.isNaN(date.getTime())) throw new Error("Invalid market ownership date");
	return date.toISOString().slice(0, 10);
};

export const createMarketOwnershipRepository = (
	queryExecutor?: QueryExecutor
): MarketOwnershipRepository => ({
	async getOverview(
		context: GraphQLContext,
		period: MarketOwnershipPeriod,
		limit: number
	): Promise<MarketOwnershipOverview> {
		const rows = await loadRows(context, queryExecutor);
		const events =
			period === "GAMEWEEK" ? await eventsService.listEvents(context, null, 50, 0) : [];
		return buildMarketOwnershipOverview(rows, period, limit, events);
	},
	async getDay(
		context: GraphQLContext,
		date: Date | null,
		limit: number
	): Promise<MarketOwnershipDay> {
		const rows = await loadRows(context, queryExecutor);
		return buildMarketOwnershipDay(rows, dateInput(date), limit);
	},
});

export const marketOwnershipRepository = createMarketOwnershipRepository();
