import { GraphQLError } from "graphql";
import type { GraphQLContext } from "../../graphql/context";
import { trendsRepository } from "./repository";

export const trendsResolvers = {
	Query: {
		trendCohorts: (
			_parent: unknown,
			args: { access: "PUBLIC" | "MINE" },
			context: GraphQLContext
		) => {
			if (args.access !== "PUBLIC" && args.access !== "MINE")
				throw new GraphQLError("Invalid cohort access", { extensions: { code: "BAD_USER_INPUT" } });
			return trendsRepository.listCohorts(context, args.access);
		},
		trendCohortSnapshot: (
			_parent: unknown,
			args: {
				cohortId: string;
				eventId: number;
				limit?: number | null;
				access?: "PUBLIC" | "MINE";
			},
			context: GraphQLContext
		) =>
			trendsRepository.snapshot(
				context,
				args.cohortId,
				args.eventId,
				args.limit ?? 12,
				args.access ?? "PUBLIC"
			),
	},
};
