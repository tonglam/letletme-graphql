import { describe, expect, it } from 'bun:test';
import type { GraphQLContext } from '../../graphql/context';
import { LeagueType } from '../leagues/repository';
import {
  GroupMode,
  KnockoutMode,
  TournamentMode,
  TournamentState,
  extractTournamentIds,
  mapTournamentEventResult,
  mapTournamentInfo,
  tournamentsRepository,
  type DbTournamentInfoRow,
  type DbTournamentEntryRow,
  type DbTournamentPointsGroupResultRow,
} from './repository';

type QueryAction = { type: string; args: unknown[] };

const filterRowsByActions = (rows: unknown[], actions: QueryAction[]): unknown[] =>
  rows.filter((row) => {
    if (typeof row !== 'object' || row === null) {
      return false;
    }
    const record = row as Record<string, unknown>;
    return actions.every((action) => {
      const column = String(action.args[0] ?? '');
      const value = record[column];
      if (action.type === 'eq') {
        return value === action.args[1];
      }
      if (action.type === 'in') {
        const values = Array.isArray(action.args[1]) ? action.args[1] : [];
        return values.includes(value);
      }
      if (action.type === 'gte') {
        return typeof value === 'number' && typeof action.args[1] === 'number'
          ? value >= action.args[1]
          : true;
      }
      if (action.type === 'lte') {
        return typeof value === 'number' && typeof action.args[1] === 'number'
          ? value <= action.args[1]
          : true;
      }
      return true;
    });
  });

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

describe('mapTournamentEventResult', () => {
  it('maps joined tournament event data with league row priority for names', () => {
    const tournament = mapTournamentInfo({
      id: 11,
      name: 'Mini League Cup',
      creator: 'alice',
      admin_entry_id: 1001,
      league_id: 999,
      league_type: 'classic',
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
      knockout_mode: 'no_knockout',
      knockout_team_num: null,
      knockout_rounds: null,
      knockout_event_num: null,
      knockout_started_event_id: null,
      knockout_ended_event_id: null,
      knockout_play_against_num: null,
      state: 'active',
      created_at: '2026-04-21T00:00:00.000Z',
      updated_at: '2026-04-21T00:00:00.000Z',
    });
    const row: DbTournamentPointsGroupResultRow = {
      tournament_id: 11,
      group_id: 3,
      event_id: 33,
      entry_id: 12345,
      event_group_rank: 2,
      event_points: 81,
      event_cost: 4,
      event_net_points: 77,
      event_rank: 201,
    };

    expect(
      mapTournamentEventResult(
        tournament,
        row,
        {
          league_id: 999,
          league_type: 'classic',
          event_id: 33,
          entry_id: 12345,
          entry_name: 'League Entry',
          player_name: 'League Player',
          overall_points: 1987,
          overall_rank: 10022,
          event_chip: 'freehit',
          captain_id: 430,
          captain_points: 12,
          team_value: 1030,
          bank: 22,
        },
        {
          id: 12345,
          entry_name: 'Fallback Entry',
          player_name: 'Fallback Player',
        }
      )
    ).toEqual({
      tournament,
      eventId: 33,
      groupId: 3,
      entryId: 12345,
      entryName: 'League Entry',
      playerName: 'League Player',
      eventGroupRank: 2,
      eventPoints: 81,
      eventCost: 4,
      eventNetPoints: 77,
      eventRank: 201,
      overallPoints: 1987,
      overallRank: 10022,
      eventChip: 'freehit',
      captainId: 430,
      captainPoints: 12,
      teamValue: 1030,
      bank: 22,
    });
  });

  it('falls back to entry info names when league enrichment names are missing', () => {
    const tournament = mapTournamentInfo({
      id: 11,
      name: 'Mini League Cup',
      creator: 'alice',
      admin_entry_id: 1001,
      league_id: 999,
      league_type: 'classic',
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
      knockout_mode: 'no_knockout',
      knockout_team_num: null,
      knockout_rounds: null,
      knockout_event_num: null,
      knockout_started_event_id: null,
      knockout_ended_event_id: null,
      knockout_play_against_num: null,
      state: 'active',
      created_at: '2026-04-21T00:00:00.000Z',
      updated_at: '2026-04-21T00:00:00.000Z',
    });

    const result = mapTournamentEventResult(
      tournament,
      {
        tournament_id: 11,
        group_id: 1,
        event_id: 33,
        entry_id: 7,
        event_group_rank: 1,
        event_points: 90,
        event_cost: 0,
        event_net_points: 90,
        event_rank: 5,
      },
      {
        league_id: 999,
        league_type: 'classic',
        event_id: 33,
        entry_id: 7,
        entry_name: null,
        player_name: null,
        overall_points: 2000,
        overall_rank: 50,
        event_chip: null,
        captain_id: null,
        captain_points: null,
        team_value: null,
        bank: null,
      },
      {
        id: 7,
        entry_name: 'Fallback Entry',
        player_name: 'Fallback Player',
      }
    );

    expect(result.entryName).toBe('Fallback Entry');
    expect(result.playerName).toBe('Fallback Player');
  });
});

describe('tournamentsRepository.getTournamentEventResults', () => {
  const buildContext = (options: {
    tournamentData?: unknown[];
    tournamentEntriesData?: unknown[];
    pointsData?: unknown[];
    leagueEventData?: unknown[];
    entryInfoData?: unknown[];
    entryEventResultsData?: unknown[];
    tournamentError?: unknown;
    tournamentEntriesError?: unknown;
    pointsError?: unknown;
    leagueEventError?: unknown;
    entryInfoError?: unknown;
    entryEventResultsError?: unknown;
    cacheSeed?: string | null;
  }): GraphQLContext => {
    const redisState = new Map<string, string>();
    if (options.cacheSeed) {
      redisState.set(
        'tournaments:event-results:{"eventId":33,"tournamentId":1}',
        options.cacheSeed
      );
    }

    const queryLog: Array<{ table: string; actions: Array<{ type: string; args: unknown[] }> }> = [];

    const makeBuilder = (table: string) => {
      const actions: Array<{ type: string; args: unknown[] }> = [];
      queryLog.push({ table, actions });

      const builder = {
        select(...args: unknown[]) {
          actions.push({ type: 'select', args });
          return builder;
        },
        eq(...args: unknown[]) {
          actions.push({ type: 'eq', args });
          return builder;
        },
        in(...args: unknown[]) {
          actions.push({ type: 'in', args });
          return builder;
        },
        gte(...args: unknown[]) {
          actions.push({ type: 'gte', args });
          return builder;
        },
        lte(...args: unknown[]) {
          actions.push({ type: 'lte', args });
          return builder;
        },
        order(...args: unknown[]) {
          actions.push({ type: 'order', args });
          return builder;
        },
        async limit(...args: unknown[]) {
          actions.push({ type: 'limit', args });
          if (table === 'tournament_infos') {
            return { data: options.tournamentData ?? [], error: options.tournamentError ?? null };
          }
          return { data: [], error: null };
        },
        then(resolve: (value: unknown) => unknown) {
          let result: { data: unknown[]; error: unknown } = { data: [], error: null };
          if (table === 'tournament_points_group_results') {
            result = { data: options.pointsData ?? [], error: options.pointsError ?? null };
          } else if (table === 'league_event_results') {
            result = {
              data: options.leagueEventData ?? [],
              error: options.leagueEventError ?? null,
            };
          } else if (table === 'entry_infos') {
            result = { data: options.entryInfoData ?? [], error: options.entryInfoError ?? null };
          } else if (table === 'tournament_entries') {
            result = {
              data: filterRowsByActions(options.tournamentEntriesData ?? [], actions),
              error: options.tournamentEntriesError ?? null,
            };
          } else if (table === 'entry_event_results') {
            result = {
              data: filterRowsByActions(options.entryEventResultsData ?? [], actions),
              error: options.entryEventResultsError ?? null,
            };
          } else if (table === 'tournament_infos') {
            result = { data: options.tournamentData ?? [], error: options.tournamentError ?? null };
          }
          return Promise.resolve(result).then(resolve);
        },
      };

      return builder;
    };

    return {
      supabase: {
        from(table: string) {
          return makeBuilder(table);
        },
      } as never,
      redis: {
        async get(key: string) {
          return redisState.get(key) ?? null;
        },
        async set(key: string, value: string) {
          redisState.set(key, value);
          return 'OK';
        },
      } as never,
      logger: {
        error() {
          return undefined;
        },
      } as never,
      user: undefined,
      // Test helpers
      __queryLog: queryLog,
      __redisState: redisState,
    } as GraphQLContext;
  };

  const tournamentRow: DbTournamentInfoRow = {
    id: 1,
    name: 'Tournament 1',
    creator: 'tong',
    admin_entry_id: 15702,
    league_id: 12121,
    league_type: 'classic',
    total_team_num: 3,
    tournament_mode: 'normal',
    group_mode: 'points_races',
    group_team_num: 3,
    group_num: 1,
    group_started_event_id: 1,
    group_ended_event_id: 38,
    group_auto_averages: false,
    group_rounds: null,
    group_play_against_num: null,
    group_qualify_num: null,
    knockout_mode: null,
    knockout_team_num: null,
    knockout_rounds: null,
    knockout_event_num: null,
    knockout_started_event_id: null,
    knockout_ended_event_id: null,
    knockout_play_against_num: null,
    state: 'active',
    created_at: '2026-04-21T00:00:00.000Z',
    updated_at: '2026-04-21T00:00:00.000Z',
  };

  it('returns cached results when available', async () => {
    const cached = [
      {
        tournament: mapTournamentInfo(tournamentRow),
        eventId: 33,
        groupId: 1,
        entryId: 123,
        entryName: 'Cached',
        playerName: 'Cached Player',
        eventGroupRank: 1,
        eventPoints: 90,
        eventCost: 0,
        eventNetPoints: 90,
        eventRank: 10,
        overallPoints: 2000,
        overallRank: 100,
        eventChip: 'bboost',
        captainId: 430,
        captainPoints: 12,
        teamValue: 1030,
        bank: 25,
      },
    ];
    const context = buildContext({ cacheSeed: JSON.stringify(cached) });

    const result = await tournamentsRepository.getTournamentEventResults(context, 1, 33);
    expect(result).toEqual(cached);
  });

  it('throws when the tournament does not exist', async () => {
    const context = buildContext({ tournamentData: [] });
    await expect(tournamentsRepository.getTournamentEventResults(context, 1, 33)).rejects.toThrow(
      'Tournament not found'
    );
  });

  it('throws when the tournament mode is not POINTS_RACES', async () => {
    const context = buildContext({
      tournamentData: [{ ...tournamentRow, group_mode: 'battle_races' }],
    });
    await expect(tournamentsRepository.getTournamentEventResults(context, 1, 33)).rejects.toThrow(
      'Tournament event results currently support POINTS_RACES only'
    );
  });

  it('returns rows ordered by group and event_group_rank and caches the merged result', async () => {
    const context = buildContext({
      tournamentData: [tournamentRow],
      pointsData: [
        {
          tournament_id: 1,
          group_id: 2,
          event_id: 33,
          entry_id: 300,
          event_group_rank: 2,
          event_points: 81,
          event_cost: 4,
          event_net_points: 77,
          event_rank: 201,
        },
        {
          tournament_id: 1,
          group_id: 1,
          event_id: 33,
          entry_id: 100,
          event_group_rank: 1,
          event_points: 98,
          event_cost: 0,
          event_net_points: 98,
          event_rank: 50,
        },
      ],
      leagueEventData: [
        {
          league_id: 12121,
          league_type: 'classic',
          event_id: 33,
          entry_id: 300,
          entry_name: null,
          player_name: null,
          overall_points: 1880,
          overall_rank: 1000,
          event_chip: 'freehit',
          captain_id: 99,
          captain_points: 8,
          team_value: 1025,
          bank: 10,
        },
        {
          league_id: 12121,
          league_type: 'classic',
          event_id: 33,
          entry_id: 100,
          entry_name: 'League Entry 100',
          player_name: 'Manager 100',
          overall_points: 2001,
          overall_rank: 200,
          event_chip: 'bboost',
          captain_id: 430,
          captain_points: 12,
          team_value: 1038,
          bank: 22,
        },
      ],
      entryInfoData: [
        { id: 300, entry_name: 'Fallback Entry 300', player_name: 'Fallback Manager 300' },
        { id: 100, entry_name: 'Fallback Entry 100', player_name: 'Fallback Manager 100' },
      ],
    });

    const result = await tournamentsRepository.getTournamentEventResults(context, 1, 33);

    expect(result).toHaveLength(2);
    expect(result[0].groupId).toBe(1);
    expect(result[0].entryId).toBe(100);
    expect(result[0].entryName).toBe('League Entry 100');
    expect(result[1].groupId).toBe(2);
    expect(result[1].entryId).toBe(300);
    expect(result[1].entryName).toBe('Fallback Entry 300');
    expect(result[1].eventChip).toBe('freehit');

    const cached = await context.redis.get(
      'tournaments:event-results:{"eventId":33,"tournamentId":1}'
    );
    expect(cached).not.toBeNull();
  });
});

describe('tournamentsRepository.getTournamentEntryRankingSummary', () => {
  const buildContext = (options: {
    tournamentData?: unknown[];
    snapshotData?: unknown[];
    tournamentError?: unknown;
    snapshotError?: unknown;
    cacheSeed?: string | null;
  }): GraphQLContext => {
    const redisState = new Map<string, string>();
    if (options.cacheSeed) {
      redisState.set(
        'tournaments:ranking-summary:{"entryId":15702,"eventId":3,"tournamentId":1}',
        options.cacheSeed
      );
    }

    const makeBuilder = (table: string) => {
      const actions: QueryAction[] = [];
      const builder = {
        select(...args: unknown[]) {
          actions.push({ type: 'select', args });
          return builder;
        },
        eq(...args: unknown[]) {
          actions.push({ type: 'eq', args });
          return builder;
        },
        in(...args: unknown[]) {
          actions.push({ type: 'in', args });
          return builder;
        },
        gte(...args: unknown[]) {
          actions.push({ type: 'gte', args });
          return builder;
        },
        lte(...args: unknown[]) {
          actions.push({ type: 'lte', args });
          return builder;
        },
        async limit(...args: unknown[]) {
          actions.push({ type: 'limit', args });
          if (table === 'tournament_infos') {
            return { data: options.tournamentData ?? [], error: options.tournamentError ?? null };
          }
          return { data: [], error: null };
        },
        then(resolve: (value: unknown) => unknown) {
          let result: { data: unknown[]; error: unknown } = { data: [], error: null };
          if (table === 'v_tournament_event_snapshot') {
            result = {
              data: filterRowsByActions(options.snapshotData ?? [], actions),
              error: options.snapshotError ?? null,
            };
          } else if (table === 'tournament_infos') {
            result = { data: options.tournamentData ?? [], error: options.tournamentError ?? null };
          }
          return Promise.resolve(result).then(resolve);
        },
      };

      return builder;
    };

    return {
      supabase: {
        from(table: string) {
          return makeBuilder(table);
        },
      } as never,
      redis: {
        async get(key: string) {
          return redisState.get(key) ?? null;
        },
        async set(key: string, value: string) {
          redisState.set(key, value);
          return 'OK';
        },
      } as never,
      logger: {
        error() {
          return undefined;
        },
      } as never,
      user: undefined,
    } as GraphQLContext;
  };

  const tournamentRow: DbTournamentInfoRow = {
    id: 1,
    name: 'Tournament 1',
    creator: 'tong',
    admin_entry_id: 15702,
    league_id: 12121,
    league_type: 'classic',
    total_team_num: 2,
    tournament_mode: 'normal',
    group_mode: 'points_races',
    group_team_num: 2,
    group_num: 1,
    group_started_event_id: 2,
    group_ended_event_id: 38,
    group_auto_averages: false,
    group_rounds: null,
    group_play_against_num: null,
    group_qualify_num: null,
    knockout_mode: null,
    knockout_team_num: null,
    knockout_rounds: null,
    knockout_event_num: null,
    knockout_started_event_id: null,
    knockout_ended_event_id: null,
    knockout_play_against_num: null,
    state: 'active',
    created_at: '2026-04-21T00:00:00.000Z',
    updated_at: '2026-04-21T00:00:00.000Z',
  };

  it('returns cached summary when available', async () => {
    const cached = {
      eventId: 3,
      entryId: 15702,
      overallRank: 500,
      tournamentOverallRank: 2,
      teamValue: 1020,
      tournamentTeamValueRank: 1,
      transfersNum: 3,
      tournamentTransfersRank: 2,
      totalCosts: 4,
      tournamentCostsRank: 2,
      totalBenchPoints: 20,
      tournamentBenchPointsRank: 1,
      autoSubPoints: 5,
      tournamentAutoSubRank: 1,
    };
    const context = buildContext({ cacheSeed: JSON.stringify(cached) });

    const result = await tournamentsRepository.getTournamentEntryRankingSummary(
      context,
      1,
      3,
      15702
    );

    expect(result).toEqual(cached);
  });

  it('throws for non-points-race tournaments', async () => {
    const context = buildContext({
      tournamentData: [{ ...tournamentRow, group_mode: 'battle_races' }],
    });

    await expect(
      tournamentsRepository.getTournamentEntryRankingSummary(context, 1, 3, 15702)
    ).rejects.toThrow('Tournament ranking summary currently supports POINTS_RACES only');
  });

  it('builds cumulative summary and metric-specific ranks', async () => {
    const context = buildContext({
      tournamentData: [tournamentRow],
      snapshotData: [
        {
          tournament_id: 1,
          event_id: 2,
          entry_id: 15702,
          tournament_overall_rank: 2,
          overall_rank: 1100,
          team_value: 1015,
          cum_transfers_num: 1,
          cum_total_costs: 0,
          cum_total_bench_points: 5,
          cum_auto_sub_points: 3,
          tournament_team_value_rank: 1,
          tournament_transfers_rank: 2,
          tournament_costs_rank: 1,
          tournament_bench_points_rank: 1,
          tournament_auto_sub_rank: 1,
        },
        {
          tournament_id: 1,
          event_id: 3,
          entry_id: 15702,
          tournament_overall_rank: 2,
          overall_rank: 1000,
          team_value: 1020,
          cum_transfers_num: 3,
          cum_total_costs: 4,
          cum_total_bench_points: 11,
          cum_auto_sub_points: 7,
          tournament_team_value_rank: 1,
          tournament_transfers_rank: 2,
          tournament_costs_rank: 2,
          tournament_bench_points_rank: 1,
          tournament_auto_sub_rank: 1,
        },
      ],
    });

    const result = await tournamentsRepository.getTournamentEntryRankingSummary(
      context,
      1,
      3,
      15702
    );

    expect(result.overallRank).toBe(1000);
    expect(result.tournamentOverallRank).toBe(2);
    expect(result.teamValue).toBe(1020);
    expect(result.tournamentTeamValueRank).toBe(1);
    expect(result.transfersNum).toBe(3);
    expect(result.tournamentTransfersRank).toBe(2);
    expect(result.totalCosts).toBe(4);
    expect(result.tournamentCostsRank).toBe(2);
    expect(result.totalBenchPoints).toBe(11);
    expect(result.tournamentBenchPointsRank).toBe(1);
    expect(result.autoSubPoints).toBe(7);
    expect(result.tournamentAutoSubRank).toBe(1);
  });

  it('returns null ranks and zero cumulative metrics when snapshot row is missing', async () => {
    const context = buildContext({
      tournamentData: [tournamentRow],
      snapshotData: [],
    });

    const result = await tournamentsRepository.getTournamentEntryRankingSummary(
      context,
      1,
      3,
      15702
    );

    expect(result.overallRank).toBeNull();
    expect(result.tournamentOverallRank).toBeNull();
    expect(result.teamValue).toBeNull();
    expect(result.tournamentTeamValueRank).toBeNull();
    expect(result.transfersNum).toBe(0);
    expect(result.tournamentTransfersRank).toBeNull();
    expect(result.totalCosts).toBe(0);
    expect(result.tournamentCostsRank).toBeNull();
    expect(result.totalBenchPoints).toBe(0);
    expect(result.tournamentBenchPointsRank).toBeNull();
    expect(result.autoSubPoints).toBe(0);
    expect(result.tournamentAutoSubRank).toBeNull();
  });
});
