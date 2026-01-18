import type { GraphQLContext } from '../../graphql/context';
import type { PlayerValue } from './repository';
import { playerValuesRepository } from './repository';

export const playerValuesService = {
  async getPlayerValues(context: GraphQLContext, changeDate?: Date | null): Promise<PlayerValue[]> {
    return playerValuesRepository.getPlayerValues(context, changeDate);
  },
};
