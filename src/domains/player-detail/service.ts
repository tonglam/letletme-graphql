import type { GraphQLContext } from "../../graphql/context";
import type { PlayerDetail } from "./repository";
import { playerDetailRepository } from "./repository";

export const playerDetailService = {
	async getPlayerDetail(
		context: GraphQLContext,
		playerId: number,
		eventId: number,
	): Promise<PlayerDetail | null> {
		return playerDetailRepository.getPlayerDetail(context, playerId, eventId);
	},
};
