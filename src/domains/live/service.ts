import type { GraphQLContext } from '../../graphql/context';
import type { EventLive, LiveExplain, LivePerformance, LiveScoresFilter } from './repository';
import { liveRepository } from './repository';

export const liveService = {
  getLiveScores(
    context: GraphQLContext,
    eventId?: number,
    filter?: LiveScoresFilter | null
  ): Promise<LivePerformance[]> {
    return liveRepository.getLiveScores(context, eventId, filter);
  },

  getPlayerLive(
    context: GraphQLContext,
    playerId: number,
    eventId?: number
  ): Promise<LivePerformance | null> {
    return liveRepository.getPlayerLive(context, playerId, eventId);
  },

  getEventLive(context: GraphQLContext, eventId: number): Promise<EventLive> {
    return liveRepository.getEventLive(context, eventId);
  },

  getEventLiveExplain(
    context: GraphQLContext,
    eventId: number,
    elementId: number
  ): Promise<LiveExplain | null> {
    return liveRepository.getEventLiveExplain(context, eventId, elementId);
  },

  getSelectedByPercent(
    context: GraphQLContext,
    eventId: number,
    elementId: number
  ): Promise<number | null> {
    return liveRepository.getSelectedByPercent(context, eventId, elementId);
  },
};
