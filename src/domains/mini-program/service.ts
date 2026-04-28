import type { GraphQLContext } from '../../graphql/context';
import { miniProgramRepository } from './repository';

export const miniProgramService = {
  async getMiniProgramNotice(context: GraphQLContext): Promise<string> {
    return miniProgramRepository.getMiniProgramNotice(context);
  },
};
