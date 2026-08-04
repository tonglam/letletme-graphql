import type { GraphQLResolveInfo } from "graphql";
import type { GraphQLContext } from "../../graphql/context";
import {
	directSelectionRequestsField,
	parentSelectionRequestsField,
} from "../../graphql/selection-set";
import { getCurrentEventId } from "../../infra/event";
import type { Event } from "../events/repository";
import { eventsService } from "../events/service";
import type { Player } from "../players/repository";
import { playersService } from "../players/service";
import type { EventLive, LiveExplain, LivePerformance, LiveScoresFilter } from "./repository";
import { liveService } from "./service";
import {
	loadOperationLiveSnapshotMeta,
	type LiveSnapshotMeta,
	type LiveSnapshotState,
	withLiveSnapshotRoot,
} from "./snapshot-meta";

/**
 * Per-request memoization for player lookups to avoid N+1 Redis/DB round-trips
 * when resolving the `player` field on multiple LivePerformance/LiveExplain rows.
 */
const playersMemo = new WeakMap<GraphQLContext, Map<number, Player | null>>();

const getPlayerByIdMemoized = async (
	context: GraphQLContext,
	playerId: number
): Promise<Player | null> => {
	const bulk = context.playersByIdPreload;
	if (bulk?.has(playerId)) {
		return bulk.get(playerId) ?? null;
	}

	let memo = playersMemo.get(context);
	if (!memo) {
		memo = new Map();
		playersMemo.set(context, memo);
	}
	const cached = memo.get(playerId);
	if (cached !== undefined) {
		return cached;
	}
	const player = await playersService.getPlayerById(context, playerId);
	memo.set(playerId, player);
	return player;
};

/**
 * Per-request memoization for event lookups to avoid N+1 Redis/DB round-trips
 * when resolving the `event` field on multiple EventLive/LivePerformance rows.
 */
const eventsMemo = new WeakMap<GraphQLContext, Map<number, Event | null>>();

const getEventByIdMemoized = async (
	context: GraphQLContext,
	eventId: number
): Promise<Event | null> => {
	let memo = eventsMemo.get(context);
	if (!memo) {
		memo = new Map();
		eventsMemo.set(context, memo);
	}
	const cached = memo.get(eventId);
	if (cached !== undefined) {
		return cached;
	}
	const event = await eventsService.getEventById(context, eventId);
	memo.set(eventId, event);
	return event;
};

const preloadPlayersByIds = async (context: GraphQLContext, ids: number[]): Promise<void> => {
	const uniqueIds = [...new Set(ids.filter((id) => Number.isFinite(id) && id > 0))];
	if (uniqueIds.length === 0) return;
	const players = await playersService.getPlayersByIds(context, uniqueIds);
	// Sibling roots resolve concurrently. Merge after the bulk read so a later
	// completion cannot discard player rows preloaded by another live root.
	const preload = new Map(context.playersByIdPreload ?? []);
	for (const id of uniqueIds) {
		preload.set(id, null);
	}
	for (const player of players) {
		preload.set(player.id, player);
	}
	context.playersByIdPreload = preload;
};

const preloadPlayersForLivePerformances = (
	context: GraphQLContext,
	performances: LivePerformance[]
): Promise<void> =>
	preloadPlayersByIds(
		context,
		performances.map((performance) => performance.playerId)
	);

type LiveScoresArgs = {
	eventId?: number | null;
	filter?: LiveScoresFilter | null;
};

type PlayerLiveArgs = {
	playerId: number;
	eventId?: number | null;
};

type EventLiveArgs = {
	eventId: number;
};

type LiveSnapshotArgs = {
	eventId?: number | null;
};

type LiveExplainArgs = {
	eventId: number;
	elementId: number;
};

type LiveExplainsArgs = {
	eventId: number;
	elementIds: number[];
};

type TopPerformersArgs = {
	limit?: number | null;
};

export const normalizeTopPerformersLimit = (limit?: number | null): number =>
	Math.max(0, limit ?? 10);

export const liveResolvers = {
	Query: {
		liveScores: async (
			_parent: unknown,
			args: LiveScoresArgs,
			context: GraphQLContext,
			info: GraphQLResolveInfo
		): Promise<LivePerformance[]> =>
			withLiveSnapshotRoot(context, async () => {
				const scores = await liveService.getLiveScores(
					context,
					args.eventId ?? undefined,
					args.filter ?? undefined
				);

				if (scores.length > 0 && parentSelectionRequestsField(info, "player")) {
					await preloadPlayersForLivePerformances(context, scores);
				}

				return scores;
			}),

		playerLive: async (
			_parent: unknown,
			args: PlayerLiveArgs,
			context: GraphQLContext
		): Promise<LivePerformance | null> =>
			withLiveSnapshotRoot(context, () =>
				liveService.getPlayerLive(context, args.playerId, args.eventId ?? undefined)
			),

		eventLive: async (
			_parent: unknown,
			args: EventLiveArgs,
			context: GraphQLContext,
			info: GraphQLResolveInfo
		): Promise<EventLive> =>
			withLiveSnapshotRoot(context, async () => {
				const eventLive = await liveService.getEventLive(context, args.eventId);
				if (parentSelectionRequestsField(info, "player")) {
					await preloadPlayersForLivePerformances(context, eventLive.performances);
				}
				return eventLive;
			}),
		eventLiveExplain: async (
			_parent: unknown,
			args: LiveExplainArgs,
			context: GraphQLContext,
			info: GraphQLResolveInfo
		): Promise<LiveExplain | null> =>
			withLiveSnapshotRoot(context, () =>
				liveService.getEventLiveExplain(
					context,
					args.eventId,
					args.elementId,
					directSelectionRequestsField(info, "selectedBy")
				)
			),
		eventLiveExplains: async (
			_parent: unknown,
			args: LiveExplainsArgs,
			context: GraphQLContext,
			info: GraphQLResolveInfo
		): Promise<LiveExplain[]> =>
			withLiveSnapshotRoot(context, async () => {
				const mode = ["stats", "breakdown", "modified"].some((field) =>
					directSelectionRequestsField(info, field)
				)
					? "full"
					: "contributions";
				const includeSelectedBy = directSelectionRequestsField(info, "selectedBy");
				const explains = await liveService.getEventLiveExplains(
					context,
					args.eventId,
					args.elementIds,
					mode,
					includeSelectedBy
				);
				if (explains.length > 0 && parentSelectionRequestsField(info, "player")) {
					await preloadPlayersByIds(
						context,
						explains.map((explain) => explain.elementId)
					);
				}
				return explains;
			}),
		liveSnapshot: async (
			_parent: unknown,
			args: LiveSnapshotArgs,
			context: GraphQLContext
		): Promise<LiveSnapshotMeta | null> => {
			const eventId = args.eventId ?? (await getCurrentEventId(context));
			return eventId ? loadOperationLiveSnapshotMeta(context, eventId) : null;
		},
	},
	LiveSnapshotMeta: {
		state: (parent: LiveSnapshotMeta): Uppercase<LiveSnapshotState> =>
			parent.state.toUpperCase() as Uppercase<LiveSnapshotState>,
	},
	EventLive: {
		event: async (
			parent: EventLive,
			_args: Record<string, never>,
			context: GraphQLContext
		): Promise<Event | null> => getEventByIdMemoized(context, parent.eventId),
		performances: (parent: EventLive): LivePerformance[] => parent.performances,
		dreamTeam: (parent: EventLive): LivePerformance[] =>
			parent.performances.filter((p) => p.inDreamTeam === true),
		topPerformers: (parent: EventLive, args: TopPerformersArgs): LivePerformance[] => {
			const limit = normalizeTopPerformersLimit(args.limit);
			return [...parent.performances].sort((a, b) => b.totalPoints - a.totalPoints).slice(0, limit);
		},
	},
	LivePerformance: {
		event: async (
			parent: LivePerformance,
			_args: Record<string, never>,
			context: GraphQLContext
		): Promise<Event | null> => getEventByIdMemoized(context, parent.eventId),
		player: async (
			parent: LivePerformance,
			_args: Record<string, never>,
			context: GraphQLContext
		): Promise<Player | null> => getPlayerByIdMemoized(context, parent.playerId),
		expectedGoals: (parent: LivePerformance): number | null =>
			parent.expectedGoals ? parseFloat(parent.expectedGoals) : null,
		expectedAssists: (parent: LivePerformance): number | null =>
			parent.expectedAssists ? parseFloat(parent.expectedAssists) : null,
		expectedGoalInvolvements: (parent: LivePerformance): number | null =>
			parent.expectedGoalInvolvements ? parseFloat(parent.expectedGoalInvolvements) : null,
		expectedGoalsConceded: (parent: LivePerformance): number | null =>
			parent.expectedGoalsConceded ? parseFloat(parent.expectedGoalsConceded) : null,
	},
	LiveExplain: {
		contributions: (parent: LiveExplain): NonNullable<LiveExplain["contributions"]> =>
			parent.contributions ?? parent.breakdown.flatMap((entry) => entry.stats),
		event: async (
			parent: LiveExplain,
			_args: Record<string, never>,
			context: GraphQLContext
		): Promise<Event | null> => getEventByIdMemoized(context, parent.eventId),
		player: async (
			parent: LiveExplain,
			_args: Record<string, never>,
			context: GraphQLContext
		): Promise<Player | null> => getPlayerByIdMemoized(context, parent.elementId),
		selectedBy: async (
			parent: LiveExplain,
			_args: Record<string, never>,
			context: GraphQLContext
		): Promise<number | null> => {
			const preloadKey = `${parent.eventId}:${parent.elementId}`;
			if (context.liveSelectedByPreload?.has(preloadKey)) {
				return context.liveSelectedByPreload.get(preloadKey) ?? null;
			}
			return liveService.getSelectedByPercent(context, parent.eventId, parent.elementId);
		},
	},
};
