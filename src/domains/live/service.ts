import type { GraphQLContext } from '../../graphql/context';
import type { LivePerformance } from './repository';
import { liveRepository } from './repository';

export const liveService = {
  getLiveScores(context: GraphQLContext, eventId?: number): Promise<LivePerformance[]> {
    return liveRepository.getLiveScores(context, eventId);
  },

  getPlayerLive(
    context: GraphQLContext,
    playerId: number,
    eventId?: number
  ): Promise<LivePerformance | null> {
    return liveRepository.getPlayerLive(context, playerId, eventId);
  },
};
