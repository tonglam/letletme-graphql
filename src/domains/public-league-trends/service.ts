import type { GraphQLContext } from "../../graphql/context";
import type { TournamentSelectionStats } from "../event-stats/repository";
import { publicLeagueTrendsRepository, type PublicLeagueTrend } from "./repository";

export const publicLeagueTrendsService = {
	list(context: GraphQLContext): Promise<PublicLeagueTrend[]> {
		return publicLeagueTrendsRepository.list(context);
	},
	getSelectionStats(
		context: GraphQLContext,
		tournamentId: number,
		eventId: number,
		limit: number
	): Promise<TournamentSelectionStats | null> {
		return publicLeagueTrendsRepository.getSelectionStats(context, tournamentId, eventId, limit);
	},
};
