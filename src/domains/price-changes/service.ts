import type { GraphQLContext } from "../../graphql/context";
import {
	requestPriceChangePredictions,
	type PriceChangeBoard,
} from "../../infra/price-change-predictions-client";

export const priceChangesService = {
	getBoard(context: GraphQLContext): Promise<PriceChangeBoard> {
		return requestPriceChangePredictions({ logger: context.logger });
	},
};
