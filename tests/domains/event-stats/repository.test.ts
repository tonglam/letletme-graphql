import { describe, expect, it } from 'bun:test';
import { eventStatsRepository } from '../../../src/domains/event-stats/repository';
import type { TournamentSelectionStats } from '../../../src/domains/event-stats/repository';

const makeMockRedis = (options: {
  strings?: Record<string, string>;
}) => {
  const strings = new Map(Object.entries(options.strings ?? {}));

  return {
    get: async (key: string): Promise<string | null> => strings.get(key) ?? null,
    set: async (key: string, value: string, ..._args: unknown[]): Promise<string> => {
      strings.set(key, value);
      return 'OK';
    },
    hgetall: async (): Promise<Record<string, string>> => ({}),
    hget: async (): Promise<string | null> => null,
    hset: async (): Promise<number> => 1,
    expire: async (): Promise<number> => 1,
  };
};

const makeMockSupabase = (options: {
  fromData?: Record<string, unknown[]>;
  rpcResults?: Record<string, unknown[]>;
  error?: unknown;
}) => ({
  from: (table: string) => {
    const rows = options.fromData?.[table] ?? [];
    const builder = {
      select: () => builder,
      eq: () => builder,
      in: () => builder,
      limit: async () => ({ data: rows, error: options.error ?? null }),
      order: () => builder,
      then: (resolve: (value: unknown) => unknown) =>
        resolve({ data: rows, error: options.error ?? null }),
    };
    return builder;
  },
  rpc: async (fnName: string, _params: Record<string, unknown>) => ({
    data: options.rpcResults?.[fnName] ?? null,
    error: options.error ?? null,
  }),
});

const makeMockLogger = () => ({
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
});

const buildContext = (options: {
  redisStrings?: Record<string, string>;
  fromData?: Record<string, unknown[]>;
  rpcResults?: Record<string, unknown[]>;
  supabaseError?: unknown;
}) => ({
  redis: makeMockRedis({ strings: options.redisStrings }),
  supabase: makeMockSupabase({
    fromData: options.fromData,
    rpcResults: options.rpcResults,
    error: options.supabaseError,
  }),
  logger: makeMockLogger(),
  user: undefined,
}) as never;

const TOURNAMENT_ID = 1;
const EVENT_ID = 10;
const LEAGUE_ID = 100;
const LIMIT = 10;

const makeTournamentInfo = () => ({
  league_id: LEAGUE_ID,
  league_type: 'classic',
});

const makeEntryIds = () => [
  { entry_id: 1001 }, { entry_id: 1002 }, { entry_id: 1003 },
  { entry_id: 1004 }, { entry_id: 1005 },
];

const makeCaptainCounts = () => [
  { captain_id: 3, count: 3, total_entries: 5 },
  { captain_id: 4, count: 2, total_entries: 5 },
];

const makePickAggregation = () => [
  { element_id: 1, pick_count: 5, vice_captain_count: 0 },
  { element_id: 2, pick_count: 3, vice_captain_count: 0 },
  { element_id: 3, pick_count: 4, vice_captain_count: 2 },
  { element_id: 4, pick_count: 4, vice_captain_count: 1 },
];

const makeTransferAggregation = () => [
  { element_id: 3, transfer_in_count: 5, transfer_out_count: 1 },
  { element_id: 4, transfer_in_count: 3, transfer_out_count: 2 },
];

const makePlayers = () => [
  { id: 1, web_name: 'Player1', team_id: 1, type: 1 },
  { id: 2, web_name: 'Player2', team_id: 1, type: 2 },
  { id: 3, web_name: 'Player3', team_id: 2, type: 3 },
  { id: 4, web_name: 'Player4', team_id: 2, type: 4 },
];

const makeTeams = () => [
  { id: 1, short_name: 'TA' },
  { id: 2, short_name: 'TB' },
];

describe('eventStatsRepository.getTournamentSelectionStats', () => {
  it('returns null for invalid tournamentId (zero)', async () => {
    const context = buildContext({});
    const result = await eventStatsRepository.getTournamentSelectionStats(context, 0, EVENT_ID, LIMIT);
    expect(result).toBeNull();
  });

  it('returns null for invalid tournamentId (negative)', async () => {
    const context = buildContext({});
    const result = await eventStatsRepository.getTournamentSelectionStats(context, -1, EVENT_ID, LIMIT);
    expect(result).toBeNull();
  });

  it('returns null for invalid eventId (zero)', async () => {
    const context = buildContext({});
    const result = await eventStatsRepository.getTournamentSelectionStats(context, TOURNAMENT_ID, 0, LIMIT);
    expect(result).toBeNull();
  });

  it('returns null for invalid eventId (negative)', async () => {
    const context = buildContext({});
    const result = await eventStatsRepository.getTournamentSelectionStats(context, TOURNAMENT_ID, -5, LIMIT);
    expect(result).toBeNull();
  });

  it('returns cached result on cache hit', async () => {
    const cachedResult: TournamentSelectionStats = {
      eventId: EVENT_ID,
      tournamentId: TOURNAMENT_ID,
      totalEntries: 5,
      goalkeepers: [],
      defenders: [],
      midfielders: [],
      forwards: [],
      captainSelect: [],
      viceCaptainSelect: [],
      mostSelectedPlayers: [],
      mostTransferIn: [],
      mostTransferOut: [],
    };

    const context = buildContext({
      redisStrings: {
        [`tournament-selection-stats:${TOURNAMENT_ID}:${EVENT_ID}:${LIMIT}`]: JSON.stringify(cachedResult),
      },
    });

    const result = await eventStatsRepository.getTournamentSelectionStats(context, TOURNAMENT_ID, EVENT_ID, LIMIT);
    expect(result).toEqual(cachedResult);
  });

  it('returns null when tournament info not found', async () => {
    const context = buildContext({
      fromData: {
        tournament_infos: [],
      },
    });

    const result = await eventStatsRepository.getTournamentSelectionStats(context, TOURNAMENT_ID, EVENT_ID, LIMIT);
    expect(result).toBeNull();
  });

  it('returns null when no entries and no captain results', async () => {
    const context = buildContext({
      fromData: {
        tournament_infos: [makeTournamentInfo()],
        tournament_entries: [],
      },
      rpcResults: {
        get_captain_counts: [],
      },
    });

    const result = await eventStatsRepository.getTournamentSelectionStats(context, TOURNAMENT_ID, EVENT_ID, LIMIT);
    expect(result).toBeNull();
  });

  it('computes full stats from RPC data on cache miss', async () => {
    const context = buildContext({
      fromData: {
        tournament_infos: [makeTournamentInfo()],
        tournament_entries: makeEntryIds(),
        players: makePlayers(),
        teams: makeTeams(),
      },
      rpcResults: {
        get_captain_counts: makeCaptainCounts(),
        get_pick_aggregation: makePickAggregation(),
        get_transfer_aggregation: makeTransferAggregation(),
      },
    });

    const result = await eventStatsRepository.getTournamentSelectionStats(context, TOURNAMENT_ID, EVENT_ID, LIMIT);
    expect(result).not.toBeNull();

    expect(result!.eventId).toBe(EVENT_ID);
    expect(result!.tournamentId).toBe(TOURNAMENT_ID);
    expect(result!.totalEntries).toBe(5);

    expect(result!.goalkeepers).toHaveLength(1);
    expect(result!.goalkeepers[0].id).toBe(1);
    expect(result!.goalkeepers[0].webName).toBe('Player1');
    expect(result!.goalkeepers[0].teamShortName).toBe('TA');
    expect(result!.goalkeepers[0].position).toBe('GOALKEEPER');
    expect(result!.goalkeepers[0].selectedByPercent).toBe(100);

    expect(result!.defenders).toHaveLength(1);
    expect(result!.defenders[0].id).toBe(2);
    expect(result!.defenders[0].position).toBe('DEFENDER');
    expect(result!.defenders[0].selectedByPercent).toBe(60);

    expect(result!.midfielders).toHaveLength(1);
    expect(result!.midfielders[0].id).toBe(3);
    expect(result!.midfielders[0].position).toBe('MIDFIELDER');
    expect(result!.midfielders[0].selectedByPercent).toBe(80);

    expect(result!.forwards).toHaveLength(1);
    expect(result!.forwards[0].id).toBe(4);
    expect(result!.forwards[0].position).toBe('FORWARD');
    expect(result!.forwards[0].selectedByPercent).toBe(80);

    expect(result!.captainSelect).toHaveLength(2);
    expect(result!.captainSelect[0].id).toBe(3);
    expect(result!.captainSelect[0].captainByPercent).toBe(60);
    expect(result!.captainSelect[1].id).toBe(4);
    expect(result!.captainSelect[1].captainByPercent).toBe(40);

    expect(result!.viceCaptainSelect).toHaveLength(2);
    expect(result!.viceCaptainSelect[0].id).toBe(3);
    expect(result!.viceCaptainSelect[0].captainByPercent).toBe(40);
    expect(result!.viceCaptainSelect[1].id).toBe(4);
    expect(result!.viceCaptainSelect[1].captainByPercent).toBe(20);

    expect(result!.mostSelectedPlayers[0].id).toBe(1);
    expect(result!.mostSelectedPlayers[0].selectedByPercent).toBe(100);

    expect(result!.mostTransferIn).toHaveLength(2);
    expect(result!.mostTransferIn[0].id).toBe(3);
    expect(result!.mostTransferIn[0].transfersEvent).toBe(5);

    expect(result!.mostTransferOut).toHaveLength(2);
    expect(result!.mostTransferOut[0].id).toBe(4);
    expect(result!.mostTransferOut[0].transfersEvent).toBe(2);
  });

  it('computes eoByPercent (selected + captain)', async () => {
    const context = buildContext({
      fromData: {
        tournament_infos: [makeTournamentInfo()],
        tournament_entries: makeEntryIds(),
        players: makePlayers(),
        teams: makeTeams(),
      },
      rpcResults: {
        get_captain_counts: makeCaptainCounts(),
        get_pick_aggregation: makePickAggregation(),
        get_transfer_aggregation: makeTransferAggregation(),
      },
    });

    const result = await eventStatsRepository.getTournamentSelectionStats(context, TOURNAMENT_ID, EVENT_ID, LIMIT);
    expect(result).not.toBeNull();

    const mid3 = result!.midfielders[0];
    expect(mid3.id).toBe(3);
    expect(mid3.selectedByPercent).toBe(80);
    expect(mid3.eoByPercent).toBe(140);

    const fwd4 = result!.forwards[0];
    expect(fwd4.id).toBe(4);
    expect(fwd4.selectedByPercent).toBe(80);
    expect(fwd4.eoByPercent).toBe(120);

    const gk1 = result!.goalkeepers[0];
    expect(gk1.selectedByPercent).toBe(100);
    expect(gk1.eoByPercent).toBe(100);
  });

  it('caches the result after computing', async () => {
    const strings = new Map<string, string>();
    const context = {
      redis: {
        get: async (key: string): Promise<string | null> => strings.get(key) ?? null,
        set: async (key: string, value: string, ..._args: unknown[]): Promise<string> => {
          strings.set(key, value);
          return 'OK';
        },
        hgetall: async () => ({}),
        hget: async () => null,
        hset: async () => 1,
        expire: async () => 1,
      },
      supabase: makeMockSupabase({
        fromData: {
          tournament_infos: [makeTournamentInfo()],
          tournament_entries: makeEntryIds(),
          players: makePlayers(),
          teams: makeTeams(),
        },
        rpcResults: {
          get_captain_counts: makeCaptainCounts(),
          get_pick_aggregation: makePickAggregation(),
          get_transfer_aggregation: makeTransferAggregation(),
        },
      }),
      logger: makeMockLogger(),
      user: undefined,
    } as never;

    const result1 = await eventStatsRepository.getTournamentSelectionStats(context, TOURNAMENT_ID, EVENT_ID, LIMIT);
    expect(result1).not.toBeNull();

    const cacheKey = `tournament-selection-stats:${TOURNAMENT_ID}:${EVENT_ID}:${LIMIT}`;
    expect(strings.has(cacheKey)).toBe(true);

    const cached = JSON.parse(strings.get(cacheKey)!) as TournamentSelectionStats;
    expect(cached.totalEntries).toBe(5);
    expect(cached.goalkeepers).toHaveLength(1);
  });

  it('uses player/team cache on second call', async () => {
    let rpcCallCount = 0;
    let fromCallCount = 0;

    const context = {
      redis: {
        get: async (_key: string): Promise<string | null> => null,
        set: async (_key: string, _value: string, ..._args: unknown[]): Promise<string> => 'OK',
        hgetall: async () => ({}),
        hget: async () => null,
        hset: async () => 1,
        expire: async () => 1,
      },
      supabase: {
        from: (table: string) => {
          fromCallCount++;
          const tableData: Record<string, unknown[]> = {
            tournament_infos: [makeTournamentInfo()],
            tournament_entries: makeEntryIds(),
            players: makePlayers(),
            teams: makeTeams(),
          };
          const rows = tableData[table] ?? [];
          const builder = {
            select: () => builder,
            eq: () => builder,
            in: () => builder,
            limit: async () => ({ data: rows, error: null }),
            order: () => builder,
            then: (resolve: (value: unknown) => unknown) =>
              resolve({ data: rows, error: null }),
          };
          return builder;
        },
        rpc: async (fnName: string, _params: Record<string, unknown>) => {
          rpcCallCount++;
          const rpcData: Record<string, unknown[]> = {
            get_captain_counts: makeCaptainCounts(),
            get_pick_aggregation: makePickAggregation(),
            get_transfer_aggregation: makeTransferAggregation(),
          };
          return { data: rpcData[fnName] ?? null, error: null };
        },
      },
      logger: makeMockLogger(),
      user: undefined,
    } as never;

    await eventStatsRepository.getTournamentSelectionStats(context, TOURNAMENT_ID, EVENT_ID, LIMIT);
    const firstRpcCount = rpcCallCount;
    const firstFromCount = fromCallCount;

    expect(firstRpcCount).toBe(3);
    expect(firstFromCount).toBeGreaterThanOrEqual(3);
  });

  it('handles RPC error gracefully for captain counts', async () => {
    const context = buildContext({
      fromData: {
        tournament_infos: [makeTournamentInfo()],
        tournament_entries: makeEntryIds(),
        players: makePlayers(),
        teams: makeTeams(),
      },
      rpcResults: {
        get_captain_counts: [],
        get_pick_aggregation: makePickAggregation(),
        get_transfer_aggregation: makeTransferAggregation(),
      },
    });

    const result = await eventStatsRepository.getTournamentSelectionStats(context, TOURNAMENT_ID, EVENT_ID, LIMIT);
    expect(result).not.toBeNull();
    expect(result!.captainSelect).toHaveLength(0);
    expect(result!.viceCaptainSelect).toHaveLength(2);
    expect(result!.totalEntries).toBe(5);
  });

  it('handles empty pick and transfer data', async () => {
    const context = buildContext({
      fromData: {
        tournament_infos: [makeTournamentInfo()],
        tournament_entries: makeEntryIds(),
        players: makePlayers(),
        teams: makeTeams(),
      },
      rpcResults: {
        get_captain_counts: [{ captain_id: 3, count: 3, total_entries: 5 }],
        get_pick_aggregation: [],
        get_transfer_aggregation: [],
      },
    });

    const result = await eventStatsRepository.getTournamentSelectionStats(context, TOURNAMENT_ID, EVENT_ID, LIMIT);
    expect(result).not.toBeNull();
    expect(result!.mostSelectedPlayers).toHaveLength(0);
    expect(result!.mostTransferIn).toHaveLength(0);
    expect(result!.mostTransferOut).toHaveLength(0);

    expect(result!.captainSelect).toHaveLength(1);
    expect(result!.captainSelect[0].id).toBe(3);
    expect(result!.captainSelect[0].captainByPercent).toBe(60);
    expect(result!.captainSelect[0].selectedByPercent).toBe(0);
  });

  it('uses entryIds.length as fallback when totalEntries is 0', async () => {
    const entryIds = makeEntryIds();
    const context = buildContext({
      fromData: {
        tournament_infos: [{ league_id: LEAGUE_ID, league_type: 'classic' }],
        tournament_entries: entryIds,
        players: makePlayers(),
        teams: makeTeams(),
      },
      rpcResults: {
        get_captain_counts: [{ captain_id: 3, count: 2, total_entries: 5 }],
        get_pick_aggregation: makePickAggregation(),
        get_transfer_aggregation: makeTransferAggregation(),
      },
    });

    const result = await eventStatsRepository.getTournamentSelectionStats(context, TOURNAMENT_ID, EVENT_ID, LIMIT);
    expect(result).not.toBeNull();
    expect(result!.totalEntries).toBe(5);
  });

  it('clamps limit to valid range', async () => {
    const strings = new Map<string, string>();
    const context = {
      redis: {
        get: async (key: string): Promise<string | null> => strings.get(key) ?? null,
        set: async (key: string, value: string, ..._args: unknown[]): Promise<string> => {
          strings.set(key, value);
          return 'OK';
        },
        hgetall: async () => ({}),
        hget: async () => null,
        hset: async () => 1,
        expire: async () => 1,
      },
      supabase: makeMockSupabase({
        fromData: {
          tournament_infos: [makeTournamentInfo()],
          tournament_entries: makeEntryIds(),
          players: makePlayers(),
          teams: makeTeams(),
        },
        rpcResults: {
          get_captain_counts: makeCaptainCounts(),
          get_pick_aggregation: makePickAggregation(),
          get_transfer_aggregation: makeTransferAggregation(),
        },
      }),
      logger: makeMockLogger(),
      user: undefined,
    } as never;

    await eventStatsRepository.getTournamentSelectionStats(context, TOURNAMENT_ID, EVENT_ID, -5);
    const keys = [...strings.keys()];
    const mainKey = keys.find((k) => k === `tournament-selection-stats:${TOURNAMENT_ID}:${EVENT_ID}:1`);
    expect(mainKey).toBeDefined();
  });

  it('uses player/team lookup from Redis cache when available', async () => {
    const cachedPlayers = JSON.stringify([
      { id: 1, web_name: 'Player1', team_id: 1, type: 1, team_short_name: 'TA' },
      { id: 2, web_name: 'Player2', team_id: 1, type: 2, team_short_name: 'TA' },
      { id: 3, web_name: 'Player3', team_id: 2, type: 3, team_short_name: 'TB' },
      { id: 4, web_name: 'Player4', team_id: 2, type: 4, team_short_name: 'TB' },
    ]);

    let playersTableHit = false;
    const context = {
      redis: {
        get: async (key: string): Promise<string | null> => {
          if (key === 'lookup:players-teams:brief') return cachedPlayers;
          if (key.startsWith('tournament-selection-stats:') && !key.includes('captain-counts')) return null;
          if (key.startsWith('tournament:info:')) return null;
          if (key.startsWith('tournaments:entry-ids:')) return null;
          if (key.startsWith('tournament-selection-stats:captain-counts:')) return null;
          return null;
        },
        set: async (_key: string, _value: string, ..._args: unknown[]): Promise<string> => 'OK',
        hgetall: async () => ({}),
        hget: async () => null,
        hset: async () => 1,
        expire: async () => 1,
      },
      supabase: {
        from: (table: string) => {
          if (table === 'players') playersTableHit = true;
          const tableData: Record<string, unknown[]> = {
            tournament_infos: [makeTournamentInfo()],
            tournament_entries: makeEntryIds(),
            players: makePlayers(),
            teams: makeTeams(),
          };
          const rows = tableData[table] ?? [];
          const builder = {
            select: () => builder,
            eq: () => builder,
            in: () => builder,
            limit: async () => ({ data: rows, error: null }),
            order: () => builder,
            then: (resolve: (value: unknown) => unknown) =>
              resolve({ data: rows, error: null }),
          };
          return builder;
        },
        rpc: async (fnName: string, _params: Record<string, unknown>) => {
          const rpcData: Record<string, unknown[]> = {
            get_captain_counts: makeCaptainCounts(),
            get_pick_aggregation: makePickAggregation(),
            get_transfer_aggregation: makeTransferAggregation(),
          };
          return { data: rpcData[fnName] ?? null, error: null };
        },
      },
      logger: makeMockLogger(),
      user: undefined,
    } as never;

    const result = await eventStatsRepository.getTournamentSelectionStats(context, TOURNAMENT_ID, EVENT_ID, LIMIT);
    expect(result).not.toBeNull();
    expect(playersTableHit).toBe(false);
    expect(result!.goalkeepers[0].webName).toBe('Player1');
  });
});
