import { describe, expect, it } from 'bun:test';
import type { GraphQLContext } from '../../graphql/context';
import { LeagueType } from '../leagues/repository';
import { tournamentsRepository, TournamentMode, TournamentState } from './repository';
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
