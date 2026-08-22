import { createHash } from "node:crypto";
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
import {
	managerScoreBoardIsFinal,
	rankTournamentRowsByOfficialEventPoints,
} from "../entry-live/manager-score";
import { getTournamentSelectionIndexRows } from "../event-stats/repository";
import { LeagueType } from "../leagues/repository";
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

const managerBoardMeta = (
	board: Array<{
		entry: number;
		score?: { eventPoints?: number | null; source?: string; revision?: string | null };
	}>
) => {
	const isOfficialSource = (source?: string): boolean =>
		source === "FPL_ENTRY_SUMMARY" ||
		source === "FPL_CLASSIC_STANDINGS" ||
		source === "FPL_FINAL_RESULT";
	const unavailableEntryIds = board
		.filter(
			(row) =>
				row.score?.source === "UNAVAILABLE" ||
				(isOfficialSource(row.score?.source) && typeof row.score?.eventPoints !== "number")
		)
		.map((row) => row.entry);
	const officialRows = board.filter(
		(row) => isOfficialSource(row.score?.source) && typeof row.score?.eventPoints === "number"
	);
	const revisions = board
		.map((row) => (row.score?.revision ? `${row.entry}:${row.score.revision}` : null))
		.filter((revision): revision is string => Boolean(revision))
		.sort();
	const managerRevision =
		revisions.length > 0
			? createHash("sha256").update(revisions.join("|"), "utf8").digest("hex").slice(0, 16)
			: null;
	return {
		managerRevision,
		officialCoverage: board.length === 0 ? 0 : officialRows.length / board.length,
		unavailableEntryIds,
	};
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
					managerRevision: null,
					officialCoverage: 0,
					unavailableEntryIds: [],
					partial: false,
					failedEntryIds: [],
					totalEntries: 0,
				};
			await assertMember(context, selected, args.entryId);
			const boardCacheKey = competitionBoardCacheKey(context, resolved.snapshot, selected);
			// Manager scores have an independent revision from the player-live
			// publication. Do not serve a provisional board cache keyed only by the
			// player revision; the Data service's bounded Redis read is the source
			// of truth for this request.
			const cachedCandidate = provisional ? null : await readCompetitionBoardCache(context, boardCacheKey);
			const cachedRows = cachedCandidate?.board as Array<{
				entry: number;
				score?: { source?: string; state?: string };
			}> | undefined;
			const cachedBoard = cachedCandidate && cachedRows && managerScoreBoardIsFinal(cachedRows)
				? cachedCandidate
				: null;
			if (cachedBoard) {
				const boardMeta = managerBoardMeta(
					cachedBoard.board as Array<{
						entry: number;
						score?: { eventPoints?: number | null; source?: string; revision?: string | null };
					}>
				);
				return {
					season: context.currentSeason.seasonCode,
					eventId: resolved.snapshot.eventId,
					revision: resolved.snapshot.revision,
					state: resolved.snapshot.state.toUpperCase(),
					tournaments,
					selectedTournamentId: selected,
					...boardMeta,
					...cachedBoard,
				};
			}
			const entryIds = await tournamentsService.getTournamentEntryIds(context, selected);
			const selectedTournament = tournaments.find((tournament) => tournament.id === selected);
			const result = await entryLiveBatchService.calcLivePointsForEntries(
				context,
				resolved.snapshot.eventId,
				entryIds,
				true,
				{ tournamentId: selected, legacyH2H: selectedTournament?.leagueType === LeagueType.H2H }
			);
			const board = rankTournamentRowsByOfficialEventPoints(Array.from(result.results.values()));
			const boardMeta = managerBoardMeta(board);
			// `revision` remains the player-live publication ref so existing
			// LiveRevisionRefInput callers can round-trip it. `managerRevision` is
			// the stable composite of all manager-score rows and is the independent
			// freshness signal consumed by the clients.
			const response = {
				season: context.currentSeason.seasonCode,
				eventId: resolved.snapshot.eventId,
				revision: resolved.snapshot.revision,
				state: resolved.snapshot.state.toUpperCase(),
				tournaments,
				selectedTournamentId: selected,
				...boardMeta,
				board,
				partial: result.errors.length > 0,
				failedEntryIds: result.errors.map((error) => error.entryId),
				totalEntries: result.meta.totalEntries,
			};
			if (result.errors.length === 0 && managerScoreBoardIsFinal(board)) {
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
			const memberTournament = await assertMember(context, args.tournamentId, args.entryId);
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
				{ tournamentId: args.tournamentId, legacyH2H: memberTournament.leagueType === LeagueType.H2H }
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
