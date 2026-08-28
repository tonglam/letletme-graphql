import type { GraphQLContext } from "../../graphql/context";
import type { DataSqlContractProbe } from "../../contracts/data-sql-contract";
import { isPlainRecord as isRecord } from "../../contracts/guards";
import { gqlCacheKey } from "../../infra/cache-key";
import {
	getCoreEventSnapshot,
	getCoreFixtureSnapshot,
	type CoreFixtureData,
} from "../../infra/data-snapshot";
import { getCurrentEvent, type CurrentEventCache } from "../../infra/event";
import { QUERY_CACHE_TTL_SECONDS, writeQueryCache } from "../../infra/query-cache";
import { metrics } from "../../infra/metrics";
import { playersRepository } from "../players/repository";
import {
	getPlayerSeasonStatsLoadForContext,
	resolvePlayerStatsContext,
	type PlayerSeasonStatsAtEvent,
	type PlayerStatsContext,
} from "../players/season-stats-at-event";

const MARKET_STALE_AFTER_MS = 36 * 60 * 60 * 1000;
const RECENT_GAMEWEEK_LIMIT = 5;
const UPCOMING_GAMEWEEK_LIMIT = 8;
const NULL_SENTINEL = "__pd:null__";
// Bump the namespace for the hard-cut availability contract. Values written
// by the previous runtime did not carry enough provenance to distinguish a
// mutable recent-gameweek read from an authoritative publication.
const PLAYER_DETAIL_CACHE_VERSION = "v2";

export const PLAYER_DETAIL_HISTORICAL_TEAMS_SQL = `
	SELECT DISTINCT ON (event_id) event_id, team_id
	FROM fpl.player_fixture_stats
	WHERE season_id = $1
	  AND player_code = $2
	  AND event_id = ANY($3::integer[])
	ORDER BY event_id, fixture_id DESC
`;

export const PLAYER_DETAIL_DATA_SQL_CONTRACT: readonly DataSqlContractProbe[] = [
	{
		name: "player-detail.historical-teams",
		sql: PLAYER_DETAIL_HISTORICAL_TEAMS_SQL,
		values: [1, 10_001, [1]],
	},
];

export type PlayerAvailability = {
	status: string;
	news: string;
	newsAdded: string | null;
	observedDate: string;
	capturedAt: string;
	chanceOfPlayingThisRound: number | null;
	chanceOfPlayingNextRound: number | null;
	stale: boolean;
};

export type PlayerDataState =
	"READY" | "EMPTY" | "STALE" | "FALLBACK" | "UNAVAILABLE" | "NOT_APPLICABLE";

export type PlayerDataSectionAvailability = {
	state: PlayerDataState;
	reasonCode: string | null;
	revision: string | null;
	sourceCheckedAt: string | null;
};

export type PlayerDetailDataAvailability = {
	isFullyAuthoritative: boolean;
	seasonStats: PlayerDataSectionAvailability;
	market: PlayerDataSectionAvailability;
	historicalTeam: PlayerDataSectionAvailability;
	fixtures: PlayerDataSectionAvailability;
	recentGameweeks: PlayerDataSectionAvailability;
};

export type PlayerRecentOpponent = {
	teamShortName: string;
	wasHome: boolean;
};

export type PlayerRecentGameweek = {
	eventId: number;
	provisional: boolean;
	totalPoints: number;
	minutes: number | null;
	started: boolean | null;
	goalsScored: number | null;
	assists: number | null;
	cleanSheets: number | null;
	saves: number | null;
	bonus: number | null;
	bps: number | null;
	opponents: PlayerRecentOpponent[];
};

export type PlayerFixture = {
	id: number;
	event: number;
	againstTeamShortName: string;
	wasHome: boolean;
	finished: boolean;
	kickoffTime: string | null;
	score: string | null;
	difficulty: number;
	bgw: boolean;
};

export type PlayerDetail = {
	id: number;
	webName: string;
	teamShortName: string;
	elementType: number;
	elementTypeName: string;
	price: number;
	startPrice: number;
	statsContext: PlayerStatsContext;
	injuryAvailability: PlayerAvailability | null;
	dataAvailability: PlayerDetailDataAvailability;
	totalPoints: number | null;
	selectedByPercent: number | null;
	form: number | null;
	seasonTransfersIn: number | null;
	seasonTransfersOut: number | null;
	transfersInEvent: number | null;
	transfersOutEvent: number | null;
	eventPoints: number | null;
	minutes: number | null;
	starts: number | null;
	goalsScored: number | null;
	assists: number | null;
	cleanSheets: number | null;
	goalsConceded: number | null;
	ownGoals: number | null;
	penaltiesSaved: number | null;
	yellowCards: number | null;
	redCards: number | null;
	saves: number | null;
	bonus: number | null;
	bps: number | null;
	expectedGoals: number | null;
	expectedAssists: number | null;
	expectedGoalInvolvements: number | null;
	expectedGoalsConceded: number | null;
	influence: number | null;
	creativity: number | null;
	threat: number | null;
	ictIndex: number | null;
	recentGameweeks: PlayerRecentGameweek[];
	fixtures: PlayerFixture[];
};

type LatestMarketSnapshot = {
	selectedByPercent: number;
	seasonTransfersIn: number;
	seasonTransfersOut: number;
	transfersInEvent: number;
	transfersOutEvent: number;
	availability: PlayerAvailability;
};

type MarketSnapshotRow = {
	snapshot_date: string;
	captured_at: string | Date;
	selected_by_percent: string | number;
	transfers_in: number;
	transfers_out: number;
	transfers_in_event: number;
	transfers_out_event: number;
	status: string;
	news: string;
	news_added: string | Date | null;
	chance_of_playing_this_round: number | null;
	chance_of_playing_next_round: number | null;
};

type RecentGameweekRow = {
	event_id: number;
	total_points: number;
	minutes: number | null;
	starts: boolean | null;
	goals_scored: number | null;
	assists: number | null;
	clean_sheets: number | null;
	saves: number | null;
	bonus: number | null;
	bps: number | null;
};

type ResolvedEventState = {
	id: number;
	finished: boolean;
};

type SectionResult<T> = {
	value: T;
	availability: PlayerDataSectionAvailability;
};

const section = <T>(
	value: T,
	state: PlayerDataState,
	reasonCode: string | null = null,
	revision: string | null = null,
	sourceCheckedAt: string | null = null
): SectionResult<T> => ({
	value,
	availability: { state, reasonCode, revision, sourceCheckedAt },
});

const isAuthoritativeSection = (value: PlayerDataSectionAvailability): boolean =>
	value.state === "READY" || value.state === "EMPTY" || value.state === "NOT_APPLICABLE";

const recordDataAvailability = (detail: PlayerDetail): void => {
	for (const [sectionName, sectionAvailability] of Object.entries(detail.dataAvailability)) {
		if (sectionName === "isFullyAuthoritative") continue;
		metrics.playerDetailDataAvailability
			.labels(sectionName, (sectionAvailability as PlayerDataSectionAvailability).state)
			.inc();
	}
};

const PLAYER_DATA_STATES: ReadonlySet<PlayerDataState> = new Set([
	"READY",
	"EMPTY",
	"STALE",
	"FALLBACK",
	"UNAVAILABLE",
	"NOT_APPLICABLE",
]);

const isSectionAvailability = (value: unknown): value is PlayerDataSectionAvailability =>
	isRecord(value) &&
	typeof value.state === "string" &&
	PLAYER_DATA_STATES.has(value.state as PlayerDataState) &&
	(value.reasonCode === null || typeof value.reasonCode === "string") &&
	(value.revision === null || typeof value.revision === "string") &&
	(value.sourceCheckedAt === null || typeof value.sourceCheckedAt === "string");

const isDataAvailability = (value: unknown): value is PlayerDetailDataAvailability =>
	isRecord(value) &&
	typeof value.isFullyAuthoritative === "boolean" &&
	(() => {
		const sections = [
			value.seasonStats,
			value.market,
			value.historicalTeam,
			value.fixtures,
			value.recentGameweeks,
		];
		if (!sections.every(isSectionAvailability)) return false;
		return (
			value.isFullyAuthoritative ===
			sections.every((item) => isAuthoritativeSection(item as PlayerDataSectionAvailability))
		);
	})();

const isPlayerDetail = (value: unknown): value is PlayerDetail =>
	isRecord(value) &&
	typeof value.id === "number" &&
	typeof value.webName === "string" &&
	isRecord(value.statsContext) &&
	isDataAvailability(value.dataAvailability) &&
	!Object.prototype.hasOwnProperty.call(value, "availability") &&
	Array.isArray(value.recentGameweeks) &&
	Array.isArray(value.fixtures);

const hasSameStatsAuthority = (cached: PlayerStatsContext, current: PlayerStatsContext): boolean =>
	cached.scope === current.scope &&
	cached.season === current.season &&
	cached.asOfEventId === current.asOfEventId &&
	cached.status === current.status &&
	cached.revision === current.revision &&
	cached.sourceCheckedAt === current.sourceCheckedAt &&
	cached.publishedAt === current.publishedAt &&
	cached.rowCount === current.rowCount &&
	cached.expectedRowCount === current.expectedRowCount;

const asNullableNumber = (value: unknown): number | null => {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : null;
	}
	return null;
};

const toIsoTimestamp = (value: string | Date | null): string | null => {
	if (value === null) return null;
	const parsed = value instanceof Date ? value : new Date(value);
	return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
};

const toCalendarDate = (value: string): string | null => {
	const match = /^(\d{4}-\d{2}-\d{2})/.exec(value);
	return match?.[1] ?? null;
};

const elementTypeToName = (type: number): string => {
	switch (type) {
		case 1:
			return "GOALKEEPER";
		case 2:
			return "DEFENDER";
		case 3:
			return "MIDFIELDER";
		case 4:
			return "FORWARD";
		default:
			return "";
	}
};

export const playerDetailCacheKey = (playerId: number, eventId: number): string =>
	`player-detail:${PLAYER_DETAIL_CACHE_VERSION}:${playerId}:${eventId}`;

const playerDetailCacheReadMemo = new WeakMap<
	object,
	Map<string, PlayerDetail | null | undefined>
>();

const requestPlayerDetailCacheMemo = (
	context: GraphQLContext
): Map<string, PlayerDetail | null | undefined> => {
	const scope = context.requestScope ?? context;
	let memo = playerDetailCacheReadMemo.get(scope);
	if (!memo) {
		memo = new Map();
		playerDetailCacheReadMemo.set(scope, memo);
	}
	return memo;
};

const parsePlayerDetailCacheValue = (
	raw: string | null
): PlayerDetail | null | undefined | "malformed" | "expired" => {
	if (raw === null) return undefined;
	if (raw === NULL_SENTINEL) return null;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!isPlayerDetail(parsed)) return "malformed";
		// Non-authoritative results are request-local only. Evict any value left
		// by a pre-hard-cut runtime instead of letting degraded evidence regain
		// authority through a shared-cache hit.
		if (!parsed.dataAvailability.isFullyAuthoritative) return "malformed";
		const market = parsed.dataAvailability.market;
		if (market.state === "READY") {
			const checkedAt = market.sourceCheckedAt ? Date.parse(market.sourceCheckedAt) : Number.NaN;
			if (!Number.isFinite(checkedAt) || Date.now() - checkedAt > MARKET_STALE_AFTER_MS) {
				return "expired";
			}
		}
		return parsed;
	} catch {
		return "malformed";
	}
};

async function readPlayerDetailCache(
	context: GraphQLContext,
	key: string
): Promise<PlayerDetail | null | undefined> {
	const memo = requestPlayerDetailCacheMemo(context);
	if (memo.has(key)) return memo.get(key);
	let cached: string | null;
	try {
		cached = await context.redis.get(key);
	} catch (error) {
		context.logger.warn({ err: error, key }, "Failed to read player-detail cache");
		memo.set(key, undefined);
		return undefined;
	}
	const parsed = parsePlayerDetailCacheValue(cached);
	if (parsed !== "malformed" && parsed !== "expired") {
		memo.set(key, parsed);
		return parsed;
	}
	context.logger.warn(
		{ key },
		parsed === "expired" ? "Expired player-detail cache" : "Malformed player-detail cache"
	);
	try {
		await context.redis.del(key);
	} catch (error) {
		context.logger.warn({ err: error, key }, "Failed to evict malformed player-detail cache");
	}
	memo.set(key, undefined);
	return undefined;
}

async function readPlayerDetailCaches(context: GraphQLContext, keys: string[]): Promise<void> {
	const memo = requestPlayerDetailCacheMemo(context);
	const missingKeys = keys.filter((key) => !memo.has(key));
	if (missingKeys.length === 0) return;
	let values: Array<string | null>;
	try {
		values = await context.redis.mget(...missingKeys);
	} catch (error) {
		context.logger.warn(
			{ err: error, keyCount: missingKeys.length },
			"Failed to batch-read player-detail cache"
		);
		for (const key of missingKeys) memo.set(key, undefined);
		return;
	}
	const invalidKeys: string[] = [];
	for (let index = 0; index < missingKeys.length; index += 1) {
		const key = missingKeys[index]!;
		const parsed = parsePlayerDetailCacheValue(values[index] ?? null);
		if (parsed === "malformed" || parsed === "expired") {
			memo.set(key, undefined);
			invalidKeys.push(key);
		} else {
			memo.set(key, parsed);
		}
	}
	await Promise.all(
		invalidKeys.map(async (key) => {
			try {
				await context.redis.del(key);
			} catch (error) {
				context.logger.warn({ err: error, key }, "Failed to evict malformed player-detail cache");
			}
		})
	);
}

async function loadLatestMarketSnapshot(
	context: GraphQLContext,
	playerId: number
): Promise<SectionResult<LatestMarketSnapshot | null>> {
	try {
		const { data, error } = await context.data
			.read("fpl.player_market_snapshots")
			.select(
				"snapshot_date, captured_at, selected_by_percent, transfers_in, transfers_out, transfers_in_event, transfers_out_event, status, news, news_added, chance_of_playing_this_round, chance_of_playing_next_round"
			)
			.eq("element_id", playerId)
			.order("snapshot_date", { ascending: false })
			.order("captured_at", { ascending: false })
			.limit(1);
		if (error) {
			context.logger.warn({ err: error, playerId }, "Failed to load latest player market snapshot");
			return section(null, "UNAVAILABLE", "market_read_failed");
		}
		const row = data?.[0] as MarketSnapshotRow | undefined;
		// An FPL player should have a market row in an authoritative market
		// publication. Treating a missing row as EMPTY would allow core fallback
		// values to enter the shared cache as if the section were complete.
		if (!row) return section(null, "FALLBACK", "market_snapshot_missing");

		const capturedAt = toIsoTimestamp(row.captured_at);
		const observedDate = toCalendarDate(row.snapshot_date);
		const selectedByPercent = asNullableNumber(row.selected_by_percent);
		if (capturedAt === null || observedDate === null || selectedByPercent === null) {
			return section(null, "UNAVAILABLE", "market_snapshot_malformed");
		}

		const value: LatestMarketSnapshot = {
			selectedByPercent,
			seasonTransfersIn: row.transfers_in,
			seasonTransfersOut: row.transfers_out,
			transfersInEvent: row.transfers_in_event,
			transfersOutEvent: row.transfers_out_event,
			availability: {
				status: row.status,
				news: row.news,
				newsAdded: toIsoTimestamp(row.news_added),
				observedDate,
				capturedAt,
				chanceOfPlayingThisRound: row.chance_of_playing_this_round,
				chanceOfPlayingNextRound: row.chance_of_playing_next_round,
				stale: Math.max(Date.now() - Date.parse(capturedAt), 0) > MARKET_STALE_AFTER_MS,
			},
		};
		return section(
			value,
			value.availability.stale ? "STALE" : "READY",
			value.availability.stale ? "market_snapshot_stale" : null,
			`${observedDate}:${capturedAt}`,
			value.availability.capturedAt
		);
	} catch (error) {
		context.logger.warn({ err: error, playerId }, "Failed to load latest player market snapshot");
		return section(null, "UNAVAILABLE", "market_read_failed");
	}
}

async function loadResolvedEventState(
	context: GraphQLContext,
	eventId: number | null
): Promise<ResolvedEventState | null> {
	if (eventId === null) return null;
	const snapshot = await getCoreEventSnapshot(context);
	const event = snapshot.events.find((candidate) => candidate.id === eventId);
	return event ? { id: event.id, finished: event.finished } : null;
}

async function loadHistoricalTeamId(
	context: GraphQLContext,
	season: string,
	playerCode: number,
	eventId: number | null,
	fallbackTeamId: number
): Promise<SectionResult<number>> {
	if (eventId === null)
		return section(fallbackTeamId, "NOT_APPLICABLE", "historical_event_missing");
	try {
		const { data, error } = await context.data
			.read("fpl.player_fixture_stats")
			.select("team_id")
			.eq("season", season)
			.eq("player_code", playerCode)
			.lte("event_id", eventId)
			.order("event_id", { ascending: false })
			.order("fixture_id", { ascending: false })
			.limit(1);
		if (error) {
			context.logger.warn(
				{ err: error, playerCode, eventId },
				"Failed to load historical player team"
			);
			return section(fallbackTeamId, "FALLBACK", "historical_team_read_failed");
		}
		const teamId = asNullableNumber((data?.[0] as { team_id?: unknown } | undefined)?.team_id);
		return teamId !== null && teamId > 0
			? section(teamId, "READY")
			: section(fallbackTeamId, "FALLBACK", "historical_team_missing");
	} catch (error) {
		context.logger.warn(
			{ err: error, playerCode, eventId },
			"Failed to load historical player team"
		);
		return section(fallbackTeamId, "FALLBACK", "historical_team_read_failed");
	}
}

async function loadHistoricalTeamIds(
	context: GraphQLContext,
	playerCode: number,
	eventIds: number[],
	fallbackTeamId: number
): Promise<{ values: Map<number, number>; complete: boolean }> {
	if (eventIds.length === 0) return { values: new Map(), complete: true };
	try {
		const result = await context.database.query<{ event_id: number; team_id: number }>(
			PLAYER_DETAIL_HISTORICAL_TEAMS_SQL,
			[context.currentSeason.seasonId, playerCode, eventIds]
		);
		const values = new Map(
			eventIds.map((eventId) => {
				const row = result.rows.find((candidate) => candidate.event_id === eventId);
				return [eventId, row?.team_id ?? fallbackTeamId] as const;
			})
		);
		return { values, complete: result.rows.length === new Set(eventIds).size };
	} catch (error) {
		context.logger.warn(
			{ err: error, playerCode, eventIds },
			"Failed to batch historical player teams"
		);
		return {
			values: new Map(eventIds.map((eventId) => [eventId, fallbackTeamId] as const)),
			complete: false,
		};
	}
}

const formatFixtureScore = (fixture: CoreFixtureData, wasHome: boolean): string | null => {
	if (fixture.teamHScore === null || fixture.teamAScore === null) return null;
	return wasHome
		? `${fixture.teamHScore}-${fixture.teamAScore}`
		: `${fixture.teamAScore}-${fixture.teamHScore}`;
};

async function loadTeamFixtureDesk(
	context: GraphQLContext,
	teamId: number,
	fromEventId: number
): Promise<
	SectionResult<{
		teamShortName: string;
		fixtures: PlayerFixture[];
	}>
> {
	try {
		const [fixtureSnapshot, eventSnapshot] = await Promise.all([
			getCoreFixtureSnapshot(context),
			getCoreEventSnapshot(context),
		]);
		const teams = new Map(fixtureSnapshot.teams.map((team) => [team.id, team] as const));
		const team = teams.get(teamId);
		if (!team) {
			return section(
				{ teamShortName: "", fixtures: [] },
				"UNAVAILABLE",
				"fixture_team_missing",
				fixtureSnapshot.revision,
				fixtureSnapshot.sourceCheckedAt
			);
		}
		let missingOpponentIdentity = false;
		const mapped = fixtureSnapshot.fixtures
			.filter((fixture) => fixture.teamHId === teamId || fixture.teamAId === teamId)
			.filter((fixture) => fixture.eventId !== null)
			.map((fixture): PlayerFixture => {
				const wasHome = fixture.teamHId === teamId;
				const opponentId = wasHome ? fixture.teamAId : fixture.teamHId;
				const opponent = teams.get(opponentId);
				if (!opponent) missingOpponentIdentity = true;
				return {
					id: fixture.id,
					event: fixture.eventId!,
					againstTeamShortName: opponent?.shortName ?? "",
					wasHome,
					finished: fixture.finished,
					kickoffTime: fixture.kickoffTime,
					score: formatFixtureScore(fixture, wasHome),
					difficulty: (wasHome ? fixture.teamHDifficulty : fixture.teamADifficulty) ?? 0,
					bgw: false,
				};
			});

		const lastEventId = Math.min(38, fromEventId + UPCOMING_GAMEWEEK_LIMIT - 1);
		const eventsWithTeamFixtures = new Set(mapped.map((fixture) => fixture.event));
		const eventsWithAnyFixtures = new Set(
			fixtureSnapshot.fixtures
				.filter((fixture) => fixture.eventId !== null)
				.map((fixture) => fixture.eventId as number)
		);
		const knownEvents = new Set(eventSnapshot.events.map((event) => event.id));

		for (let event = fromEventId; event <= lastEventId; event += 1) {
			if (
				eventsWithTeamFixtures.has(event) ||
				!knownEvents.has(event) ||
				!eventsWithAnyFixtures.has(event)
			)
				continue;
			mapped.push({
				id: -event,
				event,
				againstTeamShortName: "",
				wasHome: false,
				finished: false,
				kickoffTime: null,
				score: null,
				difficulty: 0,
				bgw: true,
			});
		}

		mapped.sort(
			(a, b) =>
				a.event - b.event ||
				(a.kickoffTime ?? "9999").localeCompare(b.kickoffTime ?? "9999") ||
				a.id - b.id
		);
		return section(
			{ teamShortName: team.shortName, fixtures: mapped },
			missingOpponentIdentity ? "FALLBACK" : mapped.length === 0 ? "EMPTY" : "READY",
			missingOpponentIdentity ? "fixture_opponent_missing" : null,
			fixtureSnapshot.revision,
			fixtureSnapshot.sourceCheckedAt
		);
	} catch (error) {
		context.logger.warn({ err: error, teamId }, "Failed to load player fixture desk");
		return section({ teamShortName: "", fixtures: [] }, "UNAVAILABLE", "fixtures_read_failed");
	}
}

const opponentsByEvent = (fixtures: PlayerFixture[]): Map<number, PlayerRecentOpponent[]> => {
	const result = new Map<number, PlayerRecentOpponent[]>();
	for (const fixture of fixtures) {
		if (fixture.bgw || !fixture.againstTeamShortName) continue;
		const opponents = result.get(fixture.event) ?? [];
		opponents.push({ teamShortName: fixture.againstTeamShortName, wasHome: fixture.wasHome });
		result.set(fixture.event, opponents);
	}
	return result;
};

async function loadRecentGameweeks(
	context: GraphQLContext,
	playerId: number,
	playerCode: number,
	statsContext: PlayerStatsContext,
	currentEvent: CurrentEventCache | null,
	resolvedEvent: ResolvedEventState | null,
	fallbackTeamId: number,
	knownFixtures: PlayerFixture[],
	knownFixturesAvailability: PlayerDataSectionAvailability
): Promise<SectionResult<PlayerRecentGameweek[]>> {
	if (statsContext.scope === "UNAVAILABLE") {
		return statsContext.status === "PRESEASON"
			? section(
					[],
					"EMPTY",
					"recent_stats_preseason",
					statsContext.revision,
					statsContext.sourceCheckedAt
				)
			: section(
					[],
					"UNAVAILABLE",
					"recent_stats_unavailable",
					statsContext.revision,
					statsContext.sourceCheckedAt
				);
	}
	if (statsContext.scope === "PREVIOUS_SEASON")
		return section(
			[],
			"NOT_APPLICABLE",
			"recent_stats_previous_season",
			statsContext.revision,
			statsContext.sourceCheckedAt
		);
	if (statsContext.status !== "AVAILABLE") {
		const state: PlayerDataState =
			statsContext.status === "PRESEASON"
				? "EMPTY"
				: statsContext.status === "STALE"
					? "STALE"
					: statsContext.status === "INCOMPLETE"
						? "FALLBACK"
						: "UNAVAILABLE";
		return section(
			[],
			state,
			`recent_stats_${statsContext.status.toLowerCase()}`,
			statsContext.revision,
			statsContext.sourceCheckedAt
		);
	}
	if (statsContext.asOfEventId === null) {
		return section(
			[],
			"EMPTY",
			"recent_event_missing",
			statsContext.revision,
			statsContext.sourceCheckedAt
		);
	}
	try {
		const { data, error } = await context.data
			// The mutable player_gameweek_stats table has no publication revision.
			// Keep its rows request-local and mark the section non-authoritative
			// below; it must never be labelled with statsContext.revision or enter
			// the shared player-detail cache.
			.read("fpl.player_gameweek_stats")
			.select(
				"event_id, total_points, minutes, starts, goals_scored, assists, clean_sheets, saves, bonus, bps"
			)
			.eq("element_id", playerId)
			.lte("event_id", statsContext.asOfEventId)
			.order("event_id", { ascending: false })
			.limit(RECENT_GAMEWEEK_LIMIT);
		if (error) {
			context.logger.warn({ err: error, playerId }, "Failed to load recent player gameweeks");
			return section([], "UNAVAILABLE", "recent_gameweeks_read_failed");
		}
		const rows = (data ?? []) as RecentGameweekRow[];
		if (rows.length === 0) {
			return section([], "FALLBACK", "recent_gameweeks_revision_unverified");
		}
		const historicalTeams = await loadHistoricalTeamIds(
			context,
			playerCode,
			rows.map((row) => row.event_id),
			fallbackTeamId
		);
		const teamIds = rows.map((row) => historicalTeams.values.get(row.event_id) ?? fallbackTeamId);
		const uniqueTeamIds = Array.from(new Set(teamIds));
		const deskResults = await Promise.all(
			uniqueTeamIds.map(async (teamId) => {
				if (teamId === fallbackTeamId) {
					return {
						teamId,
						fixtures: knownFixtures,
						availability: knownFixturesAvailability,
					};
				}
				const desk = await loadTeamFixtureDesk(
					context,
					teamId,
					Math.min(...rows.map((row) => row.event_id), statsContext.asOfEventId ?? 1)
				);
				return { teamId, fixtures: desk.value.fixtures, availability: desk.availability };
			})
		);
		const fixturesUnavailable = deskResults.some(
			({ availability }) => availability.state === "UNAVAILABLE"
		);
		const fixturesFallback = deskResults.some(
			({ availability }) => availability.state === "FALLBACK" || availability.state === "STALE"
		);
		const deskEntries = deskResults.map(({ teamId, fixtures }) => [teamId, fixtures] as const);
		const fixturesByTeam = new Map(deskEntries);
		const provisionalEvent = currentEvent ?? resolvedEvent;
		const value = rows.map((row, index) => {
			const teamId = teamIds[index] ?? fallbackTeamId;
			const opponents = opponentsByEvent(fixturesByTeam.get(teamId) ?? []).get(row.event_id) ?? [];
			return {
				eventId: row.event_id,
				provisional: provisionalEvent?.id === row.event_id && !provisionalEvent.finished,
				totalPoints: row.total_points,
				minutes: row.minutes,
				started: row.starts,
				goalsScored: row.goals_scored,
				assists: row.assists,
				cleanSheets: row.clean_sheets,
				saves: row.saves,
				bonus: row.bonus,
				bps: row.bps,
				opponents,
			};
		});
		const fixtureState: PlayerDataState = fixturesUnavailable
			? "UNAVAILABLE"
			: fixturesFallback || !historicalTeams.complete
				? "FALLBACK"
				: "READY";
		return section(
			value,
			fixtureState === "UNAVAILABLE" ? "UNAVAILABLE" : "FALLBACK",
			fixtureState === "UNAVAILABLE"
				? "recent_fixture_read_failed"
				: "recent_gameweeks_revision_unverified"
		);
	} catch (error) {
		context.logger.warn({ err: error, playerId }, "Failed to load recent player gameweeks");
		return section([], "UNAVAILABLE", "recent_gameweeks_read_failed");
	}
}

const currentSeasonStats = (
	statsContext: PlayerStatsContext,
	stats: PlayerSeasonStatsAtEvent | null
): PlayerSeasonStatsAtEvent | null =>
	statsContext.scope === "CURRENT_SEASON" && statsContext.status === "AVAILABLE" && stats?.available
		? stats
		: null;

const playerSeasonStatsAvailability = (
	statsContext: PlayerStatsContext,
	seasonStats: PlayerSeasonStatsAtEvent | null,
	sourceAvailable: boolean
): PlayerDataSectionAvailability => {
	const metadata = {
		revision: statsContext.revision,
		sourceCheckedAt: statsContext.sourceCheckedAt,
	};
	if (statsContext.status === "PRESEASON") {
		return { state: "NOT_APPLICABLE", reasonCode: "season_stats_preseason", ...metadata };
	}
	if (statsContext.scope === "UNAVAILABLE") {
		return { state: "UNAVAILABLE", reasonCode: "season_stats_scope_unavailable", ...metadata };
	}
	if (statsContext.scope !== "CURRENT_SEASON") {
		return { state: "NOT_APPLICABLE", reasonCode: "season_stats_not_applicable", ...metadata };
	}
	if (statsContext.status === "STALE") {
		return { state: "STALE", reasonCode: "season_stats_stale", ...metadata };
	}
	if (statsContext.status === "INCOMPLETE") {
		return { state: "FALLBACK", reasonCode: "season_stats_incomplete", ...metadata };
	}
	if (statsContext.status !== "AVAILABLE" || !sourceAvailable) {
		return { state: "UNAVAILABLE", reasonCode: "season_stats_read_failed", ...metadata };
	}
	return {
		state: seasonStats?.available ? "READY" : "EMPTY",
		reasonCode: null,
		...metadata,
	};
};

function assemblePlayerDetail(args: {
	playerId: number;
	player: NonNullable<Awaited<ReturnType<typeof playersRepository.getPlayerById>>>;
	statsContext: PlayerStatsContext;
	seasonStats: PlayerSeasonStatsAtEvent | null;
	seasonStatsAvailability: PlayerDataSectionAvailability;
	market: LatestMarketSnapshot | null;
	marketAvailability: PlayerDataSectionAvailability;
	historicalTeamAvailability: PlayerDataSectionAvailability;
	marketMatchesStatsEvent: boolean;
	teamShortName: string;
	fixtures: PlayerFixture[];
	fixturesAvailability: PlayerDataSectionAvailability;
	recentGameweeks: PlayerRecentGameweek[];
	recentGameweeksAvailability: PlayerDataSectionAvailability;
}): PlayerDetail {
	const stats = currentSeasonStats(args.statsContext, args.seasonStats);
	const freshMarket = args.market !== null && !args.market.availability.stale;
	const latestEventPoints =
		args.recentGameweeks.find((row) => row.eventId === args.statsContext.asOfEventId)
			?.totalPoints ?? null;
	return {
		id: args.playerId,
		webName: args.player.webName,
		teamShortName: args.teamShortName,
		elementType: args.player.position,
		elementTypeName: elementTypeToName(args.player.position),
		price: args.player.price,
		startPrice: args.player.startPrice,
		statsContext: args.statsContext,
		injuryAvailability: args.market?.availability ?? null,
		dataAvailability: {
			isFullyAuthoritative:
				isAuthoritativeSection(args.seasonStatsAvailability) &&
				isAuthoritativeSection(args.marketAvailability) &&
				isAuthoritativeSection(args.historicalTeamAvailability) &&
				isAuthoritativeSection(args.fixturesAvailability) &&
				isAuthoritativeSection(args.recentGameweeksAvailability),
			seasonStats: args.seasonStatsAvailability,
			market: args.marketAvailability,
			historicalTeam: args.historicalTeamAvailability,
			fixtures: args.fixturesAvailability,
			recentGameweeks: args.recentGameweeksAvailability,
		},
		totalPoints: stats?.totalPoints ?? null,
		selectedByPercent:
			(freshMarket ? args.market?.selectedByPercent : null) ??
			args.player.selectedByPercent ??
			stats?.selectedByPercent ??
			null,
		form: stats?.form ?? null,
		seasonTransfersIn:
			(freshMarket ? args.market?.seasonTransfersIn : null) ?? stats?.seasonTransfersIn ?? null,
		seasonTransfersOut:
			(freshMarket ? args.market?.seasonTransfersOut : null) ?? stats?.seasonTransfersOut ?? null,
		transfersInEvent:
			(freshMarket && args.marketMatchesStatsEvent ? args.market?.transfersInEvent : null) ??
			stats?.transfersInEvent ??
			null,
		transfersOutEvent:
			(freshMarket && args.marketMatchesStatsEvent ? args.market?.transfersOutEvent : null) ??
			stats?.transfersOutEvent ??
			null,
		eventPoints: latestEventPoints,
		minutes: stats?.minutes ?? null,
		starts: stats?.starts ?? null,
		goalsScored: stats?.goalsScored ?? null,
		assists: stats?.assists ?? null,
		cleanSheets: stats?.cleanSheets ?? null,
		goalsConceded: stats?.goalsConceded ?? null,
		ownGoals: stats?.ownGoals ?? null,
		penaltiesSaved: stats?.penaltiesSaved ?? null,
		yellowCards: stats?.yellowCards ?? null,
		redCards: stats?.redCards ?? null,
		saves: stats?.saves ?? null,
		bonus: stats?.bonus ?? null,
		bps: stats?.bps ?? null,
		expectedGoals: stats?.expectedGoals ?? null,
		expectedAssists: stats?.expectedAssists ?? null,
		expectedGoalInvolvements: stats?.expectedGoalInvolvements ?? null,
		expectedGoalsConceded: stats?.expectedGoalsConceded ?? null,
		influence: stats?.influence ?? null,
		creativity: stats?.creativity ?? null,
		threat: stats?.threat ?? null,
		ictIndex: stats?.ictIndex ?? null,
		recentGameweeks: args.recentGameweeks,
		fixtures: args.fixtures,
	};
}

export interface PlayerDetailRepository {
	getPlayerDetail(
		context: GraphQLContext,
		playerId: number,
		eventId: number
	): Promise<PlayerDetail | null>;
	getPlayerDetails(
		context: GraphQLContext,
		playerIds: number[],
		eventId: number
	): Promise<Map<number, PlayerDetail | null>>;
}

export const playerDetailRepository: PlayerDetailRepository = {
	async getPlayerDetails(context, playerIds, eventId) {
		const uniqueIds = Array.from(
			new Set(playerIds.filter((id) => Number.isSafeInteger(id) && id > 0))
		);
		await readPlayerDetailCaches(
			context,
			uniqueIds.map((playerId) => gqlCacheKey(context, playerDetailCacheKey(playerId, eventId)))
		);
		const details = await Promise.all(
			uniqueIds.map((playerId) => this.getPlayerDetail(context, playerId, eventId))
		);
		return new Map(uniqueIds.map((playerId, index) => [playerId, details[index] ?? null]));
	},
	async getPlayerDetail(
		context: GraphQLContext,
		playerId: number,
		eventId: number
	): Promise<PlayerDetail | null> {
		if (!Number.isSafeInteger(playerId) || playerId <= 0) return null;
		if (!Number.isSafeInteger(eventId) || eventId <= 0) return null;

		const cacheKey = gqlCacheKey(context, playerDetailCacheKey(playerId, eventId));
		const cached = await readPlayerDetailCache(context, cacheKey);
		if (cached !== undefined) {
			if (cached === null) return null;
			const currentStatsContext = await resolvePlayerStatsContext(context, eventId);
			if (hasSameStatsAuthority(cached.statsContext, currentStatsContext)) {
				recordDataAvailability(cached);
				return cached;
			}
			context.logger.warn(
				{ playerId, eventId, requestId: context.requestId },
				"Expired player-detail stats authority"
			);
			try {
				await context.redis.del(cacheKey);
			} catch (error) {
				context.logger.warn({ err: error, key: cacheKey }, "Failed to evict player-detail cache");
			}
			requestPlayerDetailCacheMemo(context).set(cacheKey, undefined);
		}

		const [player, statsContext, marketResult, currentEvent] = await Promise.all([
			playersRepository.getPlayerById(context, playerId),
			resolvePlayerStatsContext(context, eventId),
			loadLatestMarketSnapshot(context, playerId),
			getCurrentEvent(context),
		]);
		if (!player) {
			await writeQueryCache(context, cacheKey, NULL_SENTINEL, QUERY_CACHE_TTL_SECONDS.METADATA);
			requestPlayerDetailCacheMemo(context).set(cacheKey, null);
			return null;
		}
		const resolvedEvent = await loadResolvedEventState(context, statsContext.asOfEventId);
		const historicalTeam = await loadHistoricalTeamId(
			context,
			statsContext.season,
			player.code,
			statsContext.asOfEventId !== null &&
				(currentEvent === null || statsContext.asOfEventId < currentEvent.id)
				? statsContext.asOfEventId
				: null,
			player.teamId
		);

		const [fixtureDesk, seasonStatsLoad] = await Promise.all([
			loadTeamFixtureDesk(context, historicalTeam.value, eventId),
			getPlayerSeasonStatsLoadForContext(context, [playerId], statsContext),
		]);
		const seasonStats = seasonStatsLoad.stats.get(playerId) ?? null;
		const recentGameweeks = await loadRecentGameweeks(
			context,
			playerId,
			player.code,
			statsContext,
			currentEvent,
			resolvedEvent,
			historicalTeam.value,
			fixtureDesk.value.fixtures,
			fixtureDesk.availability
		);
		const seasonStatsAvailability = playerSeasonStatsAvailability(
			statsContext,
			seasonStats,
			seasonStatsLoad.sourceAvailable
		);
		const detail = assemblePlayerDetail({
			playerId,
			player,
			statsContext,
			seasonStats,
			seasonStatsAvailability,
			market: marketResult.value,
			marketAvailability: marketResult.availability,
			historicalTeamAvailability: historicalTeam.availability,
			marketMatchesStatsEvent:
				statsContext.asOfEventId === null || currentEvent?.id === statsContext.asOfEventId,
			teamShortName: fixtureDesk.value.teamShortName,
			fixtures: fixtureDesk.value.fixtures,
			fixturesAvailability: fixtureDesk.availability,
			recentGameweeks: recentGameweeks.value,
			recentGameweeksAvailability: recentGameweeks.availability,
		});
		if (detail.dataAvailability.isFullyAuthoritative) {
			await writeQueryCache(
				context,
				cacheKey,
				JSON.stringify(detail),
				QUERY_CACHE_TTL_SECONDS.REPORTING
			);
		} else {
			context.logger.warn(
				{ playerId, eventId, requestId: context.requestId },
				"Skipping shared player-detail cache for non-authoritative sections"
			);
		}
		requestPlayerDetailCacheMemo(context).set(cacheKey, detail);
		recordDataAvailability(detail);
		return detail;
	},
};
