import type { GraphQLContext } from "../../graphql/context";
import { bindFplEntry, identifyWechatUser } from "./service";

export const wechatAuthResolvers = {
	Mutation: {
		identifyWechatUser: (
			_parent: unknown,
			args: { code: string; fplEntryId?: number | null },
			_context: GraphQLContext,
		): Promise<string> => identifyWechatUser(args.code, args.fplEntryId),

		bindFplEntry: async (
			_parent: unknown,
			args: { fplEntryId: number },
			context: GraphQLContext,
		): Promise<boolean> => {
			if (!context.user) throw new Error("Authentication required");
			await bindFplEntry(context.user.id, args.fplEntryId);
			return true;
		},
	},
};
