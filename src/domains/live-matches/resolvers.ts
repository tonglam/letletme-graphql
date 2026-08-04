import type { GraphQLContext } from "../../graphql/context";
import { withLiveSnapshotRoot } from "../live/snapshot-meta";
import type { LiveMatches } from "./service";
import { liveMatchesService } from "./service";

type LiveMatchesArgs = {
	upcoming?: boolean | null;
};

export const liveMatchesResolvers = {
	Query: {
		liveMatches: async (
			_parent: unknown,
			args: LiveMatchesArgs,
			context: GraphQLContext
		): Promise<LiveMatches> =>
			withLiveSnapshotRoot(context, () =>
				liveMatchesService.getAllLiveMatches(context, args.upcoming ?? false)
			),
	},
};
