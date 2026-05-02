import { DateResolver } from "graphql-scalars";
import type { GraphQLContext } from "../../graphql/context";
import type { PlayerValue, PlayerValueHistoryItem } from "./repository";
import { playerValuesService } from "./service";

type PlayerValuesArgs = {
	changeDate: Date;
};

type PlayerValueHistoryArgs = {
	playerId: number;
	fromDate?: Date | null;
	toDate?: Date | null;
};

export type NormalizedPlayerValueHistoryArgs = {
	playerId: number;
	fromDate?: Date;
	toDate?: Date;
};

export function normalizePlayerValueHistoryArgs(
	args: PlayerValueHistoryArgs,
): NormalizedPlayerValueHistoryArgs {
	const fromDate = args.fromDate ?? undefined;
	const toDate = args.toDate ?? undefined;

	if (fromDate && toDate && fromDate.getTime() > toDate.getTime()) {
		throw new Error(
			"Invalid date range: fromDate must be less than or equal to toDate",
		);
	}

	return {
		playerId: args.playerId,
		fromDate,
		toDate,
	};
}

export const playerValuesResolvers = {
	Date: DateResolver,
	Query: {
		playerValues: async (
			_parent: unknown,
			args: PlayerValuesArgs,
			context: GraphQLContext,
		): Promise<PlayerValue[]> =>
			playerValuesService.getPlayerValues(context, args.changeDate),
		playerValueHistory: async (
			_parent: unknown,
			args: PlayerValueHistoryArgs,
			context: GraphQLContext,
		): Promise<PlayerValueHistoryItem[]> =>
			playerValuesService.getPlayerValueHistory(
				context,
				normalizePlayerValueHistoryArgs(args),
			),
	},
};
