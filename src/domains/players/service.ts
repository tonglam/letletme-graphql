import type { GraphQLContext } from "../../graphql/context";
import type {
	Player,
	PlayersFilter,
	PlayerPickerSort,
	PlayersForPickerPayload,
	Team,
	TopTransfersEnriched,
} from "./repository";
import { playersRepository } from "./repository";

export const playersService = {
	getPlayerById(context: GraphQLContext, id: number): Promise<Player | null> {
		return playersRepository.getPlayerById(context, id);
	},

	getPlayerByIdForEvent(
		context: GraphQLContext,
		id: number,
		eventId: number
	): Promise<Player | null> {
		return playersRepository.getPlayerByIdForEvent(context, id, eventId);
	},

	getPlayersByIds(context: GraphQLContext, ids: number[]): Promise<Player[]> {
		return playersRepository.getPlayersByIds(context, ids);
	},

	getPlayersByIdsForEvent(
		context: GraphQLContext,
		ids: number[],
		eventId: number
	): Promise<Map<number, Player>> {
		return playersRepository.getPlayersByIdsForEvent(context, ids, eventId);
	},

	listPlayers(
		context: GraphQLContext,
		filter: PlayersFilter | null | undefined,
		limit: number,
		offset: number
	): Promise<Player[]> {
		return playersRepository.listPlayers(context, filter, limit, offset);
	},

	getPlayersForPicker(
		context: GraphQLContext,
		limit: number,
		cursor: number | null | undefined,
		search: string | null = null,
		filter?: PlayersFilter | null,
		sort?: PlayerPickerSort
	): Promise<PlayersForPickerPayload> {
		return playersRepository.getPlayersForPicker(context, limit, cursor, search, filter, sort);
	},

	getTeamById(context: GraphQLContext, id: number): Promise<Team | null> {
		return playersRepository.getTeamById(context, id);
	},

	listTeams(context: GraphQLContext): Promise<Team[]> {
		return playersRepository.listTeams(context);
	},

	getTopTransfersInEnriched(
		context: GraphQLContext,
		eventId: number,
		limit: number
	): Promise<TopTransfersEnriched> {
		return playersRepository.getTopTransfersInEnriched(context, eventId, limit);
	},

	getTopTransfersOutEnriched(
		context: GraphQLContext,
		eventId: number,
		limit: number
	): Promise<TopTransfersEnriched> {
		return playersRepository.getTopTransfersOutEnriched(context, eventId, limit);
	},
};
