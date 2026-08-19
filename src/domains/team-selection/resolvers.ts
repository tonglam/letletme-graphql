import type { GraphQLContext } from "../../graphql/context";
import { teamSelectionService, type TeamSelectionDesk } from "./service";

export const teamSelectionResolvers = {
	Query: {
		teamSelectionDesk: (
			_parent: unknown,
			args: { eventId: number; horizon?: number | null },
			context: GraphQLContext
		): Promise<TeamSelectionDesk> =>
			teamSelectionService.getTeamSelectionDesk(context, args.eventId, args.horizon ?? 5),
	},
};
