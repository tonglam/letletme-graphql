import { GraphQLError } from "graphql";
import type { GraphQLContext } from "../../graphql/context";
import type { TournamentSelectionStats } from "../event-stats/repository";
import type { PublicLeagueTrend } from "./repository";
import { publicLeagueTrendsService } from "./service";

const positiveInteger = (value: number, name: string): number => {
	if (!Number.isInteger(value) || value <= 0) {
		throw new GraphQLError(`${name} must be a positive integer`, {
			extensions: { code: "BAD_USER_INPUT" },
		});
	}
	return value;
};

const publicLimit = (value: number | null | undefined): number => {
	const limit = value ?? 12;
	if (!Number.isInteger(limit) || limit < 1 || limit > 12) {
		throw new GraphQLError("limit must be an integer between 1 and 12", {
			extensions: { code: "BAD_USER_INPUT" },
		});
	}
	return limit;
};

export const publicLeagueTrendsResolvers = {
	Query: {
		publicLeagueTrends: (
			_parent: unknown,
			_args: unknown,
			context: GraphQLContext
		): Promise<PublicLeagueTrend[]> => publicLeagueTrendsService.list(context),
		publicLeagueSelectionStats: (
			_parent: unknown,
			args: { tournamentId: number; eventId: number; limit?: number | null },
			context: GraphQLContext
		): Promise<TournamentSelectionStats | null> =>
			publicLeagueTrendsService.getSelectionStats(
				context,
				positiveInteger(args.tournamentId, "tournamentId"),
				positiveInteger(args.eventId, "eventId"),
				publicLimit(args.limit)
			),
	},
};
