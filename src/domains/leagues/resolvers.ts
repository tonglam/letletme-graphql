import type { GraphQLContext } from '../../graphql/context';
import type { Event } from '../events/repository';
import { eventsService } from '../events/service';
import type { League, LeagueEventResult, LeagueStanding } from './repository';
import { LeagueType } from './repository';
import { leaguesService } from './service';

type EntryLeaguesArgs = {
  entryId: number;
};

type LeagueStandingsArgs = {
  leagueId: number;
  limit?: number | null;
};

type LeagueEventResultsArgs = {
  leagueId: number;
  eventId: number;
};

const leagueTypeToEnum = (type: LeagueType): string => {
  return type === LeagueType.H2H ? 'H2H' : 'CLASSIC';
};

export const leaguesResolvers = {
  Query: {
    entryLeagues: async (
      _parent: unknown,
      args: EntryLeaguesArgs,
      context: GraphQLContext
    ): Promise<League[]> => leaguesService.getEntryLeagues(context, args.entryId),

    leagueStandings: async (
      _parent: unknown,
      args: LeagueStandingsArgs,
      context: GraphQLContext
    ): Promise<LeagueStanding[]> =>
      leaguesService.getLeagueStandings(context, args.leagueId, args.limit ?? 50),

    leagueEventResults: async (
      _parent: unknown,
      args: LeagueEventResultsArgs,
      context: GraphQLContext
    ): Promise<LeagueEventResult[]> =>
      leaguesService.getLeagueEventResults(context, args.leagueId, args.eventId),
  },
  League: {
    type: (parent: League): string => leagueTypeToEnum(parent.type),
  },
  LeagueStanding: {
    league: (parent: LeagueStanding): League => ({
      id: parent.leagueId,
      name: parent.leagueName,
      type: parent.leagueType,
      startedEvent: parent.startedEvent,
    }),
  },
  LeagueEventResult: {
    league: (parent: LeagueEventResult): League => ({
      id: parent.leagueId,
      name: '', // Name not available in result row
      type: parent.leagueType,
      startedEvent: null,
    }),
    event: async (
      parent: LeagueEventResult,
      _args: Record<string, never>,
      context: GraphQLContext
    ): Promise<Event | null> => eventsService.getEventById(context, parent.eventId),
  },
};
