import type { GraphQLContext } from '../../graphql/context';
import type { Event } from '../events/repository';
import { eventsService } from '../events/service';
import type { Team } from '../players/repository';
import { playersService } from '../players/service';
import type { Fixture, FixturesFilter } from './repository';
import { fixturesService } from './service';

/**
 * Per-request memoization for event lookups to avoid N+1 Redis/DB round-trips
 * when resolving the `event` field on multiple Fixture rows.
 */
const eventsMemo = new WeakMap<GraphQLContext, Map<number, Event | null>>();

const getEventByIdMemoized = async (
  context: GraphQLContext,
  eventId: number
): Promise<Event | null> => {
  let memo = eventsMemo.get(context);
  if (!memo) {
    memo = new Map();
    eventsMemo.set(context, memo);
  }
  if (memo.has(eventId)) {
    return memo.get(eventId)!;
  }
  const event = await eventsService.getEventById(context, eventId);
  memo.set(eventId, event);
  return event;
};

/**
 * Per-request memoization for team lookups to avoid N+1 Redis/DB round-trips
 * when resolving the `homeTeam`/`awayTeam` fields on multiple Fixture rows.
 */
const teamsMemo = new WeakMap<GraphQLContext, Map<number, Team | null>>();

const getTeamByIdMemoized = async (
  context: GraphQLContext,
  teamId: number
): Promise<Team | null> => {
  let memo = teamsMemo.get(context);
  if (!memo) {
    const allTeams = await playersService.listTeams(context);
    memo = new Map(allTeams.map((team) => [team.id, team]));
    teamsMemo.set(context, memo);
  }
  return memo.get(teamId) ?? null;
};

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
      parent.eventId ? getEventByIdMemoized(context, parent.eventId) : null,
    homeTeam: async (
      parent: Fixture,
      _args: Record<string, never>,
      context: GraphQLContext
    ): Promise<Team | null> => getTeamByIdMemoized(context, parent.teamHId),
    awayTeam: async (
      parent: Fixture,
      _args: Record<string, never>,
      context: GraphQLContext
    ): Promise<Team | null> => getTeamByIdMemoized(context, parent.teamAId),
    homeScore: (parent: Fixture): number | null => parent.teamHScore,
    awayScore: (parent: Fixture): number | null => parent.teamAScore,
    homeTeamDifficulty: (parent: Fixture): number | null => parent.teamHDifficulty,
    awayTeamDifficulty: (parent: Fixture): number | null => parent.teamADifficulty,
  },
};
