import { describe, expect, it } from 'bun:test';
import { LeagueType } from '../leagues/repository';
import {
  GroupMode,
  KnockoutMode,
  TournamentMode,
  TournamentState,
  extractTournamentIds,
  mapTournamentInfo,
  type DbTournamentInfoRow,
  type DbTournamentEntryRow,
} from './repository';

describe('extractTournamentIds', () => {
  it('returns an empty array for empty input', () => {
    expect(extractTournamentIds([])).toEqual([]);
  });

  it('deduplicates tournament ids while preserving first-seen order', () => {
    const rows: DbTournamentEntryRow[] = [
      { tournament_id: 5 },
      { tournament_id: 7 },
      { tournament_id: 5 },
      { tournament_id: 9 },
      { tournament_id: 7 },
    ];

    expect(extractTournamentIds(rows)).toEqual([5, 7, 9]);
  });
});

describe('mapTournamentInfo', () => {
  it('maps a tournament info row to domain model', () => {
    const row: DbTournamentInfoRow = {
      id: 11,
      name: 'Mini League Cup',
      creator: 'alice',
      admin_entry_id: 1001,
      league_id: 999,
      league_type: 'h2h',
      total_team_num: 32,
      tournament_mode: 'normal',
      group_mode: 'points_races',
      group_team_num: 4,
      group_num: 8,
      group_started_event_id: 1,
      group_ended_event_id: 8,
      group_auto_averages: true,
      group_rounds: 2,
      group_play_against_num: 1,
      group_qualify_num: 2,
      knockout_mode: 'single_elimination',
      knockout_team_num: 16,
      knockout_rounds: 4,
      knockout_event_num: 4,
      knockout_started_event_id: 9,
      knockout_ended_event_id: 12,
      knockout_play_against_num: 1,
      state: 'active',
      created_at: '2026-04-21T00:00:00.000Z',
      updated_at: '2026-04-21T00:00:00.000Z',
    };

    expect(mapTournamentInfo(row)).toEqual({
      id: 11,
      name: 'Mini League Cup',
      creator: 'alice',
      adminEntryId: 1001,
      leagueId: 999,
      leagueType: LeagueType.H2H,
      totalTeamNum: 32,
      tournamentMode: TournamentMode.NORMAL,
      groupMode: GroupMode.POINTS_RACES,
      groupTeamNum: 4,
      groupNum: 8,
      groupStartedEventId: 1,
      groupEndedEventId: 8,
      groupAutoAverages: true,
      groupRounds: 2,
      groupPlayAgainstNum: 1,
      groupQualifyNum: 2,
      knockoutMode: KnockoutMode.SINGLE_ELIMINATION,
      knockoutTeamNum: 16,
      knockoutRounds: 4,
      knockoutEventNum: 4,
      knockoutStartedEventId: 9,
      knockoutEndedEventId: 12,
      knockoutPlayAgainstNum: 1,
      state: TournamentState.ACTIVE,
      createdAt: '2026-04-21T00:00:00.000Z',
      updatedAt: '2026-04-21T00:00:00.000Z',
    });
  });
});
