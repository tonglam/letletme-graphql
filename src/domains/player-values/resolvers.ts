import type { GraphQLContext } from '../../graphql/context';
import type { PlayerValue, PlayerValueHistoryItem } from './repository';
import { playerValuesService } from './service';

type PlayerValuesArgs = {
  changeDate?: Date | null;
};

type PlayerValueHistoryArgs = {
  playerId: number;
  limit?: number | null;
  fromDate?: Date | null;
  toDate?: Date | null;
};

const DEFAULT_HISTORY_LIMIT = 30;
const MAX_HISTORY_LIMIT = 365;

export type NormalizedPlayerValueHistoryArgs = {
  playerId: number;
  limit: number;
  fromDate?: Date;
  toDate?: Date;
};

export function normalizePlayerValueHistoryArgs(
  args: PlayerValueHistoryArgs
): NormalizedPlayerValueHistoryArgs {
  const safeLimit = Number.isFinite(args.limit) ? Number(args.limit) : DEFAULT_HISTORY_LIMIT;
  const boundedLimit = Math.min(Math.max(safeLimit, 1), MAX_HISTORY_LIMIT);

  const fromDate = args.fromDate ?? undefined;
  const toDate = args.toDate ?? undefined;

  if (fromDate && toDate && fromDate.getTime() > toDate.getTime()) {
    throw new Error('Invalid date range: fromDate must be less than or equal to toDate');
  }

  return {
    playerId: args.playerId,
    limit: boundedLimit,
    fromDate,
    toDate,
  };
}

export const playerValuesResolvers = {
  Query: {
    playerValues: async (
      _parent: unknown,
      args: PlayerValuesArgs,
      context: GraphQLContext
    ): Promise<PlayerValue[]> => playerValuesService.getPlayerValues(context, args.changeDate),
    playerValueHistory: async (
      _parent: unknown,
      args: PlayerValueHistoryArgs,
      context: GraphQLContext
    ): Promise<PlayerValueHistoryItem[]> =>
      playerValuesService.getPlayerValueHistory(context, normalizePlayerValueHistoryArgs(args)),
  },
};
