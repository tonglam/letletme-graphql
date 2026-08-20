import type { GraphQLContext } from "../../graphql/context";
import { GraphQLError } from "graphql";
import type {
	EntryH2HMatchResult,
	EntryOfficialH2HDeskItem,
	TournamentBattleGroupResult,
	TournamentEntryRankingSummary,
	TournamentEventResult,
	TournamentInfo,
	TournamentOfficialH2H,
	TournamentParticipant,
	TournamentSeasonSnapshot,
	TournamentDetailDesk,
	ManagedTournamentStatus,
} from "./repository";
import { tournamentsRepository } from "./repository";

export const assertTournamentStandingsReady = async (
	context: GraphQLContext,
	tournamentId: number
): Promise<TournamentInfo> => {
	const tournament = await tournamentsRepository.getTournamentInfoUncached(context, tournamentId);
	if (!tournament?.standingsReadyAt) {
		throw new GraphQLError("Tournament standings are still being prepared", {
			extensions: { code: "TOURNAMENT_STANDINGS_NOT_READY" },
		});
	}
	return tournament;
};

export const assertTournamentInsightsReady = async (
	context: GraphQLContext,
	tournamentId: number
): Promise<TournamentInfo> => {
	const tournament = await assertTournamentStandingsReady(context, tournamentId);
	if (
		tournament.setupStatus !== "ready" ||
		tournament.setupPhase !== "ready" ||
		!tournament.insightsReadyAt
	) {
		throw new GraphQLError("Tournament insights are still being prepared", {
			extensions: { code: "TOURNAMENT_INSIGHTS_NOT_READY" },
		});
	}
	return tournament;
};

export const tournamentsService = {
	getTournamentForMember(
		context: GraphQLContext,
		tournamentId: number,
		entryId: number
	): Promise<TournamentInfo | null> {
		return tournamentsRepository.getTournamentForMember(context, tournamentId, entryId);
	},

	getManagedTournament(
		context: GraphQLContext,
		tournamentId: number,
		entryId: number
	): Promise<TournamentInfo | null> {
		return tournamentsRepository.getManagedTournament(context, tournamentId, entryId);
	},

	getTournamentParticipants(
		context: GraphQLContext,
		tournamentId: number
	): Promise<TournamentParticipant[]> {
		return tournamentsRepository.getTournamentParticipants(context, tournamentId);
	},

	getEntryTournaments(context: GraphQLContext, entryId: number): Promise<TournamentInfo[]> {
		return tournamentsRepository.getEntryTournaments(context, entryId);
	},

	getTournamentEntryIds(context: GraphQLContext, tournamentId: number): Promise<number[]> {
		return tournamentsRepository.getTournamentEntryIds(context, tournamentId);
	},

	getTournamentEntryIdsUncached(context: GraphQLContext, tournamentId: number): Promise<number[]> {
		return tournamentsRepository.getTournamentEntryIdsUncached(context, tournamentId);
	},

	getTournamentEventResults(
		context: GraphQLContext,
		tournamentId: number,
		eventId: number,
		limit: number | null,
		offset: number | null
	): Promise<TournamentEventResult[]> {
		return tournamentsRepository.getTournamentEventResults(
			context,
			tournamentId,
			eventId,
			limit,
			offset
		);
	},

	getTournamentEntryRankingSummary(
		context: GraphQLContext,
		tournamentId: number,
		eventId: number,
		entryId: number
	): Promise<TournamentEntryRankingSummary> {
		return tournamentsRepository.getTournamentEntryRankingSummary(
			context,
			tournamentId,
			eventId,
			entryId
		);
	},

	getTournamentSeasonSnapshot(
		context: GraphQLContext,
		tournamentId: number,
		eventId: number
	): Promise<TournamentSeasonSnapshot> {
		return tournamentsRepository.getTournamentSeasonSnapshot(context, tournamentId, eventId);
	},

	getTournamentBattleGroupResults(
		context: GraphQLContext,
		tournamentId: number,
		eventId: number
	): Promise<TournamentBattleGroupResult[]> {
		return tournamentsRepository.getTournamentBattleGroupResults(context, tournamentId, eventId);
	},

	async getEntryH2HMatchResults(
		context: GraphQLContext,
		entryId: number
	): Promise<EntryH2HMatchResult[]> {
		return tournamentsRepository.getEntryH2HMatchResults(context, entryId);
	},

	getTournamentOfficialH2H(
		context: GraphQLContext,
		tournamentId: number,
		eventId: number
	): Promise<TournamentOfficialH2H> {
		return tournamentsRepository.getTournamentOfficialH2H(context, tournamentId, eventId);
	},

	getEntryOfficialH2HDesk(
		context: GraphQLContext,
		entryId: number
	): Promise<EntryOfficialH2HDeskItem[]> {
		return tournamentsRepository.getEntryOfficialH2HDesk(context, entryId);
	},

	getTournamentDetailDesk(
		context: GraphQLContext,
		tournamentId: number,
		entryId: number,
		eventId?: number | null
	): Promise<TournamentDetailDesk | null> {
		return tournamentsRepository.getTournamentDetailDesk(context, tournamentId, entryId, eventId);
	},

	getManagedTournamentStatus(
		context: GraphQLContext,
		tournamentId: number,
		entryId: number
	): Promise<ManagedTournamentStatus | null> {
		return tournamentsRepository.getManagedTournamentStatus(context, tournamentId, entryId);
	},
};
