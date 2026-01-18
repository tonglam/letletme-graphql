import type { GraphQLContext } from '../../graphql/context';
import type { Event } from '../events/repository';
import { eventsService } from '../events/service';
import type { Team } from '../players/repository';
import { playersService } from '../players/service';
import type { Fixture, FixturesFilter } from './repository';
import { fixturesService } from './service';

type FixtureArgs = {
  id: number;
};

type FixturesArgs = {
  filter?: FixturesFilter | null;
  limit?: number | null;
  offset?: number | null;
};

type EventFixturesArgs = {
  eventId: number;
};

export const fixturesResolvers = {
  Query: {
    fixture: async (
      _parent: unknown,
      args: FixtureArgs,
      context: GraphQLContext
    ): Promise<Fixture | null> => fixturesService.getFixtureById(context, args.id),

    fixtures: async (
      _parent: unknown,
      args: FixturesArgs,
      context: GraphQLContext
    ): Promise<Fixture[]> =>
      fixturesService.listFixtures(
        context,
        args.filter ?? undefined,
        args.limit ?? 50,
        args.offset ?? 0
      ),

    currentFixtures: async (
      _parent: unknown,
      _args: Record<string, never>,
      context: GraphQLContext
    ): Promise<Fixture[]> => fixturesService.getCurrentFixtures(context),

    eventFixtures: async (
      _parent: unknown,
      args: EventFixturesArgs,
      context: GraphQLContext
    ): Promise<Fixture[]> => fixturesService.getEventFixtures(context, args.eventId),
  },
  Fixture: {
    event: async (
      parent: Fixture,
      _args: Record<string, never>,
      context: GraphQLContext
    ): Promise<Event | null> =>
      parent.eventId ? eventsService.getEventById(context, parent.eventId) : null,
    homeTeam: async (
      parent: Fixture,
      _args: Record<string, never>,
      context: GraphQLContext
    ): Promise<Team | null> => playersService.getTeamById(context, parent.teamHId),
    awayTeam: async (
      parent: Fixture,
      _args: Record<string, never>,
      context: GraphQLContext
    ): Promise<Team | null> => playersService.getTeamById(context, parent.teamAId),
    homeScore: (parent: Fixture): number | null => parent.teamHScore,
    awayScore: (parent: Fixture): number | null => parent.teamAScore,
    homeTeamDifficulty: (parent: Fixture): number | null => parent.teamHDifficulty,
    awayTeamDifficulty: (parent: Fixture): number | null => parent.teamADifficulty,
  },
};
