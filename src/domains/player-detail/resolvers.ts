import type { GraphQLContext } from "../../graphql/context";
import type { PlayerDetail } from "./repository";
import { playerDetailService } from "./service";
import { buildDataCompleteness } from "../../graphql/data-completeness";
import type { PlayerStatsContext } from "../players/season-stats-at-event";

type PlayerDetailArgs = {
	playerId: number;
	eventId: number;
};

export const playerDetailResolvers = {
	Query: {
		playerDetail: async (
			_parent: unknown,
			args: PlayerDetailArgs,
			context: GraphQLContext
		): Promise<PlayerDetail | null> =>
			playerDetailService.getPlayerDetail(context, args.playerId, args.eventId),
	},
	PlayerStatsContext: {
		completeness: (parent: PlayerStatsContext) =>
			buildDataCompleteness({
				contractKey: "player-stats",
				scopeKey: `season:${parent.season}:event:${parent.asOfEventId ?? "current"}`,
				revision: parent.revision,
				sourceCheckedAt: parent.sourceCheckedAt,
				expectedCount: parent.expectedRowCount,
				observedCount: parent.rowCount,
				complete: parent.status === "AVAILABLE",
			}),
	},
};
