import type { GraphQLContext } from '../../graphql/context';
import type { Player } from '../players/repository';
import { playersService } from '../players/service';
import type { EventResult, EventResultPlayer, TopElementInfo } from './repository';
import { eventOverallResultService } from './service';

type EventOverallResultArgs = {
  season: number;
};

function toEventResultPlayer(player: Player): EventResultPlayer {
  return {
    id: player.id,
    webName: player.webName,
  };
}

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
    ): Promise<EventResultPlayer | null> => {
      if (parent.mostSelectedPlayer) {
        return parent.mostSelectedPlayer;
      }

      if (!parent.mostSelectedId || parent.mostSelectedId === 0) {
        return null;
      }

      const player = await playersService.getPlayerById(context, parent.mostSelectedId);
      if (!player) {
        return null;
      }

      return toEventResultPlayer(player);
    },
    mostCaptainedPlayer: async (
      parent: EventResult,
      _args: Record<string, never>,
      context: GraphQLContext
    ): Promise<EventResultPlayer | null> => {
      if (parent.mostCaptainedPlayer) {
        return parent.mostCaptainedPlayer;
      }

      if (!parent.mostCaptainedId || parent.mostCaptainedId === 0) {
        return null;
      }

      const player = await playersService.getPlayerById(context, parent.mostCaptainedId);
      if (!player) {
        return null;
      }

      return toEventResultPlayer(player);
    },
    mostTransferInPlayer: async (
      parent: EventResult,
      _args: Record<string, never>,
      context: GraphQLContext
    ): Promise<EventResultPlayer | null> => {
      if (parent.mostTransferInPlayer) {
        return parent.mostTransferInPlayer;
      }

      if (!parent.mostTransferredInId || parent.mostTransferredInId === 0) {
        return null;
      }

      const player = await playersService.getPlayerById(context, parent.mostTransferredInId);
      if (!player) {
        return null;
      }

      return toEventResultPlayer(player);
    },
    mostViceCaptainedPlayer: async (
      parent: EventResult,
      _args: Record<string, never>,
      context: GraphQLContext
    ): Promise<EventResultPlayer | null> => {
      if (parent.mostViceCaptainedPlayer) {
        return parent.mostViceCaptainedPlayer;
      }

      if (!parent.mostViceCaptainedId || parent.mostViceCaptainedId === 0) {
        return null;
      }

      const player = await playersService.getPlayerById(context, parent.mostViceCaptainedId);
      if (!player) {
        return null;
      }

      return toEventResultPlayer(player);
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
    teamShortName: async (
      parent: TopElementInfo,
      _args: Record<string, never>,
      context: GraphQLContext
    ): Promise<string | null> => {
      if (!parent.element || parent.element === 0) {
        return null;
      }

      const player = await playersService.getPlayerById(context, parent.element);
      if (!player) {
        return null;
      }

      const team = await playersService.getTeamById(context, player.teamId);
      return team?.shortName ?? null;
    },
  },
};
