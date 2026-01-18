import type { GraphQLContext } from '../../graphql/context';
import type { League, LeagueEventResult, LeagueStanding } from './repository';
import { leaguesRepository } from './repository';

export const leaguesService = {
  getEntryLeagues(context: GraphQLContext, entryId: number): Promise<League[]> {
    return leaguesRepository.getEntryLeagues(context, entryId);
  },

  getLeagueStandings(
    context: GraphQLContext,
    leagueId: number,
    limit: number
  ): Promise<LeagueStanding[]> {
    return leaguesRepository.getLeagueStandings(context, leagueId, limit);
  },

  getLeagueEventResults(
    context: GraphQLContext,
    leagueId: number,
    eventId: number
  ): Promise<LeagueEventResult[]> {
    return leaguesRepository.getLeagueEventResults(context, leagueId, eventId);
  },
};
