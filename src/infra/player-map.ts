import type { GraphQLContext } from "../graphql/context";
import { getCoreDataSnapshot } from "./data-snapshot";
import type { Player } from "./types";

export async function buildPlayerMap(
	context: GraphQLContext,
	playerIds: number[]
): Promise<Map<number, Player>> {
	if (playerIds.length === 0) return new Map();
	const requested = new Set(playerIds);
	const snapshot = await getCoreDataSnapshot(context);
	return new Map(
		snapshot.players
			.filter((player) => requested.has(player.id))
			.map((player) => [
				player.id,
				{
					id: player.id,
					code: player.code,
					webName: player.webName,
					firstName: player.firstName,
					secondName: player.secondName,
					teamId: player.teamId,
					position: player.type,
					price: player.price,
					startPrice: player.startPrice,
					totalPoints: player.totalPoints,
					selectedByPercent: player.selectedByPercent,
				} satisfies Player,
			])
	);
}
