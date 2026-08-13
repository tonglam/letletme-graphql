import { GraphQLError } from "graphql";
import type { GraphQLContext } from "../../graphql/context";
import { getCoreFixtureSnapshot, type CoreFixtureData } from "../../infra/data-snapshot";
import { eventsService } from "../events/service";
import type { Event } from "../events/repository";
import type { LivePerformance } from "../live/repository";
import { liveService } from "../live/service";
import type { LiveSnapshotMeta } from "../live/snapshot-meta";
import { Position, type Player } from "../players/repository";
import { playersService } from "../players/service";

export const MAX_GAMEWEEK_ID = 38;

export type GameweekLifecycleState = "SCHEDULED" | "PROVISIONAL" | "SETTLED";
export type GameweekSectionState = "PENDING" | "AVAILABLE" | "UNAVAILABLE";

export type GameweekOverviewPlayer = {
	id: number;
	webName: string;
	teamShortName: string | null;
};

export type GameweekOverview = {
	averagePoints: number | null;
	highestPoints: number | null;
	mostCaptained: GameweekOverviewPlayer | null;
	mostViceCaptained: GameweekOverviewPlayer | null;
	mostSelected: GameweekOverviewPlayer | null;
	mostTransferredIn: GameweekOverviewPlayer | null;
	chipsPlayed: {
		benchBoost: number | null;
		tripleCaptain: number | null;
		wildcard: number | null;
		freeHit: number | null;
	} | null;
};

export type GameweekBoardPlayer = {
	id: number;
	webName: string;
	position: "GOALKEEPER" | "DEFENDER" | "MIDFIELDER" | "FORWARD";
	teamShortName: string;
	price: number;
	minutes: number | null;
	goalsScored: number | null;
	assists: number | null;
	cleanSheets: number | null;
	bonus: number | null;
	totalPoints: number;
};

export type GameweekDesk = {
	season: string;
	coreRevision: string;
	liveRevision: string | null;
	anchorEventId: number;
	eventId: number;
	currentEventId: number | null;
	nextEventId: number | null;
	isPreseason: boolean;
	lifecycle: GameweekLifecycleState;
	deadlineTime: string | null;
	publishedAt: string | null;
	overviewState: GameweekSectionState;
	boardsState: GameweekSectionState;
	overview: GameweekOverview | null;
	dreamTeam: GameweekBoardPlayer[];
	hauls: GameweekBoardPlayer[];
};

type CoreEventContext = Awaited<ReturnType<typeof eventsService.getCoreEventContext>>;

const positiveEventId = (value: number | null | undefined): number | null =>
	typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;

export const resolveGameweekAnchor = (context: CoreEventContext): number | null => {
	const current = positiveEventId(context.currentEventId);
	if (current !== null) return current;
	const next = positiveEventId(context.nextEventId);
	if (next !== null) return Math.max(1, next - 1);
	return positiveEventId(context.latestFinishedEventId);
};

const fixtureHasStarted = (fixture: CoreFixtureData): boolean =>
	fixture.started === true || fixture.finished || fixture.finishedProvisional;

const hasStartedFixture = (fixtures: readonly CoreFixtureData[]): boolean =>
	fixtures.some(fixtureHasStarted);

const isScheduledLifecycle = (
	event: Event,
	fixtures: readonly CoreFixtureData[],
	context: CoreEventContext,
	eventId: number
): boolean => {
	if (event.finished || hasStartedFixture(fixtures)) return false;
	const nextEventId = positiveEventId(context.nextEventId);
	return event.isCurrent || event.isNext || (nextEventId !== null && eventId >= nextEventId);
};

const lifecycleFromLiveState = (
	meta: LiveSnapshotMeta | null,
	event: Event,
	fixtures: readonly CoreFixtureData[],
	context: CoreEventContext,
	eventId: number
): GameweekLifecycleState => {
	if (meta?.state === "scheduled") return "SCHEDULED";
	if (meta?.state === "settled" || (event.finished && event.dataChecked)) return "SETTLED";
	if (meta?.state === "live") return "PROVISIONAL";
	if (isScheduledLifecycle(event, fixtures, context, eventId)) return "SCHEDULED";
	return "PROVISIONAL";
};

const chipCount = (chips: Event["chipPlays"], name: string): number | null => {
	const found = chips?.find((chip) => chip.chipName === name);
	return found?.numberPlayed ?? null;
};

const overviewFactsPresent = (event: Event): boolean =>
	event.averageEntryScore !== null ||
	event.highestScore !== null ||
	event.mostSelected !== null ||
	event.mostTransferredIn !== null ||
	event.mostCaptained !== null ||
	event.mostViceCaptained !== null ||
	event.chipPlays !== null;

const mapOverviewPlayer = (
	playerId: number | null,
	playersById: ReadonlyMap<number, Player>,
	teamNames: ReadonlyMap<number, string>,
	eventTeamIds: ReadonlyMap<number, number>
): GameweekOverviewPlayer | null => {
	if (playerId === null) return null;
	const player = playersById.get(playerId);
	if (!player) return null;
	return {
		id: player.id,
		webName: player.webName,
		teamShortName: teamNames.get(eventTeamIds.get(player.id) ?? player.teamId) ?? null,
	};
};

const mapOverview = (
	event: Event,
	playersById: ReadonlyMap<number, Player>,
	teamNames: ReadonlyMap<number, string>,
	eventTeamIds: ReadonlyMap<number, number>
): GameweekOverview => ({
	averagePoints: event.averageEntryScore,
	highestPoints: event.highestScore,
	mostCaptained: mapOverviewPlayer(event.mostCaptained, playersById, teamNames, eventTeamIds),
	mostViceCaptained: mapOverviewPlayer(
		event.mostViceCaptained,
		playersById,
		teamNames,
		eventTeamIds
	),
	mostSelected: mapOverviewPlayer(event.mostSelected, playersById, teamNames, eventTeamIds),
	mostTransferredIn: mapOverviewPlayer(
		event.mostTransferredIn,
		playersById,
		teamNames,
		eventTeamIds
	),
	chipsPlayed: event.chipPlays
		? {
				benchBoost: chipCount(event.chipPlays, "bboost"),
				tripleCaptain: chipCount(event.chipPlays, "3xc"),
				wildcard: chipCount(event.chipPlays, "wildcard"),
				freeHit: chipCount(event.chipPlays, "freehit"),
			}
		: null,
});

const mapBoardPlayer = (
	performance: LivePerformance,
	playersById: ReadonlyMap<number, Player>,
	teamNames: ReadonlyMap<number, string>,
	eventTeamIds: ReadonlyMap<number, number>
): GameweekBoardPlayer | null => {
	const player = playersById.get(performance.playerId);
	if (!player) return null;
	return {
		id: player.id,
		webName: player.webName,
		position:
			player.position === Position.GOALKEEPER
				? "GOALKEEPER"
				: player.position === Position.DEFENDER
					? "DEFENDER"
					: player.position === Position.MIDFIELDER
						? "MIDFIELDER"
						: "FORWARD",
		teamShortName: teamNames.get(eventTeamIds.get(player.id) ?? player.teamId) ?? "—",
		price: player.price,
		minutes: performance.minutes,
		goalsScored: performance.goalsScored,
		assists: performance.assists,
		cleanSheets: performance.cleanSheets,
		bonus: performance.bonus,
		totalPoints: performance.totalPoints,
	};
};

const mapAndSortBoards = (
	performances: readonly LivePerformance[],
	order: "position" | "points",
	playersById: ReadonlyMap<number, Player>,
	teamNames: ReadonlyMap<number, string>,
	eventTeamIds: ReadonlyMap<number, number>
): GameweekBoardPlayer[] => {
	const positionOrder: Record<GameweekBoardPlayer["position"], number> = {
		GOALKEEPER: 0,
		DEFENDER: 1,
		MIDFIELDER: 2,
		FORWARD: 3,
	};
	return performances
		.map((performance) => mapBoardPlayer(performance, playersById, teamNames, eventTeamIds))
		.filter((player): player is GameweekBoardPlayer => player !== null)
		.sort((left, right) => {
			if (order === "points") {
				return right.totalPoints - left.totalPoints || left.webName.localeCompare(right.webName);
			}
			return (
				positionOrder[left.position] - positionOrder[right.position] ||
				right.totalPoints - left.totalPoints ||
				left.webName.localeCompare(right.webName)
			);
		});
};

const uniquePositiveIds = (ids: Array<number | null>): number[] =>
	Array.from(new Set(ids.filter((id): id is number => positiveEventId(id) !== null)));

const resolveHistoricalTeamIds = async (
	context: GraphQLContext,
	playersById: ReadonlyMap<number, Player>,
	eventId: number,
	currentEventId: number | null
): Promise<Map<number, number>> => {
	const fallback = new Map(
		Array.from(playersById.values()).map((player) => [player.id, player.teamId] as const)
	);
	if (playersById.size === 0 || currentEventId === null || eventId > currentEventId)
		return fallback;
	const playerCodes = Array.from(playersById.values())
		.map((player) => player.code)
		.filter((code) => Number.isSafeInteger(code) && code > 0);
	if (playerCodes.length === 0) return fallback;
	try {
		const result = await context.database.query<{ player_code: number; team_id: number }>(
			`SELECT DISTINCT ON (player_code) player_code, team_id
			 FROM fpl.player_fixture_stats
			 WHERE season_id = $1
			   AND player_code = ANY($2::integer[])
			   AND event_id <= $3
			 ORDER BY player_code, event_id DESC, fixture_id DESC`,
			[context.currentSeason.seasonId, playerCodes, eventId]
		);
		const teamByCode = new Map(
			result.rows
				.filter(
					(row) =>
						Number.isSafeInteger(row.player_code) &&
						Number.isSafeInteger(row.team_id) &&
						row.team_id > 0
				)
				.map((row) => [row.player_code, row.team_id] as const)
		);
		for (const player of playersById.values()) {
			const eventTeamId = teamByCode.get(player.code);
			if (eventTeamId !== undefined) fallback.set(player.id, eventTeamId);
		}
	} catch (error) {
		context.logger.warn(
			{ err: error, eventId },
			"Failed to resolve historical gameweek player teams"
		);
	}
	return fallback;
};

const toGraphQLError = (message: string, code: string): GraphQLError =>
	new GraphQLError(message, { extensions: { code } });

export const gameweekService = {
	async getGameweekDesk(
		context: GraphQLContext,
		requestedEventId?: number | null
	): Promise<GameweekDesk> {
		if (
			requestedEventId !== undefined &&
			requestedEventId !== null &&
			(!Number.isSafeInteger(requestedEventId) ||
				requestedEventId < 1 ||
				requestedEventId > MAX_GAMEWEEK_ID)
		) {
			throw toGraphQLError("Gameweek event ID must be between 1 and 38", "BAD_USER_INPUT");
		}

		const eventContext = await eventsService.getCoreEventContext(context);
		context.dataRevision ??= `core-${eventContext.revision}`;
		const anchorEventId = resolveGameweekAnchor(eventContext);
		const eventId = requestedEventId ?? anchorEventId;
		if (eventId === null) {
			throw toGraphQLError("Gameweek event context is unavailable", "DATA_UNAVAILABLE");
		}

		const [event, fixtureSnapshot] = await Promise.all([
			eventsService.getEventById(context, eventId),
			getCoreFixtureSnapshot(context),
		]);
		if (!event) {
			throw toGraphQLError(`Gameweek event ${eventId} was not found`, "NOT_FOUND");
		}

		const fixtures = fixtureSnapshot.fixtures.filter((fixture) => fixture.eventId === eventId);
		const teamNames = new Map(
			fixtureSnapshot.teams.map((team) => [team.id, team.shortName] as const)
		);
		const isPreseason =
			eventContext.currentEventId === null && eventContext.nextEventId === 1 && eventId === 1;
		const scheduled = isScheduledLifecycle(event, fixtures, eventContext, eventId);
		const initialLifecycle = scheduled
			? "SCHEDULED"
			: lifecycleFromLiveState(null, event, fixtures, eventContext, eventId);

		let overviewState: GameweekSectionState = "PENDING";
		let overview: GameweekOverview | null = null;
		if (initialLifecycle !== "SCHEDULED" && (overviewFactsPresent(event) || event.dataChecked)) {
			try {
				const ids = uniquePositiveIds([
					event.mostCaptained,
					event.mostViceCaptained,
					event.mostSelected,
					event.mostTransferredIn,
				]);
				const players = await playersService.getPlayersByIds(context, ids);
				const playersById = new Map(players.map((player) => [player.id, player] as const));
				const eventTeamIds = await resolveHistoricalTeamIds(
					context,
					playersById,
					eventId,
					eventContext.currentEventId
				);
				overview = mapOverview(event, playersById, teamNames, eventTeamIds);
				overviewState = "AVAILABLE";
			} catch (error) {
				context.logger.warn({ err: error, eventId }, "Gameweek overview is unavailable");
				overviewState = "UNAVAILABLE";
			}
		}

		let boardsState: GameweekSectionState = scheduled ? "PENDING" : "UNAVAILABLE";
		let liveRevision: string | null = null;
		let publishedAt: string | null = null;
		let lifecycle = initialLifecycle;
		let dreamTeam: GameweekBoardPlayer[] = [];
		let hauls: GameweekBoardPlayer[] = [];

		if (!scheduled) {
			try {
				const boards = await liveService.getGameweekBoards(context, eventId);
				const playerIds = Array.from(
					new Set([...boards.dreamTeam, ...boards.hauls].map((performance) => performance.playerId))
				);
				const players = await playersService.getPlayersByIds(context, playerIds);
				const playersById = new Map(players.map((player) => [player.id, player] as const));
				const eventTeamIds = await resolveHistoricalTeamIds(
					context,
					playersById,
					eventId,
					eventContext.currentEventId
				);
				dreamTeam = mapAndSortBoards(
					boards.dreamTeam,
					"position",
					playersById,
					teamNames,
					eventTeamIds
				);
				hauls = mapAndSortBoards(boards.hauls, "points", playersById, teamNames, eventTeamIds);
				const meta = boards.meta;
				liveRevision = meta.revision;
				publishedAt = meta.publishedAt;
				lifecycle = lifecycleFromLiveState(meta, event, fixtures, eventContext, eventId);
				boardsState = "AVAILABLE";
			} catch (error) {
				context.logger.warn({ err: error, eventId }, "Gameweek boards are unavailable");
			}
		}

		return {
			season: eventContext.season,
			coreRevision: eventContext.revision,
			liveRevision,
			anchorEventId: anchorEventId ?? eventId,
			eventId,
			currentEventId: eventContext.currentEventId,
			nextEventId: eventContext.nextEventId,
			isPreseason,
			lifecycle,
			deadlineTime: event.deadlineTime,
			publishedAt,
			overviewState,
			boardsState,
			overview,
			dreamTeam,
			hauls,
		};
	},
};
