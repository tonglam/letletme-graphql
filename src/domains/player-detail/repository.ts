import type { GraphQLContext } from "../../graphql/context";
import { gqlCacheKey } from "../../infra/cache-key";
import { getCurrentEventFromRedis, type CurrentEventCache } from "../../infra/event";
import { getCurrentSeason } from "../../infra/season";
import { buildTeamMap } from "../../infra/team-map";
import { fixturesRepository, type Fixture } from "../fixtures/repository";
import { playersRepository } from "../players/repository";
import {
	getPlayerSeasonStatsForContext,
	resolvePlayerStatsContext,
	type PlayerSeasonStatsAtEvent,
	type PlayerStatsContext,
} from "../players/season-stats-at-event";

const PLAYER_DETAIL_CACHE_TTL = 5 * 60;
const PLAYER_DETAIL_NULL_CACHE_TTL = 60 * 60;
const MARKET_STALE_AFTER_MS = 36 * 60 * 60 * 1000;
const RECENT_GAMEWEEK_LIMIT = 5;
const UPCOMING_GAMEWEEK_LIMIT = 8;
const NULL_SENTINEL = "__pd:null__";

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
	availability: PlayerAvailability | null;
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
	snapshot_date: string | Date;
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const isPlayerDetail = (value: unknown): value is PlayerDetail =>
	isRecord(value) &&
	typeof value.id === "number" &&
	typeof value.webName === "string" &&
	isRecord(value.statsContext) &&
	Array.isArray(value.recentGameweeks) &&
	Array.isArray(value.fixtures);

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

const toCalendarDate = (value: string | Date): string | null => {
	if (value instanceof Date) return value.toISOString().slice(0, 10);
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

const playerDetailCacheKey = (playerId: number, eventId: number): string =>
	`player_detail:v3:${playerId}:${eventId}`;

async function readPlayerDetailCache(
	context: GraphQLContext,
	key: string
): Promise<PlayerDetail | null | undefined> {
	let cached: string | null;
	try {
		cached = await context.redis.get(key);
	} catch (error) {
		context.logger.warn({ err: error, key }, "Failed to read player-detail cache");
		return undefined;
	}
	if (cached === null) return undefined;
	if (cached === NULL_SENTINEL) return null;
	try {
		const parsed: unknown = JSON.parse(cached);
		if (isPlayerDetail(parsed)) return parsed;
	} catch (error) {
		context.logger.warn({ err: error, key }, "Malformed player-detail cache");
	}
	try {
		await context.redis.del(key);
	} catch (error) {
		context.logger.warn({ err: error, key }, "Failed to evict malformed player-detail cache");
	}
	return undefined;
}

async function loadLatestMarketSnapshot(
	context: GraphQLContext,
	playerId: number
): Promise<LatestMarketSnapshot | null> {
	try {
		const { data, error } = await context.supabase
			.from("player_market_snapshots")
			.select(
				"snapshot_date, captured_at, selected_by_percent, transfers_in, transfers_out, transfers_in_event, transfers_out_event, status, news, news_added, chance_of_playing_this_round, chance_of_playing_next_round"
			)
			.eq("element_id", playerId)
			.order("snapshot_date", { ascending: false })
			.order("captured_at", { ascending: false })
			.limit(1);
		if (error) {
			context.logger.warn({ err: error, playerId }, "Failed to load latest player market snapshot");
			return null;
		}
		const row = data?.[0] as MarketSnapshotRow | undefined;
		if (!row) return null;

		const capturedAt = toIsoTimestamp(row.captured_at);
		const observedDate = toCalendarDate(row.snapshot_date);
		const selectedByPercent = asNullableNumber(row.selected_by_percent);
		if (capturedAt === null || observedDate === null || selectedByPercent === null) return null;

		return {
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
	} catch (error) {
		context.logger.warn({ err: error, playerId }, "Failed to load latest player market snapshot");
		return null;
	}
}

async function loadResolvedEventState(
	context: GraphQLContext,
	eventId: number | null,
	currentEvent: CurrentEventCache | null
): Promise<ResolvedEventState | null> {
	if (eventId === null) return null;
	if (currentEvent?.id === eventId) {
		return { id: currentEvent.id, finished: currentEvent.finished };
	}
	try {
		const { data, error } = await context.supabase
			.from("events")
			.select("id, finished")
			.eq("id", eventId)
			.limit(1);
		if (error) {
			context.logger.warn({ err: error, eventId }, "Failed to load resolved event state");
			return null;
		}
		const row = data?.[0] as { id?: number; finished?: boolean | null } | undefined;
		return row?.id === eventId ? { id: eventId, finished: Boolean(row.finished) } : null;
	} catch (error) {
		context.logger.warn({ err: error, eventId }, "Failed to load resolved event state");
		return null;
	}
}

async function loadHistoricalTeamId(
	context: GraphQLContext,
	season: string,
	playerCode: number,
	eventId: number | null,
	fallbackTeamId: number
): Promise<number> {
	if (eventId === null) return fallbackTeamId;
	try {
		const { data, error } = await context.supabase
			.from("fpl_player_fixture_stats")
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
			return fallbackTeamId;
		}
		const teamId = asNullableNumber((data?.[0] as { team_id?: unknown } | undefined)?.team_id);
		return teamId !== null && teamId > 0 ? teamId : fallbackTeamId;
	} catch (error) {
		context.logger.warn(
			{ err: error, playerCode, eventId },
			"Failed to load historical player team"
		);
		return fallbackTeamId;
	}
}

const formatFixtureScore = (fixture: Fixture, wasHome: boolean): string | null => {
	if (fixture.teamHScore === null || fixture.teamAScore === null) return null;
	return wasHome
		? `${fixture.teamHScore}-${fixture.teamAScore}`
		: `${fixture.teamAScore}-${fixture.teamHScore}`;
};

async function loadTeamFixtureDesk(
	context: GraphQLContext,
	teamId: number,
	fromEventId: number
): Promise<{ teamShortName: string; fixtures: PlayerFixture[] }> {
	try {
		const [fixtures, teams] = await Promise.all([
			fixturesRepository.listFixtures(context, { teamId }, 100, 0),
			buildTeamMap(context),
		]);
		const mapped = fixtures
			.filter((fixture) => fixture.eventId !== null)
			.map((fixture): PlayerFixture => {
				const wasHome = fixture.teamHId === teamId;
				const opponentId = wasHome ? fixture.teamAId : fixture.teamHId;
				return {
					id: fixture.id,
					event: fixture.eventId!,
					againstTeamShortName: teams.get(opponentId)?.shortName ?? "",
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
		const eventsWithAnyFixtures = new Set(eventsWithTeamFixtures);
		const uncoveredEvents = Array.from(
			{ length: Math.max(0, lastEventId - fromEventId + 1) },
			(_, index) => fromEventId + index
		).filter((event) => !eventsWithTeamFixtures.has(event));
		const coverageResults = await Promise.all(
			uncoveredEvents.map(async (event) => {
				try {
					const eventFixtures = await fixturesRepository.getEventFixtures(context, event);
					return eventFixtures.some((fixture) => fixture.eventId === event) ? event : null;
				} catch (error) {
					context.logger.warn(
						{ err: error, event },
						"Failed to confirm fixture coverage for player fixture desk"
					);
					return null;
				}
			})
		);
		for (const event of coverageResults) {
			if (event !== null) eventsWithAnyFixtures.add(event);
		}

		for (let event = fromEventId; event <= lastEventId; event += 1) {
			if (eventsWithTeamFixtures.has(event) || !eventsWithAnyFixtures.has(event)) continue;
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
		return { teamShortName: teams.get(teamId)?.shortName ?? "", fixtures: mapped };
	} catch (error) {
		context.logger.warn({ err: error, teamId }, "Failed to load player fixture desk");
		return { teamShortName: "", fixtures: [] };
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
	knownFixtures: PlayerFixture[]
): Promise<PlayerRecentGameweek[]> {
	if (statsContext.scope !== "CURRENT_SEASON" || statsContext.asOfEventId === null) return [];
	try {
		const { data, error } = await context.supabase
			.from("event_lives")
			.select(
				"event_id, total_points, minutes, starts, goals_scored, assists, clean_sheets, saves, bonus, bps"
			)
			.eq("element_id", playerId)
			.lte("event_id", statsContext.asOfEventId)
			.order("event_id", { ascending: false })
			.limit(RECENT_GAMEWEEK_LIMIT);
		if (error) {
			context.logger.warn({ err: error, playerId }, "Failed to load recent player gameweeks");
			return [];
		}
		const rows = (data ?? []) as RecentGameweekRow[];
		const teamIds = await Promise.all(
			rows.map((row) =>
				loadHistoricalTeamId(context, statsContext.season, playerCode, row.event_id, fallbackTeamId)
			)
		);
		const uniqueTeamIds = Array.from(new Set(teamIds));
		const deskEntries = await Promise.all(
			uniqueTeamIds.map(async (teamId) => {
				if (teamId === fallbackTeamId) return [teamId, knownFixtures] as const;
				const desk = await loadTeamFixtureDesk(
					context,
					teamId,
					Math.min(...rows.map((row) => row.event_id), statsContext.asOfEventId ?? 1)
				);
				return [teamId, desk.fixtures] as const;
			})
		);
		const fixturesByTeam = new Map(deskEntries);
		const provisionalEvent = currentEvent ?? resolvedEvent;
		return rows.map((row, index) => {
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
	} catch (error) {
		context.logger.warn({ err: error, playerId }, "Failed to load recent player gameweeks");
		return [];
	}
}

const currentSeasonStats = (
	statsContext: PlayerStatsContext,
	stats: PlayerSeasonStatsAtEvent | null
): PlayerSeasonStatsAtEvent | null =>
	statsContext.scope === "CURRENT_SEASON" && stats?.available ? stats : null;

function assemblePlayerDetail(args: {
	playerId: number;
	player: NonNullable<Awaited<ReturnType<typeof playersRepository.getPlayerById>>>;
	statsContext: PlayerStatsContext;
	seasonStats: PlayerSeasonStatsAtEvent | null;
	market: LatestMarketSnapshot | null;
	marketMatchesStatsEvent: boolean;
	teamShortName: string;
	fixtures: PlayerFixture[];
	recentGameweeks: PlayerRecentGameweek[];
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
		availability: args.market?.availability ?? null,
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
}

export const playerDetailRepository: PlayerDetailRepository = {
	async getPlayerDetail(
		context: GraphQLContext,
		playerId: number,
		eventId: number
	): Promise<PlayerDetail | null> {
		if (!Number.isInteger(playerId) || playerId <= 0) return null;
		if (!Number.isInteger(eventId) || eventId <= 0) return null;

		const [season, currentEvent] = await Promise.all([
			getCurrentSeason(context),
			getCurrentEventFromRedis(context),
		]);
		const cacheKey = gqlCacheKey(season, playerDetailCacheKey(playerId, eventId));
		// A shaped detail cache is safe for settled events, but not while the
		// selected current event is live: event_lives and player_stats can advance
		// during the five-minute TTL. Bypass both reads and writes for that window.
		const selectedEventState =
			currentEvent === null ? await loadResolvedEventState(context, eventId, null) : null;
		const selectedEventIsLive =
			(currentEvent?.id === eventId && !currentEvent.finished) ||
			(selectedEventState?.id === eventId && !selectedEventState.finished);
		if (!selectedEventIsLive) {
			const cached = await readPlayerDetailCache(context, cacheKey);
			if (cached !== undefined) return cached;
		}

		const [player, statsContext, market] = await Promise.all([
			playersRepository.getPlayerById(context, playerId),
			resolvePlayerStatsContext(context, eventId),
			loadLatestMarketSnapshot(context, playerId),
		]);
		if (!player) {
			if (!selectedEventIsLive) {
				try {
					await context.redis.set(cacheKey, NULL_SENTINEL, "EX", PLAYER_DETAIL_NULL_CACHE_TTL);
				} catch (error) {
					context.logger.warn(
						{ err: error, cacheKey, playerId, eventId },
						"Failed to cache missing player detail"
					);
				}
			}
			return null;
		}
		const resolvedEvent = await loadResolvedEventState(
			context,
			statsContext.asOfEventId,
			currentEvent
		);
		const resolvedTeamId = await loadHistoricalTeamId(
			context,
			statsContext.season,
			player.code,
			statsContext.asOfEventId !== null &&
				(currentEvent === null || statsContext.asOfEventId < currentEvent.id)
				? statsContext.asOfEventId
				: null,
			player.teamId
		);

		const [{ teamShortName, fixtures }, seasonStats] = await Promise.all([
			loadTeamFixtureDesk(context, resolvedTeamId, eventId),
			getPlayerSeasonStatsForContext(context, playerId, statsContext),
		]);
		const recentGameweeks = await loadRecentGameweeks(
			context,
			playerId,
			player.code,
			statsContext,
			currentEvent,
			resolvedEvent,
			resolvedTeamId,
			fixtures
		);
		const detail = assemblePlayerDetail({
			playerId,
			player,
			statsContext,
			seasonStats,
			market,
			marketMatchesStatsEvent:
				statsContext.asOfEventId === null || currentEvent?.id === statsContext.asOfEventId,
			teamShortName,
			fixtures,
			recentGameweeks,
		});
		if (!selectedEventIsLive) {
			try {
				await context.redis.set(cacheKey, JSON.stringify(detail), "EX", PLAYER_DETAIL_CACHE_TTL);
			} catch (error) {
				context.logger.warn(
					{ err: error, cacheKey, playerId, eventId },
					"Failed to cache player detail"
				);
			}
		}
		return detail;
	},
};
