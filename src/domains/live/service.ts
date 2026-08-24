import { GraphQLError } from "graphql";
import type { GraphQLContext } from "../../graphql/context";
import { getCurrentEventId } from "../../infra/event";
import type {
	EventLive,
	LiveExplain,
	LiveExplainReadMode,
	LivePerformance,
	LiveScoresFilter,
} from "./repository";
import { applyLiveScoresFilter, liveRepository } from "./repository";
import { loadLiveSnapshotMeta, withLiveSnapshotConsistency } from "./snapshot-meta";
import { measureRequestStage } from "../../http/request-timing";

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

// The FPL event-live payload is the scoring authority, including projected
// live bonus.  Never recompute goals/assists/BPS/bonus locally.
const calculateTotalsForPerformances = async (
	_performances: LivePerformance[],
	_context: GraphQLContext,
	_eventId?: number
): Promise<LivePerformance[]> => _performances;

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
			const calculated = await calculateTotalsForPerformances(performances, context, targetEventId);
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
		return performance;
	},

	async getEventLive(context: GraphQLContext, eventId: number): Promise<EventLive> {
		return withLiveSnapshotConsistency(context, eventId, async () => {
			const eventLive = await liveRepository.getEventLive(context, eventId);
			return {
				...eventLive,
				performances: await calculateTotalsForPerformances(
					eventLive.performances,
					context,
					eventId
				),
			};
		});
	},

	async getGameweekBoards(context: GraphQLContext, eventId: number): Promise<GameweekBoards> {
		return measureRequestStage(context.requestTiming, "live.gameweek.coherence", () =>
			withLiveSnapshotConsistency(context, eventId, async () => {
				const meta = await measureRequestStage(context.requestTiming, "live.gameweek.meta", () =>
					loadLiveSnapshotMeta(context, eventId)
				);
				if (!meta) throw new Error(`Live snapshot metadata is unavailable for event ${eventId}`);
				const performances = await measureRequestStage(
					context.requestTiming,
					"live.gameweek.performances",
					() => liveRepository.getAllLivePerformances(context, eventId)
				);
				const calculated = await calculateTotalsForPerformances(
					Array.from(performances.values()),
					context,
					eventId
				);
				return {
					meta,
					dreamTeam: applyLiveScoresFilter(calculated, { inDreamTeam: true }),
					hauls: applyLiveScoresFilter(calculated, { minTotalPoints: 10 }),
				};
			})
		);
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
