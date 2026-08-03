import { GraphQLError } from "graphql";
import type { GraphQLContext } from "../../graphql/context";
import { buildTeamMap } from "../../infra/team-map";
import type {
	Player,
	PlayerPickerItem,
	PlayersFilter,
	PlayersForPickerPayload,
	PlayerTransferStats,
	Team,
} from "./repository";
import { Position } from "./repository";
import { playersService } from "./service";

const teamsMemo = new WeakMap<GraphQLContext, Map<number, Team | null>>();

const getTeamByIdMemoized = async (
	context: GraphQLContext,
	teamId: number
): Promise<Team | null> => {
	let memo = teamsMemo.get(context);
	if (!memo) {
		const map = await buildTeamMap(context);
		const entries = Array.from(map.entries()).map(
			([id, team]) => [id, team as Team | null] as [number, Team | null]
		);
		memo = new Map(entries);
		teamsMemo.set(context, memo);
	}
	return memo.get(teamId) ?? null;
};

const playersForEventMemo = new WeakMap<GraphQLContext, Map<string, Player | null>>();

const getPlayerByIdForEventMemoized = async (
	context: GraphQLContext,
	playerId: number,
	eventId: number
): Promise<Player | null> => {
	const key = `${playerId}:${eventId}`;
	let memo = playersForEventMemo.get(context);
	if (!memo) {
		memo = new Map();
		playersForEventMemo.set(context, memo);
	}
	const cached = memo.get(key);
	if (cached !== undefined) {
		return cached;
	}
	const player = await playersService.getPlayerByIdForEvent(context, playerId, eventId);
	memo.set(key, player);
	return player;
};

const loadPlayersIntoMemo = (
	context: GraphQLContext,
	eventId: number,
	players: Record<number, Player>
): void => {
	let memo = playersForEventMemo.get(context);
	if (!memo) {
		memo = new Map();
		playersForEventMemo.set(context, memo);
	}
	for (const [id, player] of Object.entries(players)) {
		memo.set(`${id}:${eventId}`, player);
	}
};

type PlayerArgs = {
	id: number;
};

type GraphQLPlayersFilter = {
	position?: string | null;
	teamId?: number | null;
	minPrice?: number | null;
	maxPrice?: number | null;
};

type PlayersArgs = {
	filter?: GraphQLPlayersFilter | null;
	limit?: number | null;
	offset?: number | null;
};

type TeamArgs = {
	id: number;
};

type TopTransfersArgs = {
	eventId: number;
	limit?: number | null;
};

type PlayersForPickerArgs = {
	search?: string | null;
	limit?: number | null;
	cursor?: number | null;
};

export function normalizePlayerPickerSearch(search: string | null | undefined): string | null {
	const normalized = search?.trim() ?? "";
	if (normalized.length === 0) return null;
	if (normalized.length > 50) {
		throw new GraphQLError("Player search must be 50 characters or fewer", {
			extensions: { code: "BAD_USER_INPUT" },
		});
	}
	return normalized;
}

const stringToPosition = (positionStr: string): Position => {
	switch (positionStr) {
		case "GOALKEEPER":
			return Position.GOALKEEPER;
		case "DEFENDER":
			return Position.DEFENDER;
		case "MIDFIELDER":
			return Position.MIDFIELDER;
		case "FORWARD":
			return Position.FORWARD;
		default:
			return Position.MIDFIELDER;
	}
};

export const playersResolvers = {
	Query: {
		player: async (
			_parent: unknown,
			args: PlayerArgs,
			context: GraphQLContext
		): Promise<Player | null> => playersService.getPlayerById(context, args.id),

		players: async (
			_parent: unknown,
			args: PlayersArgs,
			context: GraphQLContext
		): Promise<Player[]> => {
			const filter: PlayersFilter | undefined = args.filter
				? {
						position: args.filter.position ? stringToPosition(args.filter.position) : undefined,
						teamId: args.filter.teamId ?? undefined,
						minPrice: args.filter.minPrice ?? undefined,
						maxPrice: args.filter.maxPrice ?? undefined,
					}
				: undefined;

			return playersService.listPlayers(context, filter, args.limit ?? 50, args.offset ?? 0);
		},

		playersForPicker: async (
			_parent: unknown,
			args: PlayersForPickerArgs,
			context: GraphQLContext
		): Promise<PlayersForPickerPayload> =>
			playersService.getPlayersForPicker(
				context,
				args.limit ?? 20,
				args.cursor ?? null,
				normalizePlayerPickerSearch(args.search)
			),

		team: async (_parent: unknown, args: TeamArgs, context: GraphQLContext): Promise<Team | null> =>
			playersService.getTeamById(context, args.id),

		teams: async (
			_parent: unknown,
			_args: Record<string, never>,
			context: GraphQLContext
		): Promise<Team[]> => playersService.listTeams(context),

		topTransfersIn: async (
			_parent: unknown,
			args: TopTransfersArgs,
			context: GraphQLContext
		): Promise<PlayerTransferStats[]> => {
			const { stats, players } = await playersService.getTopTransfersInEnriched(
				context,
				args.eventId,
				args.limit ?? 10
			);
			loadPlayersIntoMemo(context, args.eventId, players);
			return stats;
		},

		topTransfersOut: async (
			_parent: unknown,
			args: TopTransfersArgs,
			context: GraphQLContext
		): Promise<PlayerTransferStats[]> => {
			const { stats, players } = await playersService.getTopTransfersOutEnriched(
				context,
				args.eventId,
				args.limit ?? 10
			);
			loadPlayersIntoMemo(context, args.eventId, players);
			return stats;
		},
	},
	PlayerTransferStats: {
		player: async (
			parent: PlayerTransferStats,
			_args: Record<string, never>,
			context: GraphQLContext
		): Promise<Player | null> =>
			getPlayerByIdForEventMemoized(context, parent.playerId, parent.eventId),
	},
	PlayerPickerItem: {
		position: (parent: PlayerPickerItem): string => {
			switch (parent.position) {
				case Position.GOALKEEPER:
					return "GOALKEEPER";
				case Position.DEFENDER:
					return "DEFENDER";
				case Position.MIDFIELDER:
					return "MIDFIELDER";
				case Position.FORWARD:
					return "FORWARD";
				default:
					return "MIDFIELDER";
			}
		},
	},
	Player: {
		team: async (
			parent: Player,
			_args: Record<string, never>,
			context: GraphQLContext
		): Promise<Team | null> => getTeamByIdMemoized(context, parent.teamId),
		value: (parent: Player): number => parent.price,
		totalPoints: (parent: Player): number => parent.totalPoints ?? 0,
		selectedByPercent: (parent: Player): number | null => parent.selectedByPercent ?? null,
		position: (parent: Player): string => {
			switch (parent.position) {
				case Position.GOALKEEPER:
					return "GOALKEEPER";
				case Position.DEFENDER:
					return "DEFENDER";
				case Position.MIDFIELDER:
					return "MIDFIELDER";
				case Position.FORWARD:
					return "FORWARD";
				default:
					return "MIDFIELDER";
			}
		},
	},
};
