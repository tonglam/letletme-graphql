import type { GraphQLContext } from '../../graphql/context';
import type { TournamentInfo } from './repository';
import { tournamentsRepository } from './repository';

export const tournamentsService = {
  getEntryTournaments(context: GraphQLContext, entryId: number): Promise<TournamentInfo[]> {
    return tournamentsRepository.getEntryTournaments(context, entryId);
  },
};
