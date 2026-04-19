import type { GraphQLContext } from '../../graphql/context';
import type { LiveMatches } from './service';
import { liveMatchesService } from './service';

export const liveMatchesResolvers = {
  Query: {
    liveMatches: async (
      _parent: unknown,
      _args: Record<string, never>,
      context: GraphQLContext,
    ): Promise<LiveMatches> => liveMatchesService.getAllLiveMatches(context),
  },
};
