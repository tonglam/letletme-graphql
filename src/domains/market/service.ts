import type { GraphQLContext } from "../../graphql/context";
import { marketRepository, type MarketPulse } from "./repository";

export const marketService = {
	getMarketPulse(context: GraphQLContext, days: number): Promise<MarketPulse> {
		return marketRepository.getMarketPulse(context, days);
	},
};
