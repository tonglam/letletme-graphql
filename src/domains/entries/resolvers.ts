import type { GraphQLContext } from '../../graphql/context';
import type { ElementEventResultData, LiveCalcData } from '../entry-live/calc-service';
import { entryLiveCalcService } from '../entry-live/calc-service';
import type { Player } from '../players/repository';
import { playersService } from '../players/service';
import type { Entry, EntryEventResult, EntryHistoryInfo } from './repository';
import type { EntryGameweekTransfers } from './service';
import { entriesService } from './service';

/**
 * Per-request memoization for player-event lookups to avoid N+1 Redis/DB round-trips
 * when resolving the `eventPlayedCaptain` field on multiple EntryEventResult rows.
 */
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
  if (memo.has(key)) {
    return memo.get(key)!;
  }
  const player = await playersService.getPlayerByIdForEvent(context, playerId, eventId);
  memo.set(key, player);
  return player;
};

type EntryArgs = {
  id: number;
};

type EntryHistoryArgs = {
  entryId: number;
};

type EntryEventResultArgs = {
  entryId: number;
  eventId: number;
};

type EntryTransferHistoryArgs = {
  entryId: number;
};

type EntryHistoryPayload = {
  results: EntryEventResult[];
  history: EntryHistoryInfo[];
};

const liveCalcCache = new WeakMap<GraphQLContext, Map<string, Promise<LiveCalcData>>>();

const getLiveCalcData = (
  context: GraphQLContext,
  entryId: number,
  eventId: number
): Promise<LiveCalcData> => {
  let requestCache = liveCalcCache.get(context);
  if (!requestCache) {
    requestCache = new Map<string, Promise<LiveCalcData>>();
    liveCalcCache.set(context, requestCache);
  }

  const cacheKey = `${entryId}:${eventId}`;
  const cached = requestCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const promise = entryLiveCalcService.calcLivePointsByEntry(context, eventId, entryId);
  requestCache.set(cacheKey, promise);
  return promise;
};

const getCaptainMultiplier = (chip: string): number => (chip === 'TRIPLE_CAPTAIN' ? 3 : 2);

export const entriesResolvers = {
  Query: {
    entry: async (
      _parent: unknown,
      args: EntryArgs,
      context: GraphQLContext
    ): Promise<Entry | null> => entriesService.getEntryById(context, args.id),

    entryHistory: async (
      _parent: unknown,
      args: EntryHistoryArgs,
      context: GraphQLContext
    ): Promise<EntryHistoryPayload> => {
      const [results, history] = await Promise.all([
        entriesService.getEntryHistory(context, args.entryId),
        entriesService.getEntryHistoryInfo(context, args.entryId),
      ]);
      return { results, history };
    },

    entryEventResult: async (
      _parent: unknown,
      args: EntryEventResultArgs,
      context: GraphQLContext
    ): Promise<EntryEventResult | null> =>
      entriesService.getEntryEventResult(context, args.entryId, args.eventId),

    entryTransferHistory: async (
      _parent: unknown,
      args: EntryTransferHistoryArgs,
      context: GraphQLContext
    ): Promise<EntryGameweekTransfers[]> =>
      entriesService.getEntryTransferHistory(context, args.entryId),
  },
  EntryEventResult: {
    entry: async (
      parent: EntryEventResult,
      _args: Record<string, never>,
      context: GraphQLContext
    ): Promise<Entry | null> => {
      // Reuse live calc data to avoid a duplicate getEntryById round-trip
      const liveCalc = await getLiveCalcData(context, parent.entryId, parent.eventId);
      return {
        id: liveCalc.entry,
        entryName: liveCalc.entryName,
        playerName: liveCalc.playerName,
        region: liveCalc.region,
        startedEvent: liveCalc.startedEvent,
        overallPoints: liveCalc.overallPoints,
        overallRank: liveCalc.overallRank,
        bank: liveCalc.bank,
        teamValue: liveCalc.teamValue,
        totalTransfers: liveCalc.totalTransfers,
      };
    },
    eventBenchPoints: async (parent: EntryEventResult, _args: Record<string, never>, context: GraphQLContext): Promise<number> => {
      const liveCalc = await getLiveCalcData(context, parent.entryId, parent.eventId);
      return liveCalc.pickList
        .filter((pick) => pick.position > 11)
        .reduce((sum, pick) => sum + pick.totalPoints, 0);
    },
    eventChip: async (parent: EntryEventResult, _args: Record<string, never>, context: GraphQLContext): Promise<string> => {
      const liveCalc = await getLiveCalcData(context, parent.entryId, parent.eventId);
      return liveCalc.chip;
    },
    eventPlayedCaptain: async (
      parent: EntryEventResult,
      _args: Record<string, never>,
      context: GraphQLContext
    ): Promise<Player | null> => {
      const liveCalc = await getLiveCalcData(context, parent.entryId, parent.eventId);
      if (!liveCalc.playedCaptain) {
        return null;
      }
      return getPlayerByIdForEventMemoized(context, liveCalc.playedCaptain, parent.eventId);
    },
    eventCaptainPoints: async (
      parent: EntryEventResult,
      _args: Record<string, never>,
      context: GraphQLContext
    ): Promise<number> => {
      const liveCalc = await getLiveCalcData(context, parent.entryId, parent.eventId);
      const captainPick =
        liveCalc.pickList.find((pick) => pick.element === liveCalc.playedCaptain) ?? null;
      if (!captainPick) {
        return 0;
      }
      return captainPick.totalPoints * getCaptainMultiplier(liveCalc.chip);
    },
    eventPicks: async (
      parent: EntryEventResult,
      _args: Record<string, never>,
      context: GraphQLContext
    ): Promise<ElementEventResultData[]> => {
      const liveCalc = await getLiveCalcData(context, parent.entryId, parent.eventId);
      return liveCalc.pickList;
    },
    eventAutoSub: async (
      parent: EntryEventResult,
      _args: Record<string, never>,
      context: GraphQLContext
    ): Promise<ElementEventResultData[]> => {
      const liveCalc = await getLiveCalcData(context, parent.entryId, parent.eventId);
      return liveCalc.pickList.filter((pick) => pick.autoSub);
    },
  },
};
