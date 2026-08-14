import type { GraphQLContext } from "../../graphql/context";
import type { HomePersonalDesk } from "./repository";
import { homeService, type HomeMarketPulse, type HomePublicBootstrap } from "./service";
import { normalizeMarketPulseDays } from "../market/resolvers";

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
		): Promise<HomeMarketPulse> =>
			homeService.getMarketPulse(context, normalizeMarketPulseDays(args.days)),
	},
};
