import type { GraphQLContext } from '../../graphql/context';
import type { PlayerDetail } from './repository';
import { playerDetailService } from './service';

type PlayerDetailArgs = {
  playerId: number;
  eventId: number;
};

export const playerDetailResolvers = {
  Query: {
    playerDetail: async (
      _parent: unknown,
      args: PlayerDetailArgs,
      context: GraphQLContext,
    ): Promise<PlayerDetail | null> =>
      playerDetailService.getPlayerDetail(context, args.playerId, args.eventId),
  },
};
