import type { GraphQLContext } from "../../graphql/context";
import { marketRepository, type MarketPulse, type MarketLineup } from "./repository";
import {
	marketOwnershipRepository,
	type MarketOwnershipDay,
	type MarketOwnershipOverview,
	type MarketOwnershipPeriod,
} from "./ownership-repository";
import { getMarketSnapshotContext, type MarketSnapshotContext } from "./context";

export const marketService = {
	getMarketPulse(context: GraphQLContext, days: number): Promise<MarketPulse> {
		return marketRepository.getMarketPulse(context, days);
	},
	getMarketLineup(context: GraphQLContext): Promise<MarketLineup | null> {
		return marketRepository.getMarketLineup(context);
	},
	getMarketOwnershipOverview(
		context: GraphQLContext,
		period: MarketOwnershipPeriod,
		limit: number
	): Promise<MarketOwnershipOverview> {
		return marketOwnershipRepository.getOverview(context, period, limit);
	},
	getMarketOwnershipDay(
		context: GraphQLContext,
		date: Date | null,
		limit: number
	): Promise<MarketOwnershipDay> {
		return marketOwnershipRepository.getDay(context, date, limit);
	},
	async getMarketSnapshotContext(context: GraphQLContext): Promise<MarketSnapshotContext> {
		const snapshot = await getMarketSnapshotContext(context);
		if (!snapshot) throw new Error("Market snapshot context is unavailable");
		return snapshot;
	},
};

export const marketOwnershipService = {
	getOverview(
		context: GraphQLContext,
		period: MarketOwnershipPeriod,
		limit: number
	): Promise<MarketOwnershipOverview> {
		return marketOwnershipRepository.getOverview(context, period, limit);
	},
	getDay(context: GraphQLContext, date: Date | null, limit: number): Promise<MarketOwnershipDay> {
		return marketOwnershipRepository.getDay(context, date, limit);
	},
};
