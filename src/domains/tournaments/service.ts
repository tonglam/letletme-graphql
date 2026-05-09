import type { GraphQLContext } from "../../graphql/context";
import type {
	EntryH2HMatchResult,
	TournamentBattleGroupResult,
	TournamentEntryRankingSummary,
	TournamentEventResult,
	TournamentInfo,
} from "./repository";
import { tournamentsRepository } from "./repository";

export const tournamentsService = {
	getEntryTournaments(
		context: GraphQLContext,
		entryId: number,
	): Promise<TournamentInfo[]> {
		return tournamentsRepository.getEntryTournaments(context, entryId);
	},

	getTournamentEntryIds(
		context: GraphQLContext,
		tournamentId: number,
	): Promise<number[]> {
		return tournamentsRepository.getTournamentEntryIds(context, tournamentId);
	},

	getTournamentEventResults(
		context: GraphQLContext,
		tournamentId: number,
		eventId: number,
	): Promise<TournamentEventResult[]> {
		return tournamentsRepository.getTournamentEventResults(
			context,
			tournamentId,
			eventId,
		);
	},

	getTournamentEntryRankingSummary(
		context: GraphQLContext,
		tournamentId: number,
		eventId: number,
		entryId: number,
	): Promise<TournamentEntryRankingSummary> {
		return tournamentsRepository.getTournamentEntryRankingSummary(
			context,
			tournamentId,
			eventId,
			entryId,
		);
	},

	getTournamentBattleGroupResults(
		context: GraphQLContext,
		tournamentId: number,
		eventId: number,
	): Promise<TournamentBattleGroupResult[]> {
		return tournamentsRepository.getTournamentBattleGroupResults(
			context,
			tournamentId,
			eventId,
		);
	},

	getEntryH2HMatchResults(
		context: GraphQLContext,
		entryId: number,
	): Promise<EntryH2HMatchResult[]> {
		return tournamentsRepository.getEntryH2HMatchResults(context, entryId);
	},
};
