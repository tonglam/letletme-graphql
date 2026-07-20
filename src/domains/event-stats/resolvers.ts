import type { GraphQLContext } from "../../graphql/context";
import type {
	CaptainStatPlayer,
	SelectionStatPlayer,
	TournamentSelectionStats,
	TransferStatPlayer,
} from "./repository";
import { eventStatsService } from "./service";

type TournamentSelectionStatsArgs = {
	tournamentId: number;
	eventId: number;
	limit?: number | null;
};

export const eventStatsResolvers = {
	Query: {
		tournamentSelectionStats: async (
			_parent: unknown,
			args: TournamentSelectionStatsArgs,
			context: GraphQLContext
		): Promise<TournamentSelectionStats> =>
			eventStatsService.getTournamentSelectionStats(
				context,
				args.tournamentId,
				args.eventId,
				args.limit ?? 10
			),
	},
	SelectionStatPlayer: {
		position: (parent: SelectionStatPlayer): string => parent.position,
	},
	CaptainStatPlayer: {
		position: (parent: CaptainStatPlayer): string => parent.position,
	},
	TransferStatPlayer: {
		position: (parent: TransferStatPlayer): string => parent.position,
	},
};
