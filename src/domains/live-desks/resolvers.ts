import { GraphQLError } from "graphql";

import type { GraphQLContext } from "../../graphql/context";
import {
	getCoreEventSnapshot,
	getCoreFixtureSnapshot,
	getCoreLiveIdentitySnapshot,
	type CoreEventSnapshot,
	type CoreFixtureData,
	type CoreFixtureSnapshot,
	type CoreLiveIdentitySnapshot,
} from "../../infra/data-snapshot";
import type { LivePerformanceData } from "../../infra/live-types";
import { metrics } from "../../infra/metrics";
import { getPlayerAndTeamMaps, getTournamentSelectionIndexRows } from "../event-stats/repository";
import { Position } from "../players/repository";
import { tournamentsService } from "../tournaments/service";
import { LeagueType } from "../leagues/repository";
import { entriesRepository } from "../entries/repository";
import {
	loadTournamentEventEligibility,
	MAX_TOURNAMENT_DESK_ENTRIES,
	selectTournamentDeskEntryWindow,
} from "./tournament-entry-window";
import {
	calcLivePointsForEntriesV2,
	readLivePublicationV2,
	type LivePublicationReadV2,
} from "../entry-live/v2-service";
import {
	buildEntryLiveCompetitionBoardV2,
	normalizeEntryLiveCompetitionBoardRequestV2,
	queryEntryLiveCompetitionBoardV2,
	type EntryLiveCompetitionBoardRequest,
} from "./v2-board";

type LiveRef = { season: string; eventId: number; scoreCoreRevision: string };

const selectionPositionName = (position: number): keyof typeof Position => {
	switch (position) {
		case Position.GOALKEEPER:
			return "GOALKEEPER";
		case Position.DEFENDER:
			return "DEFENDER";
		case Position.FORWARD:
			return "FORWARD";
		default:
			return "MIDFIELDER";
	}
};

const lifecycleForPublication = (
	publication: LivePublicationReadV2["publication"] | null
): string => {
	return publication?.state ?? "PICKS_WAIT";
};

const snapshotStateForPublication = (
	publication: LivePublicationReadV2["publication"] | null
): string => {
	return publication?.state ?? "UNAVAILABLE";
};

const publicationDeliveryState = (publication: LivePublicationReadV2 | null): string => {
	if (!publication) return "UNAVAILABLE";
	if (publication.publication.state === "FINALIZED") return "FINAL";
	if (publication.servedFrom !== "REDIS_CURRENT") return "DEGRADED";
	return Date.now() - Date.parse(publication.publication.sourceCheckedAt) <= 30_000
		? "FRESH"
		: "STALE";
};

const publicationSource = (publication: LivePublicationReadV2 | null): string => {
	if (!publication) return "UNAVAILABLE";
	if (publication.publication.state === "FINALIZED") return "FINAL_RESULT";
	return publication.servedFrom;
};

const windowStateForPublication = (
	publication: LivePublicationReadV2["publication"] | null
): string => {
	switch (publication?.state) {
		case "LIVE_ACTIVE":
			return "LIVE_ACTIVE";
		case "BETWEEN_FIXTURES":
			return "BETWEEN_FIXTURES";
		case "DAY_SETTLING":
			return "DAY_SETTLING";
		case "GW_REVIEW":
			return "GW_REVIEW";
		case "FINALIZED":
			return "FINALIZED";
		default:
			return "PRE_DEADLINE";
	}
};

const publicationAvailability = (publication: LivePublicationReadV2 | null): string =>
	publicationDeliveryState(publication);

const publicationDelivery = (publication: LivePublicationReadV2 | null) => {
	const state = publicationDeliveryState(publication);
	return {
		state,
		servedFrom: publicationSource(publication),
		reasonCodes:
			state === "UNAVAILABLE"
				? ["PUBLICATION_UNAVAILABLE"]
				: state === "DEGRADED"
					? ["FALLBACK_SERVED"]
					: [],
	};
};

const publicationRevisionVector = (publication: LivePublicationReadV2 | null) => {
	const unavailable = "unavailable";
	if (!publication) {
		return {
			publicationId: unavailable,
			generation: 0,
			lifecycle: unavailable,
			fixtureIdentity: unavailable,
			scoreCore: unavailable,
			displayStats: unavailable,
			explain: unavailable,
			picksBase: null,
			officialAdjustment: null,
			previousTotals: null,
			finalResult: null,
			rules: unavailable,
			algorithm: "live-points-v2-algorithm-1",
			input: unavailable,
		};
	}
	const value = publication.publication;
	return {
		publicationId: value.publicationId,
		generation: value.generation,
		lifecycle: value.revisions.lifecycle.revision,
		fixtureIdentity: value.revisions.fixtureIdentity.revision,
		scoreCore: value.revisions.scoreCore.revision,
		displayStats: value.revisions.displayStats.revision,
		explain: value.revisions.explain.revision,
		picksBase: null,
		officialAdjustment: null,
		previousTotals: null,
		finalResult: null,
		rules: value.revisions.rules.revision,
		algorithm: "live-points-v2-algorithm-1",
		input: unavailable,
	};
};

const publicationTimes = (publication: LivePublicationReadV2 | null) => {
	const now = new Date().toISOString();
	if (!publication) {
		return {
			sourceCheckedAt: now,
			contentUpdatedAt: now,
			publishedAt: now,
			checkpointedAt: null,
			servedAt: now,
			staleAt: now,
			nextRefreshAt: null,
		};
	}
	const value = publication.publication;
	return {
		sourceCheckedAt: value.sourceCheckedAt,
		contentUpdatedAt: value.revisions.scoreCore.contentUpdatedAt,
		publishedAt: value.publishedAt,
		checkpointedAt: value.checkpointedAt,
		servedAt: now,
		staleAt: new Date(Date.parse(value.sourceCheckedAt) + 30_000).toISOString(),
		nextRefreshAt: value.expectedNextCheckAt,
	};
};

const toCoreFixture = (fixture: Record<string, unknown>): CoreFixtureData => ({
	id: Number(fixture.id),
	code: Number(fixture.code),
	eventId: fixture.event === null ? null : Number(fixture.event),
	finished: Boolean(fixture.finished),
	finishedProvisional: Boolean(fixture.finishedProvisional),
	kickoffTime: typeof fixture.kickoffTime === "string" ? fixture.kickoffTime : null,
	minutes: Number(fixture.minutes ?? 0),
	started: typeof fixture.started === "boolean" ? fixture.started : null,
	teamHId: Number(fixture.teamH),
	teamAId: Number(fixture.teamA),
	teamHScore: fixture.teamHScore === null ? null : Number(fixture.teamHScore),
	teamAScore: fixture.teamAScore === null ? null : Number(fixture.teamAScore),
	teamHDifficulty: fixture.teamHDifficulty === null ? null : Number(fixture.teamHDifficulty),
	teamADifficulty: fixture.teamADifficulty === null ? null : Number(fixture.teamADifficulty),
});

const toLivePerformance = (row: Record<string, unknown>): LivePerformanceData => ({
	eventId: Number(row.eventId),
	playerId: Number(row.elementId),
	minutes: row.minutes === null ? null : Number(row.minutes ?? 0),
	goalsScored: row.goalsScored === null ? null : Number(row.goalsScored ?? 0),
	assists: row.assists === null ? null : Number(row.assists ?? 0),
	cleanSheets: row.cleanSheets === null ? null : Number(row.cleanSheets ?? 0),
	goalsConceded: row.goalsConceded === null ? null : Number(row.goalsConceded ?? 0),
	ownGoals: row.ownGoals === null ? null : Number(row.ownGoals ?? 0),
	penaltiesSaved: row.penaltiesSaved === null ? null : Number(row.penaltiesSaved ?? 0),
	penaltiesMissed: row.penaltiesMissed === null ? null : Number(row.penaltiesMissed ?? 0),
	yellowCards: row.yellowCards === null ? null : Number(row.yellowCards ?? 0),
	redCards: row.redCards === null ? null : Number(row.redCards ?? 0),
	saves: row.saves === null ? null : Number(row.saves ?? 0),
	bonus: row.bonus === null ? null : Number(row.bonus ?? 0),
	bps: row.bps === null ? null : Number(row.bps ?? 0),
	starts: typeof row.starts === "boolean" ? row.starts : null,
	defensiveContribution:
		row.defensiveContribution === null ? null : Number(row.defensiveContribution ?? 0),
	expectedGoals: typeof row.expectedGoals === "string" ? row.expectedGoals : null,
	expectedAssists: typeof row.expectedAssists === "string" ? row.expectedAssists : null,
	expectedGoalInvolvements:
		typeof row.expectedGoalInvolvements === "string" ? row.expectedGoalInvolvements : null,
	expectedGoalsConceded:
		typeof row.expectedGoalsConceded === "string" ? row.expectedGoalsConceded : null,
	inDreamTeam: typeof row.inDreamTeam === "boolean" ? row.inDreamTeam : null,
	totalPoints: Number(row.totalPoints ?? 0),
});

const teamName = (core: Pick<CoreLiveIdentitySnapshot, "teams">, id: number): string =>
	core.teams.find((team) => team.id === id)?.name ?? "";

const matchRows = (
	eventId: number,
	fixtures: readonly CoreFixtureData[],
	core: Pick<CoreLiveIdentitySnapshot, "teams">
) =>
	fixtures
		.filter((fixture) => fixture.eventId === eventId)
		.map((fixture) => ({
			fixtureId: fixture.id,
			eventId,
			homeTeamId: fixture.teamHId,
			homeTeamName: teamName(core, fixture.teamHId),
			awayTeamId: fixture.teamAId,
			awayTeamName: teamName(core, fixture.teamAId),
			homeScore: fixture.teamHScore,
			awayScore: fixture.teamAScore,
			kickoffTime: fixture.kickoffTime,
			minutes: fixture.minutes,
			started: fixture.started === true,
			finished: fixture.finished,
			finishedProvisional: fixture.finishedProvisional,
		}));

type LiveWindowV2 = {
	eventCore: CoreEventSnapshot;
	fixtureCore: CoreFixtureSnapshot;
	core: CoreLiveIdentitySnapshot;
	publication: LivePublicationReadV2 | null;
	eventId: number;
};

const readLiveWindowV2 = async (
	context: GraphQLContext,
	eventId?: number
): Promise<LiveWindowV2> => {
	const [eventCore, fixtureCore, core] = await Promise.all([
		getCoreEventSnapshot(context),
		getCoreFixtureSnapshot(context),
		getCoreLiveIdentitySnapshot(context),
	]);
	const selectedEventId =
		eventId ??
		eventCore.currentEventId ??
		eventCore.events.find((event) => event.isPrevious)?.id ??
		0;
	const publication =
		selectedEventId > 0
			? await readLivePublicationV2(context, selectedEventId).catch((error) => {
					context.logger.warn(
						{ err: error, eventId: selectedEventId },
						"Live Points V2 publication unavailable for desk"
					);
					return null;
				})
			: null;
	return { eventCore, fixtureCore, core, publication, eventId: selectedEventId };
};

const assertRef = (
	context: GraphQLContext,
	ref: LiveRef | null | undefined,
	publication: LivePublicationReadV2 | null
): void => {
	if (!ref) return;
	if (!publication) {
		metrics.livePublicationEventsTotal.labels("publication_unavailable").inc();
		throw new GraphQLError("Live Points V2 publication is unavailable", {
			extensions: { code: "LIVE_POINTS_UNAVAILABLE" },
		});
	}
	if (
		ref.season !== context.currentSeason.seasonCode ||
		ref.eventId !== publication.publication.eventId ||
		ref.scoreCoreRevision !== publication.publication.revisions.scoreCore.revision
	) {
		metrics.livePublicationEventsTotal.labels("revision_gone").inc();
		throw new GraphQLError("Requested live score revision is not the current V2 publication", {
			extensions: { code: "LIVE_SCORE_REVISION_GONE" },
		});
	}
};

const assertMember = async (context: GraphQLContext, tournamentId: number, entryId: number) => {
	const tournament = await tournamentsService.getTournamentForMember(
		context,
		tournamentId,
		entryId
	);
	if (!tournament)
		throw new GraphQLError("Tournament access denied", { extensions: { code: "FORBIDDEN" } });
	return tournament;
};

const assertMemberOrManager = async (
	context: GraphQLContext,
	tournamentId: number,
	entryId: number
) => {
	const member = await tournamentsService.getTournamentForMember(context, tournamentId, entryId);
	if (member) return member;
	const principalEntryId = context.principal?.fplEntryId;
	if (
		typeof principalEntryId === "number" &&
		principalEntryId > 0 &&
		context.principal?.fplEntryVerifiedAt
	) {
		const managed = await tournamentsService.getManagedTournament(
			context,
			tournamentId,
			principalEntryId
		);
		if (managed) return managed;
	}
	throw new GraphQLError("Tournament access denied", { extensions: { code: "FORBIDDEN" } });
};

const eligibleEntryWindowForEvent = async (
	context: GraphQLContext,
	entryIds: readonly number[],
	eventId: number,
	requestingEntryId: number
): Promise<{
	entryIds: number[];
	deferredEntryIds: number[];
	totalEntries: number;
}> => {
	const uniqueEntryIds = [...new Set(entryIds)];
	const admissionWindow = selectTournamentDeskEntryWindow(
		uniqueEntryIds,
		requestingEntryId,
		MAX_TOURNAMENT_DESK_ENTRIES
	);
	try {
		const eligibility = await loadTournamentEventEligibility(
			admissionWindow.entryIds,
			eventId,
			(ids) => entriesRepository.getEntriesByIds(context, ids)
		);
		return {
			entryIds: eligibility.entryIds,
			deferredEntryIds: admissionWindow.deferredEntryIds,
			totalEntries:
				uniqueEntryIds.length <= MAX_TOURNAMENT_DESK_ENTRIES
					? eligibility.entryIds.length
					: uniqueEntryIds.length,
		};
	} catch (error) {
		// Eligibility is an optimization boundary. If metadata is unavailable,
		// retain only the bounded admission window and let the V2 projector fail
		// closed per entry rather than taking down the entire live board.
		context.logger.warn({ err: error, eventId }, "Live board entry eligibility unavailable");
		return {
			entryIds: admissionWindow.entryIds,
			deferredEntryIds: admissionWindow.deferredEntryIds,
			totalEntries: uniqueEntryIds.length,
		};
	}
};

const boardResponse = async (
	context: GraphQLContext,
	request: EntryLiveCompetitionBoardRequest,
	memberTournament: { leagueType?: string | null },
	ref: LiveRef | null
) => {
	const entryIds = await tournamentsService.getTournamentEntryIdsUncached(
		context,
		request.tournamentId
	);
	const entryWindow = await eligibleEntryWindowForEvent(
		context,
		entryIds,
		request.eventId,
		request.entryId
	);
	const { board } = await buildEntryLiveCompetitionBoardV2(context, {
		eventId: request.eventId,
		tournamentId: request.tournamentId,
		entryIds: entryWindow.entryIds,
		requireNet: memberTournament.leagueType === LeagueType.H2H,
		scoreCoreRevision: ref?.scoreCoreRevision,
	});
	const page = queryEntryLiveCompetitionBoardV2(board, request);
	const sample =
		board.rows.find((row) => row.entry === request.entryId && row.score.source !== "UNAVAILABLE") ??
		board.rows.find((row) => row.score.source !== "UNAVAILABLE") ??
		board.rows[0] ??
		null;
	const delivery = sample?.score.delivery ?? {
		state: "UNAVAILABLE",
		servedFrom: "UNAVAILABLE",
		reasonCodes: ["NO_COMPLETE_ENTRY_PROJECTION"],
	};
	const revisions = sample?.score.revisions ?? {
		publicationId: `unavailable:${request.eventId}`,
		generation: 0,
		lifecycle: "unavailable",
		fixtureIdentity: "unavailable",
		scoreCore: board.scoreCoreRevision ?? "unavailable",
		displayStats: "unavailable",
		explain: "unavailable",
		picksBase: null,
		officialAdjustment: null,
		previousTotals: null,
		finalResult: null,
		rules: "unavailable",
		algorithm: "live-points-v2-algorithm-1",
		input: "unavailable",
	};
	const now = new Date().toISOString();
	const times = sample?.score.times ?? {
		sourceCheckedAt: now,
		contentUpdatedAt: now,
		publishedAt: now,
		checkpointedAt: null,
		servedAt: now,
		staleAt: now,
		nextRefreshAt: null,
	};
	const unavailableEntryIds = board.unavailableEntryIds;
	const totalEntries = entryWindow.totalEntries;
	const deferredEntryCount = entryWindow.deferredEntryIds.length + board.deferredEntryCount;
	const partial =
		entryWindow.deferredEntryIds.length > 0 || board.partial || board.rows.length !== totalEntries;
	return {
		season: context.currentSeason.seasonCode,
		eventId: request.eventId,
		tournamentId: request.tournamentId,
		boardRevision: board.boardRevision,
		scoreCoreRevision: board.scoreCoreRevision,
		dataAvailability: delivery.state,
		coverageState: board.computedEntries === 0 ? "UNAVAILABLE" : partial ? "PARTIAL" : "COMPLETE",
		rankScope: partial ? "AVAILABLE_ROWS" : "FULL_FIELD",
		computedEntries: board.computedEntries,
		deferredEntryCount,
		failedEntryCount: board.failedEntryCount,
		unavailableEntryCount: board.unavailableEntryCount,
		officialCoverage: totalEntries === 0 ? 0 : board.computedEntries / totalEntries,
		unavailableEntryIds,
		failedEntryIds: board.failedEntryIds,
		partial,
		totalEntries,
		filteredEntries: page.filteredEntries,
		page: request.page,
		pageSize: request.pageSize,
		hasMore: page.hasMore,
		highestEventPoints: board.highestEventPoints,
		averageEventPoints: board.averageEventPoints,
		revisions,
		times,
		delivery,
		rows: page.rows,
		viewerRow: page.viewerRow,
	};
};

export const liveDesksResolvers = {
	Query: {
		liveContext: async (_parent: unknown, _args: unknown, context: GraphQLContext) => {
			const window = await readLiveWindowV2(context);
			const publication = window.publication;
			return {
				season: context.currentSeason.seasonCode,
				coreRevision: window.eventCore.revision,
				currentEventId: window.eventCore.currentEventId,
				nextEventId: window.eventCore.events.find((event) => event.isNext)?.id ?? null,
				anchorEventId: publication?.publication.eventId ?? window.eventCore.currentEventId,
				latestFinalizedEventId:
					window.eventCore.events
						.filter((event) => event.finished && event.dataChecked)
						.sort((a, b) => b.id - a.id)[0]?.id ?? null,
				scoreCoreRevision: publication?.publication.revisions.scoreCore.revision ?? null,
				state: lifecycleForPublication(publication?.publication ?? null),
				windowState: windowStateForPublication(publication?.publication ?? null),
				producerState: lifecycleForPublication(publication?.publication ?? null),
				anchorMode: publication
					? window.eventCore.currentEventId === publication.publication.eventId
						? "CURRENT"
						: "PREVIOUS_FINAL"
					: window.eventCore.currentEventId === null
						? "OFFSEASON"
						: "UPCOMING",
				dataAvailability: publicationAvailability(publication),
				sourceCheckedAt:
					publication?.publication.sourceCheckedAt ?? window.fixtureCore.sourceCheckedAt,
				publishedAt: publication?.publication.publishedAt ?? window.fixtureCore.sourceCheckedAt,
				source: publicationSource(publication),
				stale:
					publicationDeliveryState(publication) === "STALE" ||
					publicationDeliveryState(publication) === "DEGRADED" ||
					publicationDeliveryState(publication) === "UNAVAILABLE",
				nextRefreshAt: publication?.publication.expectedNextCheckAt ?? null,
				revisions: publicationRevisionVector(publication),
				times: publicationTimes(publication),
				delivery: publicationDelivery(publication),
			};
		},
		liveMatchdayDesk: async (
			_parent: unknown,
			args: { ref?: LiveRef | null },
			context: GraphQLContext
		) => {
			const window = await readLiveWindowV2(context, args.ref?.eventId);
			assertRef(context, args.ref, window.publication);
			const publication = window.publication;
			const eventId = window.eventId;
			const fixtures =
				publication?.fixtures.map((fixture) =>
					toCoreFixture(fixture as unknown as Record<string, unknown>)
				) ?? window.fixtureCore.fixtures;
			const eventLives =
				publication?.eventLives.map((row) =>
					toLivePerformance(row as unknown as Record<string, unknown>)
				) ?? [];
			return {
				season: context.currentSeason.seasonCode,
				eventId,
				scoreCoreRevision:
					publication?.publication.revisions.scoreCore.revision ??
					`pre-deadline:${window.fixtureCore.revision}`,
				state: snapshotStateForPublication(publication?.publication ?? null),
				windowState: windowStateForPublication(publication?.publication ?? null),
				dataAvailability: publicationAvailability(publication),
				sourceCheckedAt:
					publication?.publication.sourceCheckedAt ?? window.fixtureCore.sourceCheckedAt,
				publishedAt: publication?.publication.publishedAt ?? window.fixtureCore.sourceCheckedAt,
				source: publicationSource(publication),
				stale:
					publicationDeliveryState(publication) === "STALE" ||
					publicationDeliveryState(publication) === "DEGRADED" ||
					publicationDeliveryState(publication) === "UNAVAILABLE",
				nextRefreshAt: publication?.publication.expectedNextCheckAt ?? null,
				revisions: publicationRevisionVector(publication),
				times: publicationTimes(publication),
				delivery: publicationDelivery(publication),
				matches: matchRows(eventId, fixtures, window.core),
				highlights: eventLives.sort((a, b) => b.totalPoints - a.totalPoints).slice(0, 10),
			};
		},
		liveFixturePlayers: async (
			_parent: unknown,
			args: { ref: LiveRef; fixtureId: number },
			context: GraphQLContext
		) => {
			const window = await readLiveWindowV2(context, args.ref.eventId);
			assertRef(context, args.ref, window.publication);
			if (!window.publication) {
				throw new GraphQLError("Live Points V2 publication is unavailable", {
					extensions: { code: "LIVE_POINTS_UNAVAILABLE" },
				});
			}
			const fixture = (window.publication?.fixtures ?? []).find(
				(candidate) => Number(candidate.id) === args.fixtureId
			);
			if (!fixture)
				throw new GraphQLError("Fixture is not in this live publication", {
					extensions: { code: "NOT_FOUND" },
				});
			const fixtureData = toCoreFixture(fixture as unknown as Record<string, unknown>);
			const ids = new Set([fixtureData.teamHId, fixtureData.teamAId]);
			return {
				season: context.currentSeason.seasonCode,
				eventId: args.ref.eventId,
				scoreCoreRevision: window.publication.publication.revisions.scoreCore.revision,
				fixtureId: args.fixtureId,
				players: (window.publication?.eventLives ?? [])
					.filter((row) =>
						ids.has(
							window.core.players.find((player) => player.id === Number(row.elementId))?.teamId ?? 0
						)
					)
					.map((row) => toLivePerformance(row as unknown as Record<string, unknown>)),
			};
		},
		entryLiveCompetitionBoard: async (
			_parent: unknown,
			args: Record<string, unknown>,
			context: GraphQLContext
		) => {
			const request = normalizeEntryLiveCompetitionBoardRequestV2(args);
			const ref = (args.ref as LiveRef | null | undefined) ?? null;
			const publication = await readLivePublicationV2(context, request.eventId).catch(() => null);
			assertRef(context, ref, publication);
			const memberTournament = await assertMemberOrManager(
				context,
				request.tournamentId,
				request.entryId
			);
			await getCoreEventSnapshot(context);
			return boardResponse(context, request, memberTournament, ref);
		},
		entryLiveCompetitionsDesk: async (
			_parent: unknown,
			args: { entryId: number; selectedTournamentId?: number | null; ref?: LiveRef | null },
			context: GraphQLContext
		) => {
			const tournaments = await tournamentsService.getEntryTournaments(context, args.entryId);
			const selected =
				args.selectedTournamentId &&
				tournaments.some((tournament) => tournament.id === args.selectedTournamentId)
					? args.selectedTournamentId
					: (tournaments[0]?.id ?? null);
			if (!selected)
				return {
					season: context.currentSeason.seasonCode,
					eventId: args.ref?.eventId ?? 0,
					scoreCoreRevision: null,
					state: "UNAVAILABLE",
					windowState: "PRE_DEADLINE",
					dataAvailability: "UNAVAILABLE",
					nextRefreshAt: null,
					tournaments,
					selectedTournamentId: null,
					board: [],
					officialCoverage: 0,
					revisions: null,
					times: null,
					delivery: {
						state: "UNAVAILABLE",
						servedFrom: "UNAVAILABLE",
						reasonCodes: ["NO_TOURNAMENT"],
					},
					unavailableEntryIds: [],
					partial: false,
					failedEntryIds: [],
					deferredEntryCount: 0,
					totalEntries: 0,
				};
			await assertMember(context, selected, args.entryId);
			const eventCore = await getCoreEventSnapshot(context);
			const eventId =
				args.ref?.eventId ??
				eventCore?.currentEventId ??
				eventCore?.events.find((event) => event.isPrevious)?.id ??
				0;
			const publication =
				eventId > 0 ? await readLivePublicationV2(context, eventId).catch(() => null) : null;
			assertRef(context, args.ref, publication);
			const allEntryIds = await tournamentsService.getTournamentEntryIdsUncached(context, selected);
			const entryWindow = await eligibleEntryWindowForEvent(
				context,
				allEntryIds,
				eventId,
				args.entryId
			);
			const { results, errors } = await calcLivePointsForEntriesV2(
				context,
				eventId,
				entryWindow.entryIds,
				{
					scoreCoreRevision: args.ref?.scoreCoreRevision,
				}
			);
			const usable = (row: { availability: string; score: { source: string } }): boolean =>
				row.availability === "READY" && row.score.source !== "UNAVAILABLE";
			const sample =
				results.get(args.entryId) && usable(results.get(args.entryId)!)
					? results.get(args.entryId)!
					: ([...results.values()].find(usable) ?? results.values().next().value ?? null);
			const selectedTournament = tournaments.find((tournament) => tournament.id === selected);
			const useNetEventPoints = selectedTournament?.leagueType === LeagueType.H2H;
			const orderedResults = [...results.values()].sort(
				(left, right) =>
					Number(usable(right)) - Number(usable(left)) ||
					(useNetEventPoints
						? right.score.netEventPoints - left.score.netEventPoints
						: right.score.eventPoints - left.score.eventPoints) ||
					left.entry - right.entry
			);
			return {
				season: context.currentSeason.seasonCode,
				eventId,
				scoreCoreRevision: publication?.publication.revisions.scoreCore.revision ?? null,
				state: publication?.publication.state ?? "UNAVAILABLE",
				windowState: windowStateForPublication(publication?.publication ?? null),
				dataAvailability: publicationAvailability(publication),
				nextRefreshAt: publication?.publication.expectedNextCheckAt ?? null,
				tournaments,
				selectedTournamentId: selected,
				board: orderedResults,
				officialCoverage:
					entryWindow.totalEntries === 0
						? 0
						: [...results.values()].filter((row) => row.availability === "READY").length /
							entryWindow.totalEntries,
				unavailableEntryIds: entryWindow.entryIds.filter(
					(entryId) => !results.get(entryId) || results.get(entryId)?.availability !== "READY"
				),
				partial:
					entryWindow.deferredEntryIds.length > 0 ||
					[...results.values()].some((row) => row.availability !== "READY") ||
					results.size !== entryWindow.entryIds.length,
				failedEntryIds: errors.map((error) => error.entryId).sort((left, right) => left - right),
				deferredEntryCount: entryWindow.deferredEntryIds.length,
				totalEntries: entryWindow.totalEntries,
				revisions: sample?.score.revisions ?? null,
				times: sample?.score.times ?? null,
				delivery: sample?.delivery ?? {
					state: "UNAVAILABLE",
					servedFrom: "UNAVAILABLE",
					reasonCodes: ["NO_COMPLETE_ENTRY_PROJECTION"],
				},
			};
		},
		tournamentSelectionIndex: async (
			_parent: unknown,
			args: { entryId: number; tournamentId: number; ref: LiveRef },
			context: GraphQLContext
		) => {
			await assertMember(context, args.tournamentId, args.entryId);
			const publication = await readLivePublicationV2(context, args.ref.eventId).catch(() => null);
			assertRef(context, args.ref, publication);
			if (!publication)
				throw new GraphQLError("Live Points V2 publication is unavailable", {
					extensions: { code: "LIVE_POINTS_UNAVAILABLE" },
				});
			const rows = await getTournamentSelectionIndexRows(
				context,
				args.tournamentId,
				args.ref.eventId
			);
			const eventMaps = await getPlayerAndTeamMaps(
				context,
				rows.map((row) => row.playerId),
				args.ref.eventId,
				context.currentSeason.seasonCode
			);
			if (!eventMaps.eventTeamResolutionComplete)
				throw new Error("Historical player team metadata unavailable for selection index");
			return {
				tournamentId: args.tournamentId,
				eventId: args.ref.eventId,
				scoreCoreRevision: publication.publication.revisions.scoreCore.revision,
				rows: rows.map((row) => {
					const player = eventMaps.playerMap.get(row.playerId);
					const team = player ? eventMaps.teamMap.get(player.team_id) : undefined;
					if (!player || !team)
						throw new Error(`Historical selection metadata unavailable for player ${row.playerId}`);
					return {
						...row,
						playerName: player.web_name,
						teamId: player.team_id,
						teamName: team.name,
						teamShortName: team.short_name,
						position: selectionPositionName(player.type),
					};
				}),
			};
		},
		tournamentEntrySquads: async (
			_parent: unknown,
			args: { entryId: number; tournamentId: number; comparedEntryIds: number[]; ref: LiveRef },
			context: GraphQLContext
		) => {
			await assertMember(context, args.tournamentId, args.entryId);
			const publication = await readLivePublicationV2(context, args.ref.eventId).catch(() => null);
			assertRef(context, args.ref, publication);
			if (!publication)
				throw new GraphQLError("Live Points V2 publication is unavailable", {
					extensions: { code: "LIVE_POINTS_UNAVAILABLE" },
				});
			const ids = [...new Set([args.entryId, ...args.comparedEntryIds])].slice(0, 2);
			const result = await calcLivePointsForEntriesV2(context, args.ref.eventId, ids);
			return {
				tournamentId: args.tournamentId,
				eventId: args.ref.eventId,
				scoreCoreRevision: publication.publication.revisions.scoreCore.revision,
				state: publication.publication.state,
				entries: [...result.results.values()],
			};
		},
		tournamentLiveParticipants: async (
			_parent: unknown,
			args: { entryId: number; tournamentId: number },
			context: GraphQLContext
		) => {
			await assertMember(context, args.tournamentId, args.entryId);
			return tournamentsService.getTournamentParticipants(context, args.tournamentId);
		},
	},
};
