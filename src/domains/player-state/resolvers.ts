import type { GraphQLContext } from "../../graphql/context";
import { playerStateService } from "./service";
import type { PlayerStateProfile } from "./types";

type PlayerStateArgs = {
	playerId: number;
	horizon?: number | null;
};

export const playerStateResolvers = {
	Query: {
		playerStateProfile: async (
			_parent: unknown,
			args: PlayerStateArgs,
			context: GraphQLContext
		): Promise<PlayerStateProfile | null> =>
			playerStateService.getPlayerStateProfile(context, args.playerId, args.horizon ?? 5),
	},
};
