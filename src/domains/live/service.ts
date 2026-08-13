import { GraphQLError } from "graphql";
import type { GraphQLContext } from "../../graphql/context";
import { getCurrentEventId } from "../../infra/event";
import { calcElementLivePoints } from "../entry-live/calc-service";
import { loadLiveBonusByPlayerId } from "./bonus-cache";
import type {
	EventLive,
	LiveExplain,
	LiveExplainReadMode,
	LivePerformance,
	LiveScoresFilter,
} from "./repository";
import { applyLiveScoresFilter, liveRepository } from "./repository";
import { loadLiveSnapshotMeta, withLiveSnapshotConsistency } from "./snapshot-meta";

export const MAX_LIVE_EXPLAIN_BATCH = 15;

export type GameweekBoards = {
	dreamTeam: LivePerformance[];
	hauls: LivePerformance[];
	meta: NonNullable<Awaited<ReturnType<typeof loadLiveSnapshotMeta>>>;
};

export const assertValidLiveExplainBatch = (elementIds: readonly number[]): void => {
	if (elementIds.length > MAX_LIVE_EXPLAIN_BATCH) {
		throw new GraphQLError(
			`Live explain batch exceeds the ${MAX_LIVE_EXPLAIN_BATCH} player limit`,
			{ extensions: { code: "QUERY_TOO_COMPLEX" } }
		);
	}
	if (
		elementIds.some((elementId) => !Number.isSafeInteger(elementId) || elementId <= 0) ||
		new Set(elementIds).size !== elementIds.length
	) {
		throw new GraphQLError("Live explain player IDs must be unique positive integers", {
			extensions: { code: "BAD_USER_INPUT" },
		});
	}
};

const withCalculatedTotalPoints = (
	live: LivePerformance,
	bonusOverride?: number
): LivePerformance => ({
	...live,
	bonus: bonusOverride ?? live.bonus,
	totalPoints: calcElementLivePoints(live, bonusOverride),
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
	const bonusByPlayerId = targetEventId
		? await loadLiveBonusByPlayerId(context, targetEventId)
		: new Map<number, number>();

	return performances.map((performance) =>
		withCalculatedTotalPoints(performance, bonusByPlayerId.get(performance.playerId))
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
		const targeted = await liveRepository.getTargetedLiveRead(context, targetEventId, [playerId]);
		const performance = targeted.performances.find((value) => value.playerId === playerId);
		if (!performance) return null;
		return withCalculatedTotalPoints(performance, targeted.effectiveBonusByPlayer.get(playerId));
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

	async getGameweekBoards(context: GraphQLContext, eventId: number): Promise<GameweekBoards> {
		return withLiveSnapshotConsistency(context, eventId, async () => {
			const meta = await loadLiveSnapshotMeta(context, eventId);
			if (!meta) throw new Error(`Live snapshot metadata is unavailable for event ${eventId}`);
			const performances = await liveRepository.getAllLivePerformances(context, eventId);
			const calculated = await calculateTotalsForPerformances(
				context,
				Array.from(performances.values()),
				eventId
			);
			return {
				meta,
				dreamTeam: applyLiveScoresFilter(calculated, { inDreamTeam: true }),
				hauls: applyLiveScoresFilter(calculated, { minTotalPoints: 10 }),
			};
		});
	},

	async getEventLiveExplain(
		context: GraphQLContext,
		eventId: number,
		elementId: number,
		includeSelectedBy = false
	): Promise<LiveExplain | null> {
		return withLiveSnapshotConsistency(context, eventId, () =>
			liveRepository.getEventLiveExplain(context, eventId, elementId, includeSelectedBy)
		);
	},

	async getEventLiveExplains(
		context: GraphQLContext,
		eventId: number,
		elementIds: number[],
		mode: LiveExplainReadMode = "full",
		includeSelectedBy = false
	): Promise<LiveExplain[]> {
		assertValidLiveExplainBatch(elementIds);
		if (elementIds.length === 0) return [];
		return withLiveSnapshotConsistency(context, eventId, () =>
			liveRepository.getEventLiveExplains(context, eventId, elementIds, mode, includeSelectedBy)
		);
	},

	getSelectedByPercent(
		context: GraphQLContext,
		eventId: number,
		elementId: number
	): Promise<number | null> {
		return liveRepository.getSelectedByPercent(context, eventId, elementId);
	},
};
