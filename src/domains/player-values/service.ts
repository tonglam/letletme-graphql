import type { GraphQLContext } from "../../graphql/context";
import type { PlayerValue, PlayerValueHistoryItem } from "./repository";
import { playerValuesRepository } from "./repository";

type PriceChangeType = "RISE" | "FALL" | "UNCHANGED";

export type GetPlayerValueHistoryArgs = {
	playerId: number;
	fromDate?: Date;
	toDate?: Date;
};

export function calculatePriceChangeType(oldValue: number, newValue: number): PriceChangeType {
	if (newValue > oldValue) {
		return "RISE";
	}
	if (newValue < oldValue) {
		return "FALL";
	}
	return "UNCHANGED";
}

export const playerValuesService = {
	async getPlayerValues(context: GraphQLContext, changeDate: Date): Promise<PlayerValue[]> {
		return playerValuesRepository.getPlayerValues(context, changeDate);
	},

	async getPlayerValueHistory(
		context: GraphQLContext,
		args: GetPlayerValueHistoryArgs
	): Promise<PlayerValueHistoryItem[]> {
		const history = await playerValuesRepository.getPlayerValueHistory(context, args);

		return history.map((item) => ({
			...item,
			changeType: calculatePriceChangeType(item.oldValue, item.newValue),
		}));
	},
};
