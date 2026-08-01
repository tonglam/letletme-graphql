import type { GraphQLContext } from "../../graphql/context";
import type { League, LeagueEventResult } from "./repository";
import { leaguesRepository } from "./repository";

export const leaguesService = {
	getEntryLeagues(context: GraphQLContext, entryId: number): Promise<League[]> {
		return leaguesRepository.getEntryLeagues(context, entryId);
	},

	getLeagueEventResults(
		context: GraphQLContext,
		leagueId: number,
		eventId: number
	): Promise<LeagueEventResult[]> {
		return leaguesRepository.getLeagueEventResults(context, leagueId, eventId);
	},
};
