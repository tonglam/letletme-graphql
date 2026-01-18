import type { GraphQLContext } from '../../graphql/context';
import type { Player } from '../players/repository';
import { playersService } from '../players/service';
import type { EventResult, TopElementInfo } from './repository';
import { eventOverallResultService } from './service';

type EventOverallResultArgs = {
  season: number;
};

export const eventOverallResultResolvers = {
  Query: {
    eventOverallResult: async (
      _parent: unknown,
      args: EventOverallResultArgs,
      context: GraphQLContext
    ): Promise<EventResult[]> =>
      eventOverallResultService.getEventOverallResult(context, args.season),
  },
  EventResult: {
    mostSelectedPlayer: async (
      parent: EventResult,
      _args: Record<string, never>,
      context: GraphQLContext
    ): Promise<Player | null> => {
      if (!parent.mostSelected || parent.mostSelected === 0) {
        return null;
      }
      return playersService.getPlayerById(context, parent.mostSelected);
    },
    mostTransferredInPlayer: async (
      parent: EventResult,
      _args: Record<string, never>,
      context: GraphQLContext
    ): Promise<Player | null> => {
      if (!parent.mostTransferredIn || parent.mostTransferredIn === 0) {
        return null;
      }
      return playersService.getPlayerById(context, parent.mostTransferredIn);
    },
    mostCaptainedPlayer: async (
      parent: EventResult,
      _args: Record<string, never>,
      context: GraphQLContext
    ): Promise<Player | null> => {
      if (!parent.mostCaptained || parent.mostCaptained === 0) {
        return null;
      }
      return playersService.getPlayerById(context, parent.mostCaptained);
    },
    mostViceCaptainedPlayer: async (
      parent: EventResult,
      _args: Record<string, never>,
      context: GraphQLContext
    ): Promise<Player | null> => {
      if (!parent.mostViceCaptained || parent.mostViceCaptained === 0) {
        return null;
      }
      return playersService.getPlayerById(context, parent.mostViceCaptained);
    },
  },
  TopElementInfo: {
    player: async (
      parent: TopElementInfo,
      _args: Record<string, never>,
      context: GraphQLContext
    ): Promise<Player | null> => {
      if (!parent.element || parent.element === 0) {
        return null;
      }
      return playersService.getPlayerById(context, parent.element);
    },
  },
};
