import type { GraphQLContext } from '../../graphql/context';
import { entryLiveRepository } from '../entry-live/repository';
import {
  buildTeamMapById,
  enrichTransferRows,
  type EntryEventTransfersData,
} from '../entry-live/transfer-enrichment';
import type { ElementEventResultData } from '../entry-live/calc-service';
import { liveRepository, type LivePerformance } from '../live/repository';
import type { Player, Team } from '../players/repository';
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

const livePerformanceKey = (eventId: number, playerId: number): string => `${eventId}:${playerId}`;

type StoredEntryPick = {
  element: number;
  position: number;
  multiplier: number;
  isCaptain: boolean;
  isViceCaptain: boolean;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const asNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const asBoolean = (value: unknown): boolean | null =>
  typeof value === 'boolean' ? value : null;

const asScaled = (value: number | null | undefined, divisor: number): number =>
  typeof value === 'number' ? value / divisor : 0;

const parseNullableFloat = (value: string | null | undefined): number | null => {
  if (!value) {
    return null;
  }
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const elementTypeName = (player: Player | null): string => {
  if (!player) {
    return '';
  }
  switch (player.position) {
    case 1:
      return 'GKP';
    case 2:
      return 'DEF';
    case 3:
      return 'MID';
    case 4:
      return 'FWD';
    default:
      return '';
  }
};

const mapStoredEntryPick = (raw: unknown): StoredEntryPick | null => {
  if (!isRecord(raw)) {
    return null;
  }

  const element = asNumber(raw.element);
  const position = asNumber(raw.position);
  if (!element || !position) {
    return null;
  }

  return {
    element,
    position,
    multiplier: asNumber(raw.multiplier) ?? 0,
    isCaptain: asBoolean(raw.isCaptain) ?? asBoolean(raw.is_captain) ?? false,
    isViceCaptain: asBoolean(raw.isViceCaptain) ?? asBoolean(raw.is_vice_captain) ?? false,
  };
};

const mapEntryPick = (params: {
  eventId: number;
  pick: StoredEntryPick;
  player: Player | null;
  team: Team | undefined;
  live: LivePerformance | undefined;
}): ElementEventResultData => {
  const { eventId, pick, player, team, live } = params;
  const minutes = live?.minutes ?? 0;
  const yellowCards = live?.yellowCards ?? 0;
  const redCards = live?.redCards ?? 0;

  return {
    season: null,
    event: eventId,
    element: pick.element,
    code: player?.code ?? 0,
    webName: player?.webName ?? '',
    price: asScaled(player?.price, 10),
    elementType: player?.position ?? 0,
    elementTypeName: elementTypeName(player),
    teamId: player?.teamId ?? 0,
    teamCode: team?.code ?? 0,
    teamName: team?.name ?? '',
    teamShortName: team?.shortName ?? '',
    againstId: 0,
    againstName: '',
    againstShortName: 'BLANK',
    wasHome: '',
    score: '',
    position: pick.position,
    multiplier: pick.multiplier,
    isCaptain: pick.isCaptain,
    isViceCaptain: pick.isViceCaptain,
    isGwStarted: true,
    isGwFinished: true,
    isPlayed: minutes > 0 || yellowCards > 0 || redCards > 0,
    playStatus: 4,
    minutes,
    goalsScored: live?.goalsScored ?? 0,
    assists: live?.assists ?? 0,
    cleanSheets: live?.cleanSheets ?? 0,
    goalsConceded: live?.goalsConceded ?? 0,
    defensiveContribution: live?.defensiveContribution ?? 0,
    ownGoals: live?.ownGoals ?? 0,
    penaltiesSaved: live?.penaltiesSaved ?? 0,
    penaltiesMissed: live?.penaltiesMissed ?? 0,
    yellowCards,
    redCards,
    saves: live?.saves ?? 0,
    bonus: live?.bonus ?? 0,
    bps: live?.bps ?? 0,
    totalPoints: live?.totalPoints ?? 0,
    starts: live?.starts ?? null,
    expectedGoals: parseNullableFloat(live?.expectedGoals),
    expectedAssists: parseNullableFloat(live?.expectedAssists),
    expectedGoalInvolvements: parseNullableFloat(live?.expectedGoalInvolvements),
    expectedGoalsConceded: parseNullableFloat(live?.expectedGoalsConceded),
    inDreamTeam: live?.inDreamTeam ?? null,
    pickActive: pick.multiplier > 0,
    autoSub: pick.position > 11 && pick.multiplier > 0,
    bgw: false,
    dgw: false,
  };
};

export const entriesService = {
  getEntryById(context: GraphQLContext, id: number): Promise<Entry | null> {
    return entriesRepository.getEntryById(context, id);
  },

  getEntriesByIds(context: GraphQLContext, ids: number[]): Promise<Map<number, Entry>> {
    return entriesRepository.getEntriesByIds(context, ids);
  },

  getEntriesByIdsFromRedis(context: GraphQLContext, ids: number[]): Promise<Map<number, Entry>> {
    return entriesRepository.getEntriesByIdsFromRedis(context, ids);
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

  async getEntryEventPicks(
    context: GraphQLContext,
    result: EntryEventResult
  ): Promise<ElementEventResultData[]> {
    const picks = result.eventPicks
      .map(mapStoredEntryPick)
      .filter((pick): pick is StoredEntryPick => pick !== null)
      .sort((a, b) => a.position - b.position);
    if (picks.length === 0) {
      return [];
    }

    const playerIds = uniquePositiveIds(picks.map((pick) => pick.element));
    const [players, teams, liveRows] = await Promise.all([
      playersRepository.getPlayersByIds(context, playerIds),
      playersRepository.listTeams(context),
      liveRepository.getLivePerformancesForEventsAndPlayers(context, [result.eventId], playerIds),
    ]);
    const playersById = new Map(players.map((player) => [player.id, player]));
    const teamsById = buildTeamMapById(teams);
    const liveByPlayer = new Map(liveRows.map((row) => [row.playerId, row]));

    return picks.map((pick) => {
      const player = playersById.get(pick.element) ?? null;
      return mapEntryPick({
        eventId: result.eventId,
        pick,
        player,
        team: player ? teamsById.get(player.teamId) : undefined,
        live: liveByPlayer.get(pick.element),
      });
    });
  },

  async getEntryTransferHistory(
    context: GraphQLContext,
    entryId: number
  ): Promise<EntryGameweekTransfers[]> {
    if (!Number.isFinite(entryId) || entryId <= 0) {
      return [];
    }

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
    const liveRows = await liveRepository.getLivePerformancesForEventsAndPlayers(
      context,
      eventIds,
      playerIds
    );
    const liveByEventAndPlayer = new Map<string, LivePerformance>(
      liveRows.map((row) => [livePerformanceKey(row.eventId, row.playerId), row])
    );

    return eventIds.map((eventId): EntryGameweekTransfers => {
      const eventRows = rowsByEvent.get(eventId) ?? [];
      const liveByPlayer = new Map<number, LivePerformance>();
      for (const row of eventRows) {
        const inLive = liveByEventAndPlayer.get(livePerformanceKey(eventId, row.elementIn));
        if (inLive) {
          liveByPlayer.set(row.elementIn, inLive);
        }
        const outLive = liveByEventAndPlayer.get(livePerformanceKey(eventId, row.elementOut));
        if (outLive) {
          liveByPlayer.set(row.elementOut, outLive);
        }
      }

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
    });
  },
};
