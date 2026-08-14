import type { GraphQLContext } from "../../graphql/context";
import type { HomePersonalDesk } from "./repository";
import { homeService, type HomeMarketPulse, type HomePublicBootstrap } from "./service";

export const homeResolvers = {
	Query: {
		homePublicBootstrap: (
			_parent: unknown,
			_args: Record<string, never>,
			context: GraphQLContext
		): Promise<HomePublicBootstrap> => homeService.getPublicBootstrap(context),
		homePersonalDesk: (
			_parent: unknown,
			_args: Record<string, never>,
			context: GraphQLContext
		): Promise<HomePersonalDesk> => homeService.getPersonalDesk(context),
		homeMarketPulse: (
			_parent: unknown,
			args: { days?: number | null },
			context: GraphQLContext
		): Promise<HomeMarketPulse> => homeService.getMarketPulse(context, args.days ?? 14),
	},
};
