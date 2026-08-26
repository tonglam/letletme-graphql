import type { GraphQLContext } from "../../graphql/context";
import type { PriceChangeBoard } from "../../infra/price-change-predictions-client";
import { priceChangesService } from "./service";
import { buildDataCompleteness } from "../../graphql/data-completeness";

export const priceChangesResolvers = {
	Query: {
		priceChangeBoard: async (
			_parent: unknown,
			_args: Record<string, never>,
			context: GraphQLContext
		): Promise<PriceChangeBoard> => priceChangesService.getBoard(context),
	},
	PriceChangeBoard: {
		completeness: (parent: PriceChangeBoard, _args: unknown, context: GraphQLContext) =>
			buildDataCompleteness({
				contractKey: "market-price",
				scopeKey: `season:${context.currentSeason.seasonCode}:price-change-board`,
				revision: parent.revision,
				sourceCheckedAt: parent.fetchedAt,
				expectedCount: parent.expectedPlayerCount,
				observedCount: parent.observedPlayerCount,
				eligibility: parent.status === "UNAVAILABLE" ? "INVALID" : undefined,
				complete: parent.status === "READY",
			}),
	},
};
