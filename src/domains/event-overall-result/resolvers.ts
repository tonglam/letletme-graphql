import type { GraphQLContext } from "../../graphql/context";
import type { Player, Team } from "../players/repository";
import { playersService } from "../players/service";
import type { EventResult, EventResultPlayer, TopElementInfo } from "./repository";
import { eventOverallResultService } from "./service";
import { measureRequestStage } from "../../http/request-timing";

const EVENT_OVERALL_RESULT_STAGE = "gwSummary.eventOverallResult";

const measureEventOverallResultStage = <T>(
	context: GraphQLContext,
	task: () => Promise<T>
): Promise<T> => measureRequestStage(context.requestTiming, EVENT_OVERALL_RESULT_STAGE, task);

/**
 * Per-request memoization for player lookups to avoid N+1 Redis/DB round-trips
 * when resolving player fields on multiple EventResult rows.
 */
const playerMemo = new WeakMap<GraphQLContext, Map<number, Player | null>>();

const getPlayerByIdMemoized = async (
	context: GraphQLContext,
	playerId: number
): Promise<Player | null> => {
	let memo = playerMemo.get(context);
	if (!memo) {
		memo = new Map();
		playerMemo.set(context, memo);
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
 * Per-request memoization for team lookups to avoid N+1 Redis/DB round-trips
 * when resolving team fields on multiple TopElementInfo rows.
 */
const teamMemo = new WeakMap<GraphQLContext, Map<number, Team | null>>();

const getTeamByIdMemoized = async (
	context: GraphQLContext,
	teamId: number
): Promise<Team | null> => {
	let memo = teamMemo.get(context);
	if (!memo) {
		memo = new Map();
		teamMemo.set(context, memo);
	}
	const cached = memo.get(teamId);
	if (cached !== undefined) {
		return cached;
	}
	const team = await playersService.getTeamById(context, teamId);
	memo.set(teamId, team);
	return team;
};

function toEventResultPlayer(player: Player): EventResultPlayer {
	return {
		id: player.id,
		webName: player.webName,
	};
}

export const eventOverallResultResolvers = {
	Query: {
		eventOverallResult: async (
			_parent: unknown,
			_args: { eventId?: number | null },
			context: GraphQLContext
		): Promise<EventResult[]> =>
			measureEventOverallResultStage(context, () =>
				eventOverallResultService.getEventOverallResult(context, _args.eventId)
			),
	},
	EventResult: {
		mostSelectedPlayer: async (
			parent: EventResult,
			_args: Record<string, never>,
			context: GraphQLContext
		): Promise<EventResultPlayer | null> =>
			measureEventOverallResultStage(context, async () => {
				if (parent.mostSelectedPlayer) {
					return parent.mostSelectedPlayer;
				}

				if (!parent.mostSelectedId || parent.mostSelectedId === 0) {
					return null;
				}

				const player = await getPlayerByIdMemoized(context, parent.mostSelectedId);
				return player ? toEventResultPlayer(player) : null;
			}),
		mostCaptainedPlayer: async (
			parent: EventResult,
			_args: Record<string, never>,
			context: GraphQLContext
		): Promise<EventResultPlayer | null> =>
			measureEventOverallResultStage(context, async () => {
				if (parent.mostCaptainedPlayer) {
					return parent.mostCaptainedPlayer;
				}

				if (!parent.mostCaptainedId || parent.mostCaptainedId === 0) {
					return null;
				}

				const player = await getPlayerByIdMemoized(context, parent.mostCaptainedId);
				return player ? toEventResultPlayer(player) : null;
			}),
		mostTransferInPlayer: async (
			parent: EventResult,
			_args: Record<string, never>,
			context: GraphQLContext
		): Promise<EventResultPlayer | null> =>
			measureEventOverallResultStage(context, async () => {
				if (parent.mostTransferInPlayer) {
					return parent.mostTransferInPlayer;
				}

				if (!parent.mostTransferredInId || parent.mostTransferredInId === 0) {
					return null;
				}

				const player = await getPlayerByIdMemoized(context, parent.mostTransferredInId);
				return player ? toEventResultPlayer(player) : null;
			}),
		mostViceCaptainedPlayer: async (
			parent: EventResult,
			_args: Record<string, never>,
			context: GraphQLContext
		): Promise<EventResultPlayer | null> =>
			measureEventOverallResultStage(context, async () => {
				if (parent.mostViceCaptainedPlayer) {
					return parent.mostViceCaptainedPlayer;
				}

				if (!parent.mostViceCaptainedId || parent.mostViceCaptainedId === 0) {
					return null;
				}

				const player = await getPlayerByIdMemoized(context, parent.mostViceCaptainedId);
				return player ? toEventResultPlayer(player) : null;
			}),
	},
	TopElementInfo: {
		player: async (
			parent: TopElementInfo,
			_args: Record<string, never>,
			context: GraphQLContext
		): Promise<Player | null> =>
			measureEventOverallResultStage(context, async () => {
				if (!parent.element || parent.element === 0) {
					return null;
				}
				return getPlayerByIdMemoized(context, parent.element);
			}),
		teamShortName: async (
			parent: TopElementInfo,
			_args: Record<string, never>,
			context: GraphQLContext
		): Promise<string | null> =>
			measureEventOverallResultStage(context, async () => {
				if (!parent.element || parent.element === 0) {
					return null;
				}

				const player = await getPlayerByIdMemoized(context, parent.element);
				if (!player) {
					return null;
				}

				const team = await getTeamByIdMemoized(context, player.teamId);
				return team?.shortName ?? null;
			}),
	},
};
