import type { GraphQLContext } from "../../graphql/context";
import type { TournamentSelectionStats } from "./repository";
import { eventStatsRepository } from "./repository";

export const eventStatsService = {
	async getTournamentSelectionStats(
		context: GraphQLContext,
		tournamentId: number,
		eventId: number,
		limit: number
	): Promise<TournamentSelectionStats> {
		return eventStatsRepository.getTournamentSelectionStats(context, tournamentId, eventId, limit);
	},
};
