import type { GraphQLContext } from "../../graphql/context";
import {
	createWechatApiSession,
	type ApiSession,
} from "../../infra/principal";
import { bindFplEntry, identifyWechatUser } from "./service";

export const wechatAuthResolvers = {
	Mutation: {
		createWechatApiSession: (
			_parent: unknown,
			args: { code: string; fplEntryId?: number | null },
			_context: GraphQLContext,
		): Promise<ApiSession> =>
			createWechatApiSession(args.code, args.fplEntryId),

		identifyWechatUser: (
			_parent: unknown,
			args: { code: string },
			_context: GraphQLContext,
		): Promise<string> => identifyWechatUser(args.code),

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
