import type { GraphQLContext } from "../../graphql/context";
import { getCoreDataSnapshot, getLiveDataSnapshot } from "../../infra/data-snapshot";
import { metrics } from "../../infra/metrics";

export async function loadLiveBonusByPlayerId(
	context: GraphQLContext,
	eventId: number
): Promise<Map<number, number>> {
	if (!Number.isSafeInteger(eventId) || eventId <= 0) return new Map();
	const [live, core] = await Promise.all([
		getLiveDataSnapshot(context, eventId),
		getCoreDataSnapshot(context),
	]);
	const byTeam = live.liveBonus;
	const players = new Map(core.players.map((player) => [player.id, player]));
	const bonusByPlayerId = new Map<number, number>();
	for (const [teamIdRaw, teamBonus] of Object.entries(byTeam)) {
		const teamId = Number(teamIdRaw);
		for (const [playerIdRaw, bonus] of Object.entries(teamBonus)) {
			const playerId = Number(playerIdRaw);
			if (players.get(playerId)?.teamId !== teamId) {
				context.logger.warn(
					{ eventId, teamId, playerId, revision: live.revision },
					"Live bonus identity does not match the pinned core publication"
				);
				return new Map();
			}
			bonusByPlayerId.set(playerId, bonus);
		}
	}
	metrics.cacheRepositoryEvents.labels("live_bonus", live.source).inc();
	return bonusByPlayerId;
}
