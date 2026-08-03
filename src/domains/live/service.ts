import type { GraphQLContext } from "../../graphql/context";
import { getCurrentEventId } from "../../infra/event";
import { calcElementLivePoints } from "../entry-live/calc-service";
import { playersRepository } from "../players/repository";
import { loadLiveBonusByPlayerId } from "./bonus-cache";
import type { EventLive, LiveExplain, LivePerformance, LiveScoresFilter } from "./repository";
import { applyLiveScoresFilter, liveRepository } from "./repository";
import { withLiveSnapshotConsistency } from "./snapshot-meta";

const withCalculatedTotalPoints = (
	live: LivePerformance,
	elementType: number | undefined,
	bonusOverride?: number
): LivePerformance => ({
	...live,
	bonus: bonusOverride ?? live.bonus,
	totalPoints: calcElementLivePoints(elementType ?? 0, live, bonusOverride),
});

const calculateTotalsForPerformances = async (
	context: GraphQLContext,
	performances: LivePerformance[],
	eventId?: number
): Promise<LivePerformance[]> => {
	if (performances.length === 0) {
		return performances;
	}

	const targetEventId = eventId ?? performances[0]?.eventId;
	const playerIds = [
		...new Set(
			performances
				.map((performance) => performance.playerId)
				.filter((id) => Number.isFinite(id) && id > 0)
		),
	];
	const [bonusByPlayerId, players] = await Promise.all([
		targetEventId
			? loadLiveBonusByPlayerId(context, targetEventId)
			: Promise.resolve(new Map<number, number>()),
		playersRepository.getPlayersByIds(context, playerIds),
	]);
	const playersById = new Map(players.map((player) => [player.id, player]));

	return performances.map((performance) =>
		withCalculatedTotalPoints(
			performance,
			playersById.get(performance.playerId)?.position,
			bonusByPlayerId.get(performance.playerId)
		)
	);
};

export const liveService = {
	async getLiveScores(
		context: GraphQLContext,
		eventId?: number,
		filter?: LiveScoresFilter | null
	): Promise<LivePerformance[]> {
		const targetEventId = eventId ?? (await getCurrentEventId(context));
		if (!targetEventId) return [];
		return withLiveSnapshotConsistency(context, targetEventId, async () => {
			const performances = await liveRepository.getLiveScores(context, targetEventId);
			const calculated = await calculateTotalsForPerformances(context, performances, targetEventId);
			return applyLiveScoresFilter(calculated, filter);
		});
	},

	async getPlayerLive(
		context: GraphQLContext,
		playerId: number,
		eventId?: number
	): Promise<LivePerformance | null> {
		const targetEventId = eventId ?? (await getCurrentEventId(context)) ?? undefined;
		if (!targetEventId) return null;
		return withLiveSnapshotConsistency(context, targetEventId, async () => {
			const [performance, player, bonusByPlayerId] = await Promise.all([
				liveRepository.getPlayerLive(context, playerId, targetEventId),
				playersRepository.getPlayerById(context, playerId),
				loadLiveBonusByPlayerId(context, targetEventId),
			]);
			if (!performance) return null;
			return withCalculatedTotalPoints(
				performance,
				player?.position,
				bonusByPlayerId.get(playerId)
			);
		});
	},

	async getEventLive(context: GraphQLContext, eventId: number): Promise<EventLive> {
		return withLiveSnapshotConsistency(context, eventId, async () => {
			const eventLive = await liveRepository.getEventLive(context, eventId);
			return {
				...eventLive,
				performances: await calculateTotalsForPerformances(
					context,
					eventLive.performances,
					eventId
				),
			};
		});
	},

	getEventLiveExplain(
		context: GraphQLContext,
		eventId: number,
		elementId: number
	): Promise<LiveExplain | null> {
		return liveRepository.getEventLiveExplain(context, eventId, elementId);
	},

	getSelectedByPercent(
		context: GraphQLContext,
		eventId: number,
		elementId: number
	): Promise<number | null> {
		return liveRepository.getSelectedByPercent(context, eventId, elementId);
	},
};
