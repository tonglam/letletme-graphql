import type { GraphQLContext } from "../../graphql/context";
import { gameweekService, type GameweekDesk } from "./service";

export const gameweekResolvers = {
	Query: {
		gameweekDesk: (
			_parent: unknown,
			args: { eventId?: number | null },
			context: GraphQLContext
		): Promise<GameweekDesk> => gameweekService.getGameweekDesk(context, args.eventId),
	},
};
