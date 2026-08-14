import type { GraphQLContext } from "../../graphql/context";
import { marketRepository, type MarketPulse } from "./repository";
import { getMarketSnapshotContext, type MarketSnapshotContext } from "./context";

export const marketService = {
	getMarketPulse(context: GraphQLContext, days: number): Promise<MarketPulse> {
		return marketRepository.getMarketPulse(context, days);
	},
	async getMarketSnapshotContext(context: GraphQLContext): Promise<MarketSnapshotContext> {
		const snapshot = await getMarketSnapshotContext(context);
		if (!snapshot) throw new Error("Market snapshot context is unavailable");
		return snapshot;
	},
};
