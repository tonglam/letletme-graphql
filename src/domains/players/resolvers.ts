import type { GraphQLContext } from '../../graphql/context';
import type { Player, PlayersFilter, PlayerTransferStats, Team } from './repository';
import { Position } from './repository';
import { playersService } from './service';

type PlayerArgs = {
  id: number;
};

type GraphQLPlayersFilter = {
  position?: string | null;
  teamId?: number | null;
  minPrice?: number | null;
  maxPrice?: number | null;
};

type PlayersArgs = {
  filter?: GraphQLPlayersFilter | null;
  limit?: number | null;
  offset?: number | null;
};

type TeamArgs = {
  id: number;
};

type TopTransfersArgs = {
  eventId: number;
  limit?: number | null;
};

const stringToPosition = (positionStr: string): Position => {
  switch (positionStr) {
    case 'GOALKEEPER':
      return Position.GOALKEEPER;
    case 'DEFENDER':
      return Position.DEFENDER;
    case 'MIDFIELDER':
      return Position.MIDFIELDER;
    case 'FORWARD':
      return Position.FORWARD;
    default:
      return Position.MIDFIELDER;
  }
};

export const playersResolvers = {
  Query: {
    player: async (
      _parent: unknown,
      args: PlayerArgs,
      context: GraphQLContext
    ): Promise<Player | null> => playersService.getPlayerById(context, args.id),

    players: async (
      _parent: unknown,
      args: PlayersArgs,
      context: GraphQLContext
    ): Promise<Player[]> => {
      const filter: PlayersFilter | undefined = args.filter
        ? {
            position: args.filter.position ? stringToPosition(args.filter.position) : undefined,
            teamId: args.filter.teamId ?? undefined,
            minPrice: args.filter.minPrice ?? undefined,
            maxPrice: args.filter.maxPrice ?? undefined,
          }
        : undefined;

      return playersService.listPlayers(context, filter, args.limit ?? 50, args.offset ?? 0);
    },

    team: async (_parent: unknown, args: TeamArgs, context: GraphQLContext): Promise<Team | null> =>
      playersService.getTeamById(context, args.id),

    teams: async (
      _parent: unknown,
      _args: Record<string, never>,
      context: GraphQLContext
    ): Promise<Team[]> => playersService.listTeams(context),

    topTransfersIn: async (
      _parent: unknown,
      args: TopTransfersArgs,
      context: GraphQLContext
    ): Promise<PlayerTransferStats[]> =>
      playersService.getTopTransfersIn(context, args.eventId, args.limit ?? 10),

    topTransfersOut: async (
      _parent: unknown,
      args: TopTransfersArgs,
      context: GraphQLContext
    ): Promise<PlayerTransferStats[]> =>
      playersService.getTopTransfersOut(context, args.eventId, args.limit ?? 10),
  },
  PlayerTransferStats: {
    player: async (
      parent: PlayerTransferStats,
      _args: Record<string, never>,
      context: GraphQLContext
    ): Promise<Player | null> => playersService.getPlayerById(context, parent.playerId),
  },
  Player: {
    team: async (
      parent: Player,
      _args: Record<string, never>,
      context: GraphQLContext
    ): Promise<Team | null> => playersService.getTeamById(context, parent.teamId),
    position: (parent: Player): string => {
      switch (parent.position) {
        case Position.GOALKEEPER:
          return 'GOALKEEPER';
        case Position.DEFENDER:
          return 'DEFENDER';
        case Position.MIDFIELDER:
          return 'MIDFIELDER';
        case Position.FORWARD:
          return 'FORWARD';
        default:
          return 'MIDFIELDER';
      }
    },
  },
};
