import type { GraphQLContext } from "../../graphql/context";
import { miniProgramRepository } from "./repository";

export const miniProgramResolvers = {
	Query: {
		miniProgramNotice: async (
			_parent: unknown,
			_args: Record<string, never>,
			context: GraphQLContext
		): Promise<string> => miniProgramRepository.getMiniProgramNotice(context),
	},
};
