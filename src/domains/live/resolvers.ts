import type { GraphQLContext } from '../../graphql/context';
import type { Event } from '../events/repository';
import { eventsService } from '../events/service';
import type { Player } from '../players/repository';
import { playersService } from '../players/service';
import type { EventLive, LivePerformance, LiveScoresFilter } from './repository';
import { liveService } from './service';

type LiveScoresArgs = {
  eventId?: number | null;
  filter?: LiveScoresFilter | null;
};

type PlayerLiveArgs = {
  playerId: number;
  eventId?: number | null;
};

type EventLiveArgs = {
  eventId: number;
};

type TopPerformersArgs = {
  limit?: number | null;
};

export const liveResolvers = {
  Query: {
    liveScores: async (
      _parent: unknown,
      args: LiveScoresArgs,
      context: GraphQLContext
    ): Promise<LivePerformance[]> =>
      liveService.getLiveScores(context, args.eventId ?? undefined, args.filter ?? undefined),

    playerLive: async (
      _parent: unknown,
      args: PlayerLiveArgs,
      context: GraphQLContext
    ): Promise<LivePerformance | null> =>
      liveService.getPlayerLive(context, args.playerId, args.eventId ?? undefined),

    eventLive: async (
      _parent: unknown,
      args: EventLiveArgs,
      context: GraphQLContext
    ): Promise<EventLive> => liveService.getEventLive(context, args.eventId),
  },
  EventLive: {
    event: async (
      parent: EventLive,
      _args: Record<string, never>,
      context: GraphQLContext
    ): Promise<Event | null> => eventsService.getEventById(context, parent.eventId),
    performances: (parent: EventLive): LivePerformance[] => parent.performances,
    dreamTeam: (parent: EventLive): LivePerformance[] =>
      parent.performances.filter((p) => p.inDreamTeam === true),
    topPerformers: (
      parent: EventLive,
      args: TopPerformersArgs
    ): LivePerformance[] => {
      const limit = args.limit ?? 10;
      return [...parent.performances]
        .sort((a, b) => b.totalPoints - a.totalPoints)
        .slice(0, limit);
    },
  },
  LivePerformance: {
    event: async (
      parent: LivePerformance,
      _args: Record<string, never>,
      context: GraphQLContext
    ): Promise<Event | null> => eventsService.getEventById(context, parent.eventId),
    player: async (
      parent: LivePerformance,
      _args: Record<string, never>,
      context: GraphQLContext
    ): Promise<Player | null> => playersService.getPlayerById(context, parent.playerId),
    expectedGoals: (parent: LivePerformance): number | null =>
      parent.expectedGoals ? parseFloat(parent.expectedGoals) : null,
    expectedAssists: (parent: LivePerformance): number | null =>
      parent.expectedAssists ? parseFloat(parent.expectedAssists) : null,
    expectedGoalInvolvements: (parent: LivePerformance): number | null =>
      parent.expectedGoalInvolvements ? parseFloat(parent.expectedGoalInvolvements) : null,
    expectedGoalsConceded: (parent: LivePerformance): number | null =>
      parent.expectedGoalsConceded ? parseFloat(parent.expectedGoalsConceded) : null,
  },
};
