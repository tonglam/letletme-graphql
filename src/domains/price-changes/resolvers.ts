import type { GraphQLContext } from "../../graphql/context";
import type { PriceChangeBoard } from "../../infra/price-change-predictions-client";
import { priceChangesService } from "./service";

export const priceChangesResolvers = {
	Query: {
		priceChangeBoard: async (
			_parent: unknown,
			_args: Record<string, never>,
			context: GraphQLContext
		): Promise<PriceChangeBoard> => priceChangesService.getBoard(context),
	},
};
