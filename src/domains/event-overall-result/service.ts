import type { GraphQLContext } from '../../graphql/context';
import type { EventResult } from './repository';
import { eventOverallResultRepository } from './repository';

export const eventOverallResultService = {
  async getEventOverallResult(
    context: GraphQLContext,
    season: number
  ): Promise<EventResult[]> {
    return eventOverallResultRepository.getEventOverallResult(context, season);
  },
};
