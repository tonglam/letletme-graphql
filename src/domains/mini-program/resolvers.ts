import type { GraphQLContext } from '../../graphql/context';
import { miniProgramService } from './service';

export const miniProgramResolvers = {
  Query: {
    miniProgramNotice: async (
      _parent: unknown,
      _args: Record<string, never>,
      context: GraphQLContext
    ): Promise<string> => miniProgramService.getMiniProgramNotice(context),
  },
};
