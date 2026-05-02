import type { GraphQLContext } from "../../graphql/context";
import type { Event } from "../events/repository";
import { eventsService } from "../events/service";
import type { Player } from "../players/repository";
import { playersService } from "../players/service";
import type {
	EventLive,
	LiveExplain,
	LivePerformance,
	LiveScoresFilter,
} from "./repository";
import { liveService } from "./service";

/**
 * Per-request memoization for player lookups to avoid N+1 Redis/DB round-trips
 * when resolving the `player` field on multiple LivePerformance/LiveExplain rows.
 */
const playersMemo = new WeakMap<GraphQLContext, Map<number, Player | null>>();

const getPlayerByIdMemoized = async (
	context: GraphQLContext,
	playerId: number,
): Promise<Player | null> => {
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
	eventId: number,
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

type LiveExplainArgs = {
	eventId: number;
	elementId: number;
};

type TopPerformersArgs = {
	limit?: number | null;
};

export const liveResolvers = {
	Query: {
		liveScores: async (
			_parent: unknown,
			args: LiveScoresArgs,
			context: GraphQLContext,
		): Promise<LivePerformance[]> =>
			liveService.getLiveScores(
				context,
				args.eventId ?? undefined,
				args.filter ?? undefined,
			),

		playerLive: async (
			_parent: unknown,
			args: PlayerLiveArgs,
			context: GraphQLContext,
		): Promise<LivePerformance | null> =>
			liveService.getPlayerLive(
				context,
				args.playerId,
				args.eventId ?? undefined,
			),

		eventLive: async (
			_parent: unknown,
			args: EventLiveArgs,
			context: GraphQLContext,
		): Promise<EventLive> => liveService.getEventLive(context, args.eventId),
		eventLiveExplain: async (
			_parent: unknown,
			args: LiveExplainArgs,
			context: GraphQLContext,
		): Promise<LiveExplain | null> =>
			liveService.getEventLiveExplain(context, args.eventId, args.elementId),
	},
	EventLive: {
		event: async (
			parent: EventLive,
			_args: Record<string, never>,
			context: GraphQLContext,
		): Promise<Event | null> => getEventByIdMemoized(context, parent.eventId),
		performances: (parent: EventLive): LivePerformance[] => parent.performances,
		dreamTeam: (parent: EventLive): LivePerformance[] =>
			parent.performances.filter((p) => p.inDreamTeam === true),
		topPerformers: (
			parent: EventLive,
			args: TopPerformersArgs,
		): LivePerformance[] => {
			const limit = args.limit ?? 10;
			return [...parent.performances]
				.sort((a, b) => b.totalPoints - a.totalPoints)
				.slice(0, limit);
		},
	},
	LivePerformance: {
		event: async (
			parent: LivePerformance,
			_args: Record<string, never>,
			context: GraphQLContext,
		): Promise<Event | null> => getEventByIdMemoized(context, parent.eventId),
		player: async (
			parent: LivePerformance,
			_args: Record<string, never>,
			context: GraphQLContext,
		): Promise<Player | null> =>
			getPlayerByIdMemoized(context, parent.playerId),
		expectedGoals: (parent: LivePerformance): number | null =>
			parent.expectedGoals ? parseFloat(parent.expectedGoals) : null,
		expectedAssists: (parent: LivePerformance): number | null =>
			parent.expectedAssists ? parseFloat(parent.expectedAssists) : null,
		expectedGoalInvolvements: (parent: LivePerformance): number | null =>
			parent.expectedGoalInvolvements
				? parseFloat(parent.expectedGoalInvolvements)
				: null,
		expectedGoalsConceded: (parent: LivePerformance): number | null =>
			parent.expectedGoalsConceded
				? parseFloat(parent.expectedGoalsConceded)
				: null,
	},
	LiveExplain: {
		event: async (
			parent: LiveExplain,
			_args: Record<string, never>,
			context: GraphQLContext,
		): Promise<Event | null> => getEventByIdMemoized(context, parent.eventId),
		player: async (
			parent: LiveExplain,
			_args: Record<string, never>,
			context: GraphQLContext,
		): Promise<Player | null> =>
			getPlayerByIdMemoized(context, parent.elementId),
		selectedBy: async (
			parent: LiveExplain,
			_args: Record<string, never>,
			context: GraphQLContext,
		): Promise<number | null> =>
			liveService.getSelectedByPercent(
				context,
				parent.eventId,
				parent.elementId,
			),
	},
};
