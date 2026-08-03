import { GraphQLError } from "graphql";
import type { GraphQLContext } from "../../graphql/context";
import type { MarketPulse } from "./repository";
import { marketService } from "./service";

type MarketPulseArgs = {
	days?: number | null;
};

export function normalizeMarketPulseDays(days: number | null | undefined): number {
	const normalized = days ?? 14;
	if (!Number.isInteger(normalized) || normalized < 1 || normalized > 30) {
		throw new GraphQLError("days must be an integer between 1 and 30", {
			extensions: { code: "BAD_USER_INPUT" },
		});
	}
	return normalized;
}

export const marketResolvers = {
	Query: {
		marketPulse: async (
			_parent: unknown,
			args: MarketPulseArgs,
			context: GraphQLContext
		): Promise<MarketPulse> =>
			marketService.getMarketPulse(context, normalizeMarketPulseDays(args.days)),
	},
};
