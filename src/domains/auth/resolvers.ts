import type { GraphQLContext } from "../../graphql/context";
import type { AuthUser } from "../../infra/principal";

export const authResolvers = {
	Query: {
		me: (_parent: unknown, _args: unknown, context: GraphQLContext): AuthUser | null =>
			context.user ?? null,
	},
};
