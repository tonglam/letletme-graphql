import type { GraphQLContext } from "../../graphql/context";
import type { HomePersonalDesk } from "./repository";
import type { HomeMarketDesk } from "./market-repository";
import {
	homeService,
	type HomeGameweek,
	type HomeMarketPulse,
	type HomePublicBootstrap,
} from "./service";
import { normalizeMarketPulseDays } from "../market/resolvers";

export const homeResolvers = {
	Query: {
		homePublicBootstrap: (
			_parent: unknown,
			_args: Record<string, never>,
			context: GraphQLContext
		): Promise<HomePublicBootstrap> => homeService.getPublicBootstrap(context),
		homeGameweek: (
			_parent: unknown,
			args: { eventId: number },
			context: GraphQLContext
		): Promise<HomeGameweek> => homeService.getGameweek(context, args.eventId),
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
		homeMarketDesk: (
			_parent: unknown,
			_args: Record<string, never>,
			context: GraphQLContext
		): Promise<HomeMarketDesk> => homeService.getMarketDesk(context),
	},
};
