import type { GraphQLContext } from '../../graphql/context';
import { entryLiveRepository } from '../entry-live/repository';
import {
  buildTeamMapById,
  enrichTransferRows,
  type EntryEventTransfersData,
} from '../entry-live/transfer-enrichment';
import { liveRepository } from '../live/repository';
import type { Player } from '../players/repository';
import { playersRepository } from '../players/repository';
import type { Entry, EntryEventResult, EntryHistoryInfo } from './repository';
import { entriesRepository } from './repository';

export type EntryGameweekTransfers = {
  eventId: number;
  eventTransfers: number;
  eventTransfersCost: number;
  transfers: EntryEventTransfersData[];
};

const uniquePositiveIds = (ids: number[]): number[] =>
  Array.from(new Set(ids.filter((id) => Number.isInteger(id) && id > 0)));

export const entriesService = {
  getEntryById(context: GraphQLContext, id: number): Promise<Entry | null> {
    return entriesRepository.getEntryById(context, id);
  },

  getEntryHistory(context: GraphQLContext, entryId: number): Promise<EntryEventResult[]> {
    return entriesRepository.getEntryHistory(context, entryId);
  },

  getEntryHistoryInfo(context: GraphQLContext, entryId: number): Promise<EntryHistoryInfo[]> {
    return entriesRepository.getEntryHistoryInfo(context, entryId);
  },

  getEntryEventResult(
    context: GraphQLContext,
    entryId: number,
    eventId: number
  ): Promise<EntryEventResult | null> {
    return entriesRepository.getEntryEventResult(context, entryId, eventId);
  },

  async getEntryTransferHistory(
    context: GraphQLContext,
    entryId: number
  ): Promise<EntryGameweekTransfers[]> {
    const [transferRows, eventResults, teams] = await Promise.all([
      entryLiveRepository.getEntryTransferHistory(context, entryId),
      entriesRepository.getEntryHistory(context, entryId),
      playersRepository.listTeams(context),
    ]);

    if (transferRows.length === 0) {
      return [];
    }

    const playerIds = uniquePositiveIds(
      transferRows.flatMap((row) => [row.elementIn, row.elementOut])
    );

    const players: Player[] =
      playerIds.length > 0 ? await playersRepository.getPlayersByIds(context, playerIds) : [];
    const playersById = new Map(players.map((player) => [player.id, player]));
    const teamsById = buildTeamMapById(teams);

    const rowsByEvent = new Map<number, typeof transferRows>();
    for (const row of transferRows) {
      const current = rowsByEvent.get(row.eventId);
      if (current) {
        current.push(row);
      } else {
        rowsByEvent.set(row.eventId, [row]);
      }
    }

    const eventIds = Array.from(rowsByEvent.keys()).sort((a, b) => a - b);
    const eventResultById = new Map(eventResults.map((result) => [result.eventId, result]));

    const gameweekHistory = await Promise.all(
      eventIds.map(async (eventId): Promise<EntryGameweekTransfers> => {
        const eventRows = rowsByEvent.get(eventId) ?? [];
        const eventPlayerIds = uniquePositiveIds(
          eventRows.flatMap((row) => [row.elementIn, row.elementOut])
        );
        const livePerformances = await liveRepository.getLivePerformancesByPlayerIds(
          context,
          eventId,
          eventPlayerIds
        );
        const liveByPlayer = new Map(livePerformances.map((live) => [live.playerId, live]));
        const transfers = enrichTransferRows({
          entryId,
          eventId,
          transferRows: eventRows,
          playersById,
          teamsById,
          liveByPlayer,
        });
        const eventResult = eventResultById.get(eventId);

        return {
          eventId,
          eventTransfers: eventResult?.eventTransfers ?? transfers.length,
          eventTransfersCost: eventResult?.eventTransfersCost ?? 0,
          transfers,
        };
      })
    );

    return gameweekHistory;
  },
};
