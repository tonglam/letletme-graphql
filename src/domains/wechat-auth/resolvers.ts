import type { GraphQLContext } from "../../graphql/context";
import { createWechatApiSession, type ApiSession } from "../../infra/principal";

export const wechatAuthResolvers = {
	Mutation: {
		createWechatApiSession: (
			_parent: unknown,
			args: { code: string },
			_context: GraphQLContext
		): Promise<ApiSession> => createWechatApiSession(args.code),
	},
};
