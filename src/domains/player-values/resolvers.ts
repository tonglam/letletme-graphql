import type { GraphQLContext } from '../../graphql/context';
import type { PlayerValue } from './repository';
import { playerValuesService } from './service';

type PlayerValuesArgs = {
  changeDate?: Date | null;
};

export const playerValuesResolvers = {
  Query: {
    playerValues: async (
      _parent: unknown,
      args: PlayerValuesArgs,
      context: GraphQLContext
    ): Promise<PlayerValue[]> => playerValuesService.getPlayerValues(context, args.changeDate),
  },
};
