import { describe, expect, it } from 'bun:test';
import type { GraphQLContext } from '../../graphql/context';
import { LeagueType } from '../leagues/repository';
import {
  tournamentsRepository,
  type TournamentEntryRankingSummary,
  TournamentMode,
  TournamentState,
  type TournamentEventResult,
} from './repository';
import { tournamentsService } from './service';

describe('tournamentsService.getEntryTournaments', () => {
  it('delegates to tournamentsRepository with the same args', async () => {
    const original = tournamentsRepository.getEntryTournaments;
    const context = {} as unknown as GraphQLContext;
    const expected = [
      {
        id: 1,
        name: 'T1',
        creator: 'alice',
        adminEntryId: 10,
        leagueId: 20,
        leagueType: LeagueType.CLASSIC,
        totalTeamNum: 8,
        tournamentMode: TournamentMode.NORMAL,
        groupMode: null,
        groupTeamNum: null,
        groupNum: null,
        groupStartedEventId: null,
        groupEndedEventId: null,
        groupAutoAverages: false,
        groupRounds: null,
        groupPlayAgainstNum: null,
        groupQualifyNum: null,
        knockoutMode: null,
        knockoutTeamNum: null,
        knockoutRounds: null,
        knockoutEventNum: null,
        knockoutStartedEventId: null,
        knockoutEndedEventId: null,
        knockoutPlayAgainstNum: null,
        state: TournamentState.ACTIVE,
        createdAt: '2026-04-21T00:00:00.000Z',
        updatedAt: '2026-04-21T00:00:00.000Z',
      },
    ];

    let capturedEntryId = -1;
    tournamentsRepository.getEntryTournaments = async (
      inputContext: GraphQLContext,
      entryId: number
    ): Promise<typeof expected> => {
      expect(inputContext).toBe(context);
      capturedEntryId = entryId;
      return expected;
    };

    try {
      const result = await tournamentsService.getEntryTournaments(context, 12345);
      expect(capturedEntryId).toBe(12345);
      expect(result).toEqual(expected);
    } finally {
      tournamentsRepository.getEntryTournaments = original;
    }
  });
});

describe('tournamentsService.getTournamentEventResults', () => {
  it('delegates to tournamentsRepository with the same args', async () => {
    const original = tournamentsRepository.getTournamentEventResults;
    const context = {} as unknown as GraphQLContext;
    const tournament = {
      id: 1,
      name: 'T1',
      creator: 'alice',
      adminEntryId: 10,
      leagueId: 20,
      leagueType: LeagueType.CLASSIC,
      totalTeamNum: 8,
      tournamentMode: TournamentMode.NORMAL,
      groupMode: null,
      groupTeamNum: null,
      groupNum: null,
      groupStartedEventId: null,
      groupEndedEventId: null,
      groupAutoAverages: false,
      groupRounds: null,
      groupPlayAgainstNum: null,
      groupQualifyNum: null,
      knockoutMode: null,
      knockoutTeamNum: null,
      knockoutRounds: null,
      knockoutEventNum: null,
      knockoutStartedEventId: null,
      knockoutEndedEventId: null,
      knockoutPlayAgainstNum: null,
      state: TournamentState.ACTIVE,
      createdAt: '2026-04-21T00:00:00.000Z',
      updatedAt: '2026-04-21T00:00:00.000Z',
    };
    const expected: TournamentEventResult[] = [
      {
        tournament,
        eventId: 33,
        groupId: 1,
        entryId: 123,
        entryName: 'Entry',
        playerName: 'Player',
        eventGroupRank: 1,
        eventPoints: 90,
        eventCost: 0,
        eventNetPoints: 90,
        eventRank: 10,
        overallPoints: 1900,
        overallRank: 100,
        eventChip: 'bboost',
        captainId: 430,
        captainPoints: 12,
        teamValue: 1030,
        bank: 25,
      },
    ];

    let capturedTournamentId = -1;
    let capturedEventId = -1;
    tournamentsRepository.getTournamentEventResults = async (
      inputContext: GraphQLContext,
      tournamentId: number,
      eventId: number
    ): Promise<TournamentEventResult[]> => {
      expect(inputContext).toBe(context);
      capturedTournamentId = tournamentId;
      capturedEventId = eventId;
      return expected;
    };

    try {
      const result = await tournamentsService.getTournamentEventResults(context, 1, 33);
      expect(capturedTournamentId).toBe(1);
      expect(capturedEventId).toBe(33);
      expect(result).toEqual(expected);
    } finally {
      tournamentsRepository.getTournamentEventResults = original;
    }
  });
});

describe('tournamentsService.getTournamentEntryRankingSummary', () => {
  it('delegates to tournamentsRepository with the same args', async () => {
    const original = tournamentsRepository.getTournamentEntryRankingSummary;
    const context = {} as unknown as GraphQLContext;
    const expected: TournamentEntryRankingSummary = {
      eventId: 33,
      entryId: 123,
      overallRank: 100,
      tournamentOverallRank: 1,
      teamValue: 1030,
      tournamentTeamValueRank: 2,
      transfersNum: 4,
      tournamentTransfersRank: 3,
      totalCosts: 8,
      tournamentCostsRank: 4,
      totalBenchPoints: 22,
      tournamentBenchPointsRank: 1,
      autoSubPoints: 10,
      tournamentAutoSubRank: 2,
    };

    let capturedTournamentId = -1;
    let capturedEventId = -1;
    let capturedEntryId = -1;
    tournamentsRepository.getTournamentEntryRankingSummary = async (
      inputContext: GraphQLContext,
      tournamentId: number,
      eventId: number,
      entryId: number
    ): Promise<TournamentEntryRankingSummary> => {
      expect(inputContext).toBe(context);
      capturedTournamentId = tournamentId;
      capturedEventId = eventId;
      capturedEntryId = entryId;
      return expected;
    };

    try {
      const result = await tournamentsService.getTournamentEntryRankingSummary(
        context,
        1,
        33,
        123
      );
      expect(capturedTournamentId).toBe(1);
      expect(capturedEventId).toBe(33);
      expect(capturedEntryId).toBe(123);
      expect(result).toEqual(expected);
    } finally {
      tournamentsRepository.getTournamentEntryRankingSummary = original;
    }
  });
});
