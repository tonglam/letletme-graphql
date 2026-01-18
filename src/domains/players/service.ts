import type { GraphQLContext } from '../../graphql/context';
import type { Player, PlayersFilter, PlayerTransferStats, Team } from './repository';
import { playersRepository } from './repository';

export const playersService = {
  getPlayerById(context: GraphQLContext, id: number): Promise<Player | null> {
    return playersRepository.getPlayerById(context, id);
  },

  listPlayers(
    context: GraphQLContext,
    filter: PlayersFilter | null | undefined,
    limit: number,
    offset: number
  ): Promise<Player[]> {
    return playersRepository.listPlayers(context, filter, limit, offset);
  },

  getTeamById(context: GraphQLContext, id: number): Promise<Team | null> {
    return playersRepository.getTeamById(context, id);
  },

  listTeams(context: GraphQLContext): Promise<Team[]> {
    return playersRepository.listTeams(context);
  },

  getTopTransfersIn(
    context: GraphQLContext,
    eventId: number,
    limit: number
  ): Promise<PlayerTransferStats[]> {
    return playersRepository.getTopTransfersIn(context, eventId, limit);
  },

  getTopTransfersOut(
    context: GraphQLContext,
    eventId: number,
    limit: number
  ): Promise<PlayerTransferStats[]> {
    return playersRepository.getTopTransfersOut(context, eventId, limit);
  },
};
