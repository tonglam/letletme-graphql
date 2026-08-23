import type { GraphQLContext } from "../../graphql/context";
import {
	readPriceChangePredictions,
	type PriceChangeBoard,
} from "../../infra/price-change-predictions-client";

export const priceChangesService = {
	getBoard(context: GraphQLContext): Promise<PriceChangeBoard> {
		return readPriceChangePredictions(context);
	},
};
