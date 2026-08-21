import { GraphQLError } from "graphql";
import type { GraphQLContext } from "../../graphql/context";
import {
	getCoreEventSnapshot,
	getCoreFixtureSnapshot,
	getCoreLiveIdentitySnapshot,
	getLiveDataPublicationManifest,
	getLiveDataSnapshot,
	type CoreLiveIdentitySnapshot,
	type LiveDataSnapshot,
} from "../../infra/data-snapshot";
import { entryLiveBatchService } from "../entry-live/batch-service";
import { getTournamentSelectionIndexRows } from "../event-stats/repository";
import { tournamentsService } from "../tournaments/service";
import {
	competitionBoardCacheKey,
	readCompetitionBoardCache,
	writeCompetitionBoardCache,
} from "./competition-board-cache";

type LiveRef = { season: string; eventId: number; revision: string };

const resolveSnapshot = async (
	context: GraphQLContext,
	ref?: LiveRef | null
): Promise<{ snapshot: LiveDataSnapshot; core: CoreLiveIdentitySnapshot }> => {
	if (ref && ref.season !== context.currentSeason.seasonCode) {
		throw new GraphQLError("Live revision belongs to another season", {
			extensions: { code: "LIVE_REVISION_GONE" },
		});
	}
	const snapshot = await getLiveDataSnapshot(
		context,
		ref?.eventId ?? (await getCoreEventSnapshot(context)).currentEventId ?? 0
	).catch((error) => {
		throw new GraphQLError("Live publication is unavailable", {
			extensions: { code: "LIVE_PUBLICATION_UNAVAILABLE", cause: error },
		});
	});
	if (ref && snapshot.revision !== ref.revision) {
		throw new GraphQLError("Requested live revision has expired", {
			extensions: { code: "LIVE_REVISION_GONE" },
		});
	}
	const core = await getCoreLiveIdentitySnapshot(context);
	return { snapshot, core };
};

const teamName = (core: Pick<CoreLiveIdentitySnapshot, "teams">, id: number): string =>
	core.teams.find((team) => team.id === id)?.name ?? "";

const matchRows = (
	snapshot: Pick<LiveDataSnapshot, "eventId" | "fixtures">,
	core: Pick<CoreLiveIdentitySnapshot, "teams">
) =>
	snapshot.fixtures.map((fixture) => ({
		fixtureId: fixture.id,
		eventId: snapshot.eventId,
		homeTeamId: fixture.teamHId,
		homeTeamName: teamName(core, fixture.teamHId),
		awayTeamId: fixture.teamAId,
		awayTeamName: teamName(core, fixture.teamAId),
		homeScore: fixture.teamHScore,
		awayScore: fixture.teamAScore,
		kickoffTime: fixture.kickoffTime,
		minutes: fixture.minutes,
		started: fixture.started === true,
		finished: fixture.finished || fixture.finishedProvisional,
	}));

const assertMember = async (context: GraphQLContext, tournamentId: number, entryId: number) => {
	const tournament = await tournamentsService.getTournamentForMember(
		context,
		tournamentId,
		entryId
	);
	if (!tournament) {
		throw new GraphQLError("Tournament access denied", { extensions: { code: "FORBIDDEN" } });
	}
	return tournament;
};

export const liveDesksResolvers = {
	Query: {
		liveContext: async (_parent: unknown, _args: unknown, context: GraphQLContext) => {
			const core = await getCoreEventSnapshot(context);
			const eventId = core.currentEventId;
			const current = eventId ? await getLiveDataPublicationManifest(context, eventId) : null;
			const currentEvent = eventId ? core.events.find((event) => event.id === eventId) : null;
			return {
				season: context.currentSeason.seasonCode,
				coreRevision: core.revision,
				currentEventId: eventId,
				nextEventId: core.events.find((event) => event.isNext)?.id ?? null,
				liveRevision: current ? String(current.revision) : null,
				state: current
					? current.state === "active"
						? "LIVE_ACTIVE"
						: current.state === "settled"
							? currentEvent?.finished && currentEvent.dataChecked
								? "FINALIZED"
								: "GW_REVIEW"
							: "SCHEDULED"
					: "SCHEDULED",
				sourceCheckedAt: current?.sourceCheckedAt ?? null,
				publishedAt: current?.publishedAt ?? null,
				source: current ? "REDIS" : null,
				stale: false,
			};
		},
		liveMatchdayDesk: async (
			_parent: unknown,
			args: { ref?: LiveRef | null },
			context: GraphQLContext
		) => {
			const [{ snapshot, core }, fixtureCore, eventCore] = await Promise.all([
				resolveSnapshot(context, args.ref),
				getCoreFixtureSnapshot(context),
				getCoreEventSnapshot(context),
			]);
			const nextEventId = eventCore.events.find((event) => event.isNext)?.id ?? null;
			return {
				season: snapshot.seasonCode,
				eventId: snapshot.eventId,
				revision: snapshot.revision,
				state: snapshot.state.toUpperCase(),
				publishedAt: snapshot.publishedAt,
				matches: matchRows(snapshot, core),
				nextFixtures: nextEventId
					? matchRows(
							{
								...snapshot,
								eventId: nextEventId,
								fixtures: fixtureCore.fixtures.filter((fixture) => fixture.eventId === nextEventId),
							},
							fixtureCore
						)
					: [],
				highlights: [...snapshot.eventLives]
					.sort((a, b) => b.totalPoints - a.totalPoints)
					.slice(0, 10),
			};
		},
		liveFixturePlayers: async (
			_parent: unknown,
			args: { ref: LiveRef; fixtureId: number },
			context: GraphQLContext
		) => {
			const { snapshot, core } = await resolveSnapshot(context, args.ref);
			const fixture = snapshot.fixtures.find((row) => row.id === args.fixtureId);
			if (!fixture)
				throw new GraphQLError("Fixture is not in this live revision", {
					extensions: { code: "NOT_FOUND" },
				});
			const ids = new Set([fixture.teamHId, fixture.teamAId]);
			const playerIds = new Set(
				core.players.filter((player) => ids.has(player.teamId)).map((player) => player.id)
			);
			return {
				season: snapshot.seasonCode,
				eventId: snapshot.eventId,
				revision: snapshot.revision,
				fixtureId: args.fixtureId,
				players: snapshot.eventLives.filter((row) => playerIds.has(row.playerId)),
			};
		},
		entryLiveCompetitionsDesk: async (
			_parent: unknown,
			args: { entryId: number; selectedTournamentId?: number | null; ref?: LiveRef | null },
			context: GraphQLContext
		) => {
			const [tournaments, resolved, eventCore] = await Promise.all([
				tournamentsService.getEntryTournaments(context, args.entryId),
				resolveSnapshot(context, args.ref),
				getCoreEventSnapshot(context),
			]);
			const event = eventCore.events.find(
				(candidate) => candidate.id === resolved.snapshot.eventId
			);
			const provisional = !(event?.finished && event.dataChecked);
			// A stale/deep-linked tournament id must not trigger an authorization
			// probe for an arbitrary tournament. Fall back to the first membership
			// returned for this entry and keep the desk single-request.
			const selected =
				(args.selectedTournamentId &&
				tournaments.some((item) => item.id === args.selectedTournamentId)
					? args.selectedTournamentId
					: null) ??
				tournaments[0]?.id ??
				null;
			if (!selected)
				return {
					season: context.currentSeason.seasonCode,
					eventId: resolved.snapshot.eventId,
					revision: resolved.snapshot.revision,
					state: resolved.snapshot.state.toUpperCase(),
					tournaments,
					selectedTournamentId: null,
					board: [],
					partial: false,
					failedEntryIds: [],
					totalEntries: 0,
				};
			await assertMember(context, selected, args.entryId);
			const boardCacheKey = competitionBoardCacheKey(context, resolved.snapshot, selected);
			const cachedBoard = await readCompetitionBoardCache(context, boardCacheKey);
			if (cachedBoard) {
				return {
					season: context.currentSeason.seasonCode,
					eventId: resolved.snapshot.eventId,
					revision: resolved.snapshot.revision,
					state: resolved.snapshot.state.toUpperCase(),
					tournaments,
					selectedTournamentId: selected,
					...cachedBoard,
				};
			}
			const entryIds = await tournamentsService.getTournamentEntryIds(context, selected);
			const result = await entryLiveBatchService.calcLivePointsForEntries(
				context,
				resolved.snapshot.eventId,
				entryIds,
				true,
				{ provisional }
			);
			const board = Array.from(result.results.values());
			const response = {
				season: context.currentSeason.seasonCode,
				eventId: resolved.snapshot.eventId,
				revision: resolved.snapshot.revision,
				state: resolved.snapshot.state.toUpperCase(),
				tournaments,
				selectedTournamentId: selected,
				board,
				partial: result.errors.length > 0,
				failedEntryIds: result.errors.map((error) => error.entryId),
				totalEntries: result.meta.totalEntries,
			};
			if (result.errors.length === 0) {
				await writeCompetitionBoardCache(
					context,
					boardCacheKey,
					{
						board,
						partial: false,
						failedEntryIds: [],
						totalEntries: result.meta.totalEntries,
					},
					provisional ? 6 * 60 * 60 : 24 * 60 * 60
				);
			}
			return response;
		},
		tournamentSelectionIndex: async (
			_parent: unknown,
			args: { entryId: number; tournamentId: number; ref: LiveRef },
			context: GraphQLContext
		) => {
			await assertMember(context, args.tournamentId, args.entryId);
			const { snapshot } = await resolveSnapshot(context, args.ref);
			const rows = await getTournamentSelectionIndexRows(
				context,
				args.tournamentId,
				snapshot.eventId
			);
			return {
				tournamentId: args.tournamentId,
				eventId: snapshot.eventId,
				revision: snapshot.revision,
				rows,
			};
		},
		tournamentEntrySquads: async (
			_parent: unknown,
			args: { entryId: number; tournamentId: number; comparedEntryIds: number[]; ref: LiveRef },
			context: GraphQLContext
		) => {
			await assertMember(context, args.tournamentId, args.entryId);
			const [{ snapshot }, eventCore] = await Promise.all([
				resolveSnapshot(context, args.ref),
				getCoreEventSnapshot(context),
			]);
			const event = eventCore.events.find((candidate) => candidate.id === snapshot.eventId);
			const provisional = !(event?.finished && event.dataChecked);
			const ids = Array.from(new Set([args.entryId, ...args.comparedEntryIds])).slice(0, 2);
			const result = await entryLiveBatchService.calcLivePointsForEntries(
				context,
				snapshot.eventId,
				ids,
				true,
				{ provisional }
			);
			return {
				tournamentId: args.tournamentId,
				eventId: snapshot.eventId,
				revision: snapshot.revision,
				state: snapshot.state.toUpperCase(),
				entries: Array.from(result.results.values()),
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
