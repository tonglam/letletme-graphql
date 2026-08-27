import type { GraphQLContext } from "../../graphql/context";
import type { DataSqlContractProbe } from "../../contracts/data-sql-contract";
import { isPlainRecord as isRecord } from "../../contracts/guards";
import { gqlCacheKey } from "../../infra/cache-key";
import {
	QUERY_CACHE_TTL_SECONDS,
	readJsonQueryCache,
	writeJsonQueryCache,
} from "../../infra/query-cache";
import { getMarketSnapshotContext, type MarketSnapshotSource } from "../market/context";
import type {
	MarketAvailabilityUpdate,
	MarketPlayer,
	MarketPosition,
	MarketPriceChange,
} from "../market/repository";
import type { MarketOwnershipChange, MarketOwnershipDay } from "../market/ownership-repository";
import { measureRequestStage } from "../../http/request-timing";

const HOME_MARKET_LOOKBACK_DAYS = 7;
const HOME_MARKET_LIMIT = 5;
const HOME_AVAILABILITY_QUERY_LIMIT = 20;

export type HomeMarketSectionState = "AVAILABLE" | "EMPTY" | "UNAVAILABLE";

export type HomeMarketDesk = {
	revision: string;
	/** The desk is complete only when its request pin came from a verified Data publication. */
	source: MarketSnapshotSource | null;
	capturedAt: string | null;
	ownershipState: HomeMarketSectionState;
	ownership: MarketOwnershipDay | null;
	priceChangesState: HomeMarketSectionState;
	priceChanges: MarketPriceChange[];
	availabilityState: HomeMarketSectionState;
	availabilityUpdates: MarketAvailabilityUpdate[];
};

type QueryExecutor = {
	query(sql: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
};

type HomeMarketPlayerRow = {
	element_id: number | string;
	player_code: number | string;
	web_name: string;
	team_id: number | string;
	team_name: string;
	team_short_name: string;
	element_type: number | string;
	position: string;
	price: number | string;
	selected_by_percent: number | string;
};

type HomeOwnershipRow = HomeMarketPlayerRow & {
	from_selected_by_percent: number | string;
	to_selected_by_percent: number | string;
	change_percentage_points: number | string;
	from_date: string | Date;
	to_date: string | Date;
	captured_at: string | Date;
	direction: "RISE" | "FALL";
};

type HomePriceChangeRow = HomeMarketPlayerRow & {
	change_date: string | Date;
	old_price: number | string;
	new_price: number | string;
	change: number | string;
	direction: "RISE" | "FALL";
};

type HomeAvailabilityRow = HomeMarketPlayerRow & {
	status: string;
	previous_status: string | null;
	news: string;
	news_added: string | Date | null;
	observed_date: string | Date;
	chance_of_playing_this_round: number | null;
	chance_of_playing_next_round: number | null;
};

export const HOME_MARKET_OWNERSHIP_SQL = `
	WITH bounded AS (
		SELECT
			snapshot_date::text AS snapshot_date,
			captured_at,
			element_id,
			player_code,
			web_name,
			team_id,
			team_name,
			team_short_name,
			element_type,
			position,
			price,
			selected_by_percent
		FROM fpl.player_market_snapshots
		WHERE season_id = $1
			AND snapshot_date BETWEEN ($2::date - ($4::integer + 1)) AND $2::date
			AND (
				snapshot_date < $2::date
				OR (snapshot_date = $2::date AND captured_at <= $3::timestamptz)
			)
	), daily AS (
		SELECT DISTINCT ON (element_id, snapshot_date) *
		FROM bounded
		ORDER BY element_id, snapshot_date, captured_at DESC
	), latest_date AS (
		SELECT MAX(snapshot_date::date) AS snapshot_date
		FROM daily
	), latest AS (
		SELECT daily.*
		FROM daily
		CROSS JOIN latest_date
		WHERE daily.snapshot_date::date = latest_date.snapshot_date
	), previous AS (
		SELECT daily.*
		FROM daily
		CROSS JOIN latest_date
		WHERE daily.snapshot_date::date = latest_date.snapshot_date - 1
	), changes AS (
		SELECT
			latest.*,
			previous.selected_by_percent AS from_selected_by_percent,
			latest.selected_by_percent AS to_selected_by_percent,
			latest.selected_by_percent - previous.selected_by_percent AS change_percentage_points,
			previous.snapshot_date AS from_date,
			latest.snapshot_date AS to_date,
			CASE
				WHEN latest.selected_by_percent > previous.selected_by_percent THEN 'RISE'
				ELSE 'FALL'
			END AS direction
		FROM latest
		JOIN previous USING (element_id)
		WHERE latest.selected_by_percent <> previous.selected_by_percent
	), ranked AS (
		SELECT
			changes.*,
			ROW_NUMBER() OVER (
				PARTITION BY direction
				ORDER BY ABS(change_percentage_points) DESC, element_id ASC
			) AS direction_rank
		FROM changes
	)
	SELECT
		element_id,
		player_code,
		web_name,
		team_id,
		team_name,
		team_short_name,
		element_type,
		position,
		price,
		to_selected_by_percent AS selected_by_percent,
		from_selected_by_percent,
		to_selected_by_percent,
		change_percentage_points,
		from_date,
		to_date,
		captured_at,
		direction
	FROM ranked
	WHERE direction_rank <= $5::integer
	ORDER BY direction, direction_rank
`;

export const HOME_MARKET_PRICE_CHANGES_SQL = `
	WITH bounded AS (
		SELECT
			snapshot_date::text AS snapshot_date,
			captured_at,
			element_id,
			player_code,
			web_name,
			team_id,
			team_name,
			team_short_name,
			element_type,
			position,
			price,
			selected_by_percent
		FROM fpl.player_market_snapshots
		WHERE season_id = $1
			AND snapshot_date BETWEEN ($2::date - ($4::integer + 1)) AND $2::date
			AND (
				snapshot_date < $2::date
				OR (snapshot_date = $2::date AND captured_at <= $3::timestamptz)
			)
	), daily AS (
		SELECT DISTINCT ON (element_id, snapshot_date) *
		FROM bounded
		ORDER BY element_id, snapshot_date, captured_at DESC
	), ordered AS (
		SELECT
			daily.*,
			LAG(price) OVER (
				PARTITION BY element_id
				ORDER BY snapshot_date::date ASC
			) AS old_price
		FROM daily
	), changes AS (
		SELECT
			ordered.*,
			price - old_price AS change,
			CASE WHEN price > old_price THEN 'RISE' ELSE 'FALL' END AS direction
		FROM ordered
		WHERE old_price IS NOT NULL
			AND price <> old_price
	), latest_change AS (
		SELECT MAX(snapshot_date::date) AS change_date
		FROM changes
	), ranked AS (
		SELECT
			changes.*,
			ROW_NUMBER() OVER (
				PARTITION BY direction
				ORDER BY ABS(change) DESC, element_id ASC
			) AS direction_rank
		FROM changes
		CROSS JOIN latest_change
		WHERE changes.snapshot_date::date = latest_change.change_date
	)
	SELECT
		element_id,
		player_code,
		web_name,
		team_id,
		team_name,
		team_short_name,
		element_type,
		position,
		price,
		selected_by_percent,
		snapshot_date AS change_date,
		old_price,
		price AS new_price,
		change,
		direction
	FROM ranked
	WHERE direction_rank <= $5::integer
	ORDER BY direction, direction_rank
`;

export const HOME_MARKET_AVAILABILITY_SQL = `
	WITH bounded AS (
		SELECT
			snapshot_date::text AS snapshot_date,
			captured_at,
			element_id,
			player_code,
			web_name,
			team_id,
			team_name,
			team_short_name,
			element_type,
			position,
			price,
			selected_by_percent,
			status,
			news,
			news_added,
			chance_of_playing_this_round,
			chance_of_playing_next_round
		FROM fpl.player_market_snapshots
		WHERE season_id = $1
			AND snapshot_date BETWEEN ($2::date - ($4::integer + 1)) AND $2::date
			AND (
				snapshot_date < $2::date
				OR (snapshot_date = $2::date AND captured_at <= $3::timestamptz)
			)
	), daily AS (
		SELECT DISTINCT ON (element_id, snapshot_date) *
		FROM bounded
		ORDER BY element_id, snapshot_date, captured_at DESC
	), annotated AS (
		SELECT
			daily.*,
			LAG(status) OVER player_days AS previous_status,
			LAG(news) OVER player_days AS previous_news,
			LAG(chance_of_playing_this_round) OVER player_days AS previous_chance_of_playing_this_round,
			LAG(chance_of_playing_next_round) OVER player_days AS previous_chance_of_playing_next_round
		FROM daily
		WINDOW player_days AS (
			PARTITION BY element_id
			ORDER BY snapshot_date::date ASC
		)
	), candidates AS (
		SELECT
			annotated.*,
			annotated.snapshot_date AS observed_date
		FROM annotated
		WHERE annotated.snapshot_date::date >= ($2::date - $4::integer)
			AND (
				(
					previous_status IS NOT NULL
					AND (
						status IS DISTINCT FROM previous_status
						OR news IS DISTINCT FROM previous_news
						OR chance_of_playing_this_round IS DISTINCT FROM previous_chance_of_playing_this_round
						OR chance_of_playing_next_round IS DISTINCT FROM previous_chance_of_playing_next_round
					)
				)
				OR (
					news IS NOT NULL
					AND news <> ''
					AND news_added IS NOT NULL
					AND news_added >= (($2::date - $4::integer)::timestamp)
					AND news_added < (($2::date + 1)::timestamp)
				)
			)
	), ranked AS (
		SELECT
			candidates.*,
			ROW_NUMBER() OVER (
				ORDER BY observed_date DESC, selected_by_percent DESC, element_id ASC
			) AS candidate_rank
		FROM candidates
	)
	SELECT
		element_id,
		player_code,
		web_name,
		team_id,
		team_name,
		team_short_name,
		element_type,
		position,
		price,
		selected_by_percent,
		status,
		previous_status,
		news,
		news_added,
		observed_date,
		chance_of_playing_this_round,
		chance_of_playing_next_round
	FROM ranked
	WHERE candidate_rank <= $5::integer
	ORDER BY observed_date DESC, selected_by_percent DESC, element_id ASC
`;

const HOME_MARKET_CONTRACT_VALUES = [
	2026,
	"2025-08-28",
	"2025-08-28T00:00:00.000Z",
	HOME_MARKET_LOOKBACK_DAYS,
	HOME_MARKET_LIMIT,
] as const;

export const HOME_MARKET_DATA_SQL_CONTRACT: readonly DataSqlContractProbe[] = [
	{
		name: "home-market.ownership",
		sql: HOME_MARKET_OWNERSHIP_SQL,
		values: HOME_MARKET_CONTRACT_VALUES,
	},
	{
		name: "home-market.price-changes",
		sql: HOME_MARKET_PRICE_CHANGES_SQL,
		values: HOME_MARKET_CONTRACT_VALUES,
	},
	{
		name: "home-market.availability",
		sql: HOME_MARKET_AVAILABILITY_SQL,
		values: [...HOME_MARKET_CONTRACT_VALUES.slice(0, 4), HOME_AVAILABILITY_QUERY_LIMIT],
	},
];
const numberValue = (value: unknown, field: string): number => {
	const parsed = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(parsed)) throw new Error(`Invalid Home market ${field}`);
	return parsed;
};

const integerValue = (value: unknown, field: string): number => {
	const parsed = numberValue(value, field);
	if (!Number.isSafeInteger(parsed)) throw new Error(`Invalid Home market ${field}`);
	return parsed;
};

const dateValue = (value: string | Date, field: string): string => {
	if (value instanceof Date) {
		if (Number.isNaN(value.getTime())) throw new Error(`Invalid Home market ${field}`);
		return value.toISOString().slice(0, 10);
	}
	const match = /^(\d{4}-\d{2}-\d{2})/.exec(value);
	if (!match) throw new Error(`Invalid Home market ${field}`);
	return match[1];
};

const timestampValue = (value: string | Date | null, field: string): string | null => {
	if (value === null) return null;
	const parsed = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(parsed.getTime())) throw new Error(`Invalid Home market ${field}`);
	return parsed.toISOString();
};

const positionValue = (value: unknown, playerId: number): MarketPosition => {
	switch (String(value).toUpperCase()) {
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
			throw new Error(`Invalid Home market position for player ${playerId}`);
	}
};

const playerValue = (row: HomeMarketPlayerRow): MarketPlayer => {
	const playerId = integerValue(row.element_id, "element_id");
	return {
		playerId,
		playerCode: integerValue(row.player_code, "player_code"),
		webName: String(row.web_name),
		teamId: integerValue(row.team_id, "team_id"),
		teamName: String(row.team_name),
		teamShortName: String(row.team_short_name),
		position: positionValue(row.position, playerId),
		price: integerValue(row.price, "price"),
		selectedByPercent: numberValue(row.selected_by_percent, "selected_by_percent"),
	};
};

const mapOwnership = (rows: readonly HomeOwnershipRow[]): MarketOwnershipDay | null => {
	if (rows.length === 0) return null;
	const first = rows[0]!;
	const fromDate = dateValue(first.from_date, "from_date");
	const toDate = dateValue(first.to_date, "to_date");
	const changes = rows.map((row) => ({
		player: playerValue(row),
		fromSelectedByPercent: numberValue(row.from_selected_by_percent, "from_selected_by_percent"),
		toSelectedByPercent: numberValue(row.to_selected_by_percent, "to_selected_by_percent"),
		changePercentagePoints: numberValue(row.change_percentage_points, "change_percentage_points"),
		fromDate,
		toDate,
	})) satisfies MarketOwnershipChange[];
	const capturedAt = timestampValue(first.captured_at, "captured_at");
	const coverage = {
		status: "READY" as const,
		requestedDays: 2,
		observedDays: 2,
		firstDate: fromDate,
		latestDate: toDate,
		fromDate,
		toDate,
		missingDates: [],
		capturedAt,
		complete: true,
		stale: false,
	};
	return {
		period: "DAILY",
		date: toDate,
		coverage,
		risers: changes.filter((change) => change.changePercentagePoints > 0),
		fallers: changes.filter((change) => change.changePercentagePoints < 0),
	};
};

const mapPriceChanges = (rows: readonly HomePriceChangeRow[]): MarketPriceChange[] =>
	rows.map((row) => ({
		player: playerValue(row),
		changeDate: dateValue(row.change_date, "change_date"),
		oldPrice: integerValue(row.old_price, "old_price"),
		newPrice: integerValue(row.new_price, "new_price"),
		change: integerValue(row.change, "change"),
		direction: row.direction,
	}));

const mapAvailability = (rows: readonly HomeAvailabilityRow[]): MarketAvailabilityUpdate[] =>
	rows.map((row) => ({
		player: playerValue(row),
		status: String(row.status),
		previousStatus: row.previous_status === null ? null : String(row.previous_status),
		news: String(row.news ?? ""),
		newsAdded: timestampValue(row.news_added, "news_added"),
		observedDate: dateValue(row.observed_date, "observed_date"),
		chanceOfPlayingThisRound:
			row.chance_of_playing_this_round === null
				? null
				: integerValue(row.chance_of_playing_this_round, "chance_of_playing_this_round"),
		chanceOfPlayingNextRound:
			row.chance_of_playing_next_round === null
				? null
				: integerValue(row.chance_of_playing_next_round, "chance_of_playing_next_round"),
	}));

const selectHomeAvailability = (
	updates: readonly MarketAvailabilityUpdate[]
): MarketAvailabilityUpdate[] => {
	const preferred = updates.filter((update) => update.player.selectedByPercent >= 1);
	if (preferred.length >= HOME_MARKET_LIMIT) {
		return preferred.slice(0, HOME_MARKET_LIMIT);
	}
	const preferredSet = new Set(preferred);
	return [...preferred, ...updates.filter((update) => !preferredSet.has(update))].slice(
		0,
		HOME_MARKET_LIMIT
	);
};

const stateFor = (rows: readonly unknown[]): HomeMarketSectionState =>
	rows.length > 0 ? "AVAILABLE" : "EMPTY";

const unavailableDesk = (
	revision = "unavailable",
	capturedAt: string | null = null
): HomeMarketDesk => ({
	revision,
	source: null,
	capturedAt,
	ownershipState: "UNAVAILABLE",
	ownership: null,
	priceChangesState: "UNAVAILABLE",
	priceChanges: [],
	availabilityState: "UNAVAILABLE",
	availabilityUpdates: [],
});

const isState = (value: unknown): value is HomeMarketSectionState =>
	value === "AVAILABLE" || value === "EMPTY" || value === "UNAVAILABLE";

const isHomeMarketDesk = (value: unknown): value is HomeMarketDesk =>
	isRecord(value) &&
	typeof value.revision === "string" &&
	(value.source === null ||
		value.source === "DATA_PUBLICATION" ||
		value.source === "POSTGRES_FALLBACK") &&
	(value.capturedAt === null || typeof value.capturedAt === "string") &&
	isState(value.ownershipState) &&
	(value.ownership === null || isRecord(value.ownership)) &&
	isState(value.priceChangesState) &&
	Array.isArray(value.priceChanges) &&
	isState(value.availabilityState) &&
	Array.isArray(value.availabilityUpdates);

const homeMarketFlights = new WeakMap<object, Map<string, Promise<HomeMarketDesk>>>();

const runHomeMarketFlight = (
	context: GraphQLContext,
	cacheKey: string,
	load: () => Promise<HomeMarketDesk>
): Promise<HomeMarketDesk> => {
	const identity = context.redis as object;
	let flights = homeMarketFlights.get(identity);
	if (!flights) {
		flights = new Map();
		homeMarketFlights.set(identity, flights);
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

const queryRows = async <T>(
	context: GraphQLContext,
	executor: QueryExecutor,
	sql: string,
	values: unknown[]
): Promise<T[]> => {
	const result = await executor.query(sql, values);
	return result.rows as T[];
};

export type HomeMarketRepository = {
	getDesk(context: GraphQLContext): Promise<HomeMarketDesk>;
};

export const createHomeMarketRepository = (
	queryExecutor?: QueryExecutor
): HomeMarketRepository => ({
	async getDesk(context: GraphQLContext): Promise<HomeMarketDesk> {
		const snapshotContext = await getMarketSnapshotContext(context).catch((error) => {
			context.logger.warn({ err: error }, "Home market snapshot context unavailable");
			return null;
		});
		if (!snapshotContext) return unavailableDesk();

		const revision = `${context.dataRevision ?? "core-postgres"}.${snapshotContext.revision}`;
		const cacheKey = gqlCacheKey(context, "home-market-desk:v1", revision);
		return runHomeMarketFlight(context, cacheKey, async () => {
			const cached = await readJsonQueryCache(context, cacheKey, (value) =>
				isHomeMarketDesk(value) ? value : null
			);
			if (cached) return cached;

			const startedAt = performance.now();
			const values = [
				context.currentSeason.seasonId,
				snapshotContext.snapshotDate,
				snapshotContext.capturedAt,
				HOME_MARKET_LOOKBACK_DAYS,
				HOME_MARKET_LIMIT,
			];
			const executor = queryExecutor ?? context.database;
			const [ownershipResult, priceResult, availabilityResult] = await Promise.allSettled([
				measureRequestStage(context.requestTiming, "home.market.ownership", () =>
					queryRows<HomeOwnershipRow>(context, executor, HOME_MARKET_OWNERSHIP_SQL, values)
				),
				measureRequestStage(context.requestTiming, "home.market.priceChanges", () =>
					queryRows<HomePriceChangeRow>(context, executor, HOME_MARKET_PRICE_CHANGES_SQL, values)
				),
				measureRequestStage(context.requestTiming, "home.market.availability", () =>
					queryRows<HomeAvailabilityRow>(context, executor, HOME_MARKET_AVAILABILITY_SQL, [
						...values.slice(0, 4),
						HOME_AVAILABILITY_QUERY_LIMIT,
					])
				),
			]);

			const ownershipRows = ownershipResult.status === "fulfilled" ? ownershipResult.value : [];
			const priceRows = priceResult.status === "fulfilled" ? priceResult.value : [];
			const availabilityRows =
				availabilityResult.status === "fulfilled" ? availabilityResult.value : [];
			if (ownershipResult.status === "rejected") {
				context.logger.warn(
					{ err: ownershipResult.reason },
					"Home market ownership query unavailable"
				);
			}
			if (priceResult.status === "rejected") {
				context.logger.warn({ err: priceResult.reason }, "Home market price query unavailable");
			}
			if (availabilityResult.status === "rejected") {
				context.logger.warn(
					{ err: availabilityResult.reason },
					"Home market availability query unavailable"
				);
			}

			const desk: HomeMarketDesk = {
				revision,
				source: snapshotContext.source,
				capturedAt: snapshotContext.capturedAt,
				ownershipState:
					ownershipResult.status === "rejected" ? "UNAVAILABLE" : stateFor(ownershipRows),
				ownership: ownershipResult.status === "rejected" ? null : mapOwnership(ownershipRows),
				priceChangesState: priceResult.status === "rejected" ? "UNAVAILABLE" : stateFor(priceRows),
				priceChanges: priceResult.status === "rejected" ? [] : mapPriceChanges(priceRows),
				availabilityState:
					availabilityResult.status === "rejected" ? "UNAVAILABLE" : stateFor(availabilityRows),
				availabilityUpdates:
					availabilityResult.status === "rejected"
						? []
						: selectHomeAvailability(mapAvailability(availabilityRows)),
			};

			const cacheable =
				desk.ownershipState !== "UNAVAILABLE" &&
				desk.priceChangesState !== "UNAVAILABLE" &&
				desk.availabilityState !== "UNAVAILABLE";
			if (cacheable) {
				await writeJsonQueryCache(
					context,
					cacheKey,
					desk,
					snapshotContext.cacheTtlSeconds ?? QUERY_CACHE_TTL_SECONDS.MARKET
				);
			}
			context.logger.info(
				{
					requestId: context.requestId,
					operationName: context.operationName,
					revision,
					ownershipState: desk.ownershipState,
					priceChangesState: desk.priceChangesState,
					availabilityState: desk.availabilityState,
					ownershipRows: ownershipRows.length,
					priceRows: priceRows.length,
					availabilityRows: availabilityRows.length,
					cacheable,
					totalDurationMs: Number((performance.now() - startedAt).toFixed(2)),
				},
				"Home market desk loaded"
			);
			return desk;
		});
	},
});

export const homeMarketRepository = createHomeMarketRepository();
