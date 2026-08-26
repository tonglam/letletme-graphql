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
import { buildDataCompleteness } from "../../graphql/data-completeness";

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
	HomePersonalDesk: {
		completeness: (parent: HomePersonalDesk, _args: unknown, context: GraphQLContext) =>
			buildDataCompleteness({
				contractKey: "league-tournament",
				scopeKey: `season:${context.currentSeason.seasonCode}:entry:${parent.entryId}`,
				// The legacy home SQL projection has no publication revision. Do not
				// infer one from a timestamp; expose an explicit invalid evidence state
				// until the producer adds its checkpoint revision.
				revision: null,
				sourceCheckedAt: parent.sourceCheckedAt,
				complete: false,
				eligibility: "INVALID",
			}),
	},
	HomeMarketDesk: {
		completeness: (parent: HomeMarketDesk, _args: unknown, context: GraphQLContext) =>
			buildDataCompleteness({
				contractKey: "market-price",
				scopeKey: `season:${context.currentSeason.seasonCode}:home-market`,
				revision: parent.revision,
				sourceCheckedAt: parent.capturedAt,
				complete:
					parent.revision.length > 0 &&
					parent.capturedAt !== null &&
					parent.ownershipState !== "UNAVAILABLE" &&
					parent.priceChangesState !== "UNAVAILABLE" &&
					parent.availabilityState !== "UNAVAILABLE",
			}),
	},
};
