import { describe, expect, it } from 'bun:test';
import type { GraphQLContext } from '../../../src/graphql/context';
import { entryLiveRepository, type EntryEventTransferRow } from '../../../src/domains/entry-live/repository';
import { entriesRepository, type EntryEventResult } from '../../../src/domains/entries/repository';
import { entriesService } from '../../../src/domains/entries/service';
import { liveRepository, type LivePerformance } from '../../../src/domains/live/repository';
import { playersRepository, Position, type Player, type Team } from '../../../src/domains/players/repository';

const context = {} as unknown as GraphQLContext;

const makePlayer = (id: number, webName: string, teamId: number, position: Position): Player => ({
  id,
  code: id,
  webName,
  firstName: webName,
  secondName: null,
  teamId,
  position,
  price: 75,
  startPrice: 70,
  totalPoints: 100,
  selectedByPercent: 12.5,
});

const makeTeam = (id: number, name: string, shortName: string): Team => ({
  id,
  code: id,
  name,
  shortName,
  strength: 3,
  position: 1,
  points: 0,
  played: 0,
  win: 0,
  draw: 0,
  loss: 0,
  form: null,
  strengthOverallHome: 0,
  strengthOverallAway: 0,
  strengthAttackHome: 0,
  strengthAttackAway: 0,
  strengthDefenceHome: 0,
  strengthDefenceAway: 0,
});

const makeLivePerformance = (
  eventId: number,
  playerId: number,
  totalPoints: number,
  minutes: number
): LivePerformance => ({
  eventId,
  playerId,
  minutes,
  goalsScored: 0,
  assists: 0,
  cleanSheets: 0,
  goalsConceded: 0,
  ownGoals: 0,
  penaltiesSaved: 0,
  penaltiesMissed: 0,
  yellowCards: 0,
  redCards: 0,
  saves: 0,
  bonus: 0,
  bps: 0,
  starts: null,
  defensiveContribution: null,
  expectedGoals: null,
  expectedAssists: null,
  expectedGoalInvolvements: null,
  expectedGoalsConceded: null,
  inDreamTeam: null,
  totalPoints,
});

describe('entriesService.getEntryTransferHistory', () => {
  it('builds historical transfer rows from bulk event_lives data', async () => {
    const originalGetEntryTransferHistory = entryLiveRepository.getEntryTransferHistory;
    const originalGetEntryHistory = entriesRepository.getEntryHistory;
    const originalListTeams = playersRepository.listTeams;
    const originalGetPlayersByIds = playersRepository.getPlayersByIds;
    const originalGetLivePerformancesForEventsAndPlayers =
      liveRepository.getLivePerformancesForEventsAndPlayers;

    const transferRows: EntryEventTransferRow[] = [
      { entryId: 84885, eventId: 12, elementIn: 1, elementOut: 2, time: '2026-01-01T00:00:00Z' },
    ];
    const eventResults: EntryEventResult[] = [
      {
        entryId: 84885,
        eventId: 12,
        eventPoints: 70,
        eventRank: 1000,
        overallPoints: 900,
        overallRank: 2000,
        eventTransfers: 1,
        eventTransfersCost: 4,
        eventNetPoints: 66,
        eventBenchPoints: 5,
        eventChip: null,
        eventPlayedCaptain: null,
        eventCaptainPoints: 0,
        eventPicks: [],
        teamValue: 1000,
        bank: 10,
      },
    ];

    entryLiveRepository.getEntryTransferHistory = async (): Promise<EntryEventTransferRow[]> =>
      transferRows;
    entriesRepository.getEntryHistory = async (): Promise<EntryEventResult[]> => eventResults;
    playersRepository.listTeams = async (): Promise<Team[]> => [
      makeTeam(1, 'Arsenal', 'ARS'),
      makeTeam(2, 'Liverpool', 'LIV'),
    ];
    playersRepository.getPlayersByIds = async (
      _context: GraphQLContext,
      ids: number[]
    ): Promise<Player[]> => {
      expect(ids.sort((a, b) => a - b)).toEqual([1, 2]);
      return [
        makePlayer(1, 'Saka', 1, Position.MIDFIELDER),
        makePlayer(2, 'Salah', 2, Position.MIDFIELDER),
      ];
    };
    liveRepository.getLivePerformancesForEventsAndPlayers = async (
      _context: GraphQLContext,
      eventIds: number[],
      playerIds: number[]
    ): Promise<LivePerformance[]> => {
      expect(eventIds).toEqual([12]);
      expect(playerIds.sort((a, b) => a - b)).toEqual([1, 2]);
      return [makeLivePerformance(12, 1, 8, 90), makeLivePerformance(12, 2, 2, 0)];
    };

    try {
      const result = await entriesService.getEntryTransferHistory(context, 84885);
      expect(result).toHaveLength(1);
      expect(result[0].eventTransfers).toBe(1);
      expect(result[0].eventTransfersCost).toBe(4);
      expect(result[0].transfers[0]).toMatchObject({
        event: 12,
        elementInWebName: 'Saka',
        elementInTeamShortName: 'ARS',
        elementInPoints: 8,
        elementInPlayed: true,
        elementOutWebName: 'Salah',
        elementOutTeamShortName: 'LIV',
        elementOutPoints: 2,
      });
    } finally {
      entryLiveRepository.getEntryTransferHistory = originalGetEntryTransferHistory;
      entriesRepository.getEntryHistory = originalGetEntryHistory;
      playersRepository.listTeams = originalListTeams;
      playersRepository.getPlayersByIds = originalGetPlayersByIds;
      liveRepository.getLivePerformancesForEventsAndPlayers =
        originalGetLivePerformancesForEventsAndPlayers;
    }
  });
});

describe('entriesService.getEntryEventPicks', () => {
  it('enriches stored compact picks from players, teams, and event_lives', async () => {
    const originalListTeams = playersRepository.listTeams;
    const originalGetPlayersByIds = playersRepository.getPlayersByIds;
    const originalGetLivePerformancesForEventsAndPlayers =
      liveRepository.getLivePerformancesForEventsAndPlayers;

    const eventResult: EntryEventResult = {
      entryId: 84885,
      eventId: 34,
      eventPoints: 65,
      eventRank: 1000,
      overallPoints: 1900,
      overallRank: 2000,
      eventTransfers: 1,
      eventTransfersCost: 0,
      eventNetPoints: 65,
      eventBenchPoints: 6,
      eventChip: null,
      eventPlayedCaptain: 449,
      eventCaptainPoints: 20,
      eventPicks: [
        { element: 449, position: 7, multiplier: 2, is_captain: true, is_vice_captain: false },
        { element: 470, position: 12, multiplier: 0, is_captain: false, is_vice_captain: false },
      ],
      teamValue: 1020,
      bank: 5,
    };

    playersRepository.listTeams = async (): Promise<Team[]> => [makeTeam(1, 'Arsenal', 'ARS')];
    playersRepository.getPlayersByIds = async (
      _context: GraphQLContext,
      ids: number[]
    ): Promise<Player[]> => {
      expect(ids.sort((a, b) => a - b)).toEqual([449, 470]);
      return [
        makePlayer(449, 'Gyokeres', 1, Position.FORWARD),
        makePlayer(470, 'Dubravka', 1, Position.GOALKEEPER),
      ];
    };
    liveRepository.getLivePerformancesForEventsAndPlayers = async (
      _context: GraphQLContext,
      eventIds: number[],
      playerIds: number[]
    ): Promise<LivePerformance[]> => {
      expect(eventIds).toEqual([34]);
      expect(playerIds.sort((a, b) => a - b)).toEqual([449, 470]);
      return [makeLivePerformance(34, 449, 10, 90), makeLivePerformance(34, 470, 2, 0)];
    };

    try {
      const result = await entriesService.getEntryEventPicks(context, eventResult);
      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({
        webName: 'Gyokeres',
        teamShortName: 'ARS',
        teamName: 'Arsenal',
        elementTypeName: 'FWD',
        isCaptain: true,
        isViceCaptain: false,
        multiplier: 2,
        totalPoints: 10,
        minutes: 90,
        position: 7,
      });
      expect(result[1]).toMatchObject({
        webName: 'Dubravka',
        elementTypeName: 'GKP',
        totalPoints: 2,
        minutes: 0,
        position: 12,
      });
    } finally {
      playersRepository.listTeams = originalListTeams;
      playersRepository.getPlayersByIds = originalGetPlayersByIds;
      liveRepository.getLivePerformancesForEventsAndPlayers =
        originalGetLivePerformancesForEventsAndPlayers;
    }
  });
});
