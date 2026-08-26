import type { GraphQLContext } from "../../graphql/context";
import { gameweekService, type GameweekDesk } from "./service";
import { buildDataCompleteness } from "../../graphql/data-completeness";

export const gameweekResolvers = {
	Query: {
		gameweekDesk: (
			_parent: unknown,
			args: { eventId?: number | null },
			context: GraphQLContext
		): Promise<GameweekDesk> => gameweekService.getGameweekDesk(context, args.eventId),
	},
	GameweekDesk: {
		completeness: (parent: GameweekDesk) =>
			buildDataCompleteness({
				contractKey: "live-snapshot",
				scopeKey: `season:${parent.season}:event:${parent.eventId}`,
				revision: parent.liveRevision,
				sourceCheckedAt: parent.sourceCheckedAt,
				eligibility: parent.liveRevision === null ? "INVALID" : undefined,
				complete:
					parent.lifecycle !== "SCHEDULED" &&
					parent.overviewState === "AVAILABLE" &&
					parent.boardsState === "AVAILABLE" &&
					parent.liveRevision !== null,
			}),
	},
};
