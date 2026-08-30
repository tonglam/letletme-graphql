import type { GraphQLContext } from "../../graphql/context";
import { GraphQLError } from "graphql";
import {
	calcLivePointsByEntryV2,
	calcLivePointsForEntriesV2,
	type BatchLiveCalcResultV2,
	type LiveCalcDataV2,
} from "./v2-service";

type CalcLivePointsByEntryArgs = {
	eventId: number;
	entryId: number;
};

type CalcLivePointsForEntriesArgs = {
	eventId: number;
	entryIds: number[];
};

export const entryLiveResolvers = {
	Query: {
		calcLivePointsByEntry: async (
			_parent: unknown,
			args: CalcLivePointsByEntryArgs,
			context: GraphQLContext
		): Promise<LiveCalcDataV2> => calcLivePointsByEntryV2(context, args.eventId, args.entryId),

		calcLivePointsForEntries: async (
			_parent: unknown,
			args: CalcLivePointsForEntriesArgs,
			context: GraphQLContext
		): Promise<{
			results: LiveCalcDataV2[];
			errors: Array<{ entryId: number; message: string }>;
			meta: {
				eventId: number;
				totalEntries: number;
				succeededCount: number;
				failedCount: number;
			};
		}> => {
			if (args.entryIds.length > 500) {
				throw new GraphQLError("Entry batch exceeds the 500 entry limit", {
					extensions: { code: "QUERY_TOO_COMPLEX" },
				});
			}
			if (new Set(args.entryIds).size !== args.entryIds.length) {
				throw new GraphQLError("Entry batch must not contain duplicate entry IDs", {
					extensions: { code: "DUPLICATE_ENTRY_IDS" },
				});
			}
			const result: BatchLiveCalcResultV2 = await calcLivePointsForEntriesV2(
				context,
				args.eventId,
				args.entryIds
			);
			return {
				results: Array.from(result.results.values()),
				errors: result.errors,
				meta: result.meta,
			};
		},
	},
};
