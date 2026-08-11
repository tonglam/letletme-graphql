import type { GraphQLContext } from "../../graphql/context";
import { withLiveSnapshotRoot } from "../live/snapshot-meta";
import type { LiveMatches } from "./service";
import { liveMatchesService } from "./service";

export const liveMatchesResolvers = {
	Query: {
		liveMatches: async (
			_parent: unknown,
			_args: Record<string, never>,
			context: GraphQLContext
		): Promise<LiveMatches> =>
			withLiveSnapshotRoot(context, () => liveMatchesService.getAllLiveMatches(context)),
	},
};
