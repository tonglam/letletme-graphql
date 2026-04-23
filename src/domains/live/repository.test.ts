import { describe, expect, it } from 'bun:test';
import { liveRepository } from './repository';

const makeMockRedis = (options: {
  strings?: Record<string, string>;
  hashes?: Record<string, Record<string, string>>;
}) => {
  const strings = new Map(Object.entries(options.strings ?? {}));
  const hashes = new Map(Object.entries(options.hashes ?? {}).map(([k, v]) => [k, v]));

  return {
    get: async (key: string): Promise<string | null> => strings.get(key) ?? null,
    set: async (key: string, value: string): Promise<string> => {
      strings.set(key, value);
      return 'OK';
    },
    hgetall: async (key: string): Promise<Record<string, string>> => hashes.get(key) ?? {},
    hget: async (key: string, field: string): Promise<string | null> => hashes.get(key)?.[field] ?? null,
    hset: async (key: string, ...args: unknown[]): Promise<number> => {
      if (!hashes.has(key)) hashes.set(key, {});
      const pairs = args as string[];
      for (let i = 0; i < pairs.length - 1; i += 2) {
        hashes.get(key)![pairs[i]] = pairs[i + 1];
      }
      return 1;
    },
    expire: async (): Promise<number> => 1,
  };
};

const makeMockSupabase = (options: { data?: unknown[]; error?: unknown }) => ({
  from: () => {
    const builder = {
      select: () => builder,
      eq: () => builder,
      in: () => builder,
      limit: async () => ({ data: options.data ?? [], error: options.error ?? null }),
      order: () => builder,
      then: (resolve: (value: unknown) => unknown) =>
        resolve({ data: options.data ?? [], error: options.error ?? null }),
    };
    return builder;
  },
});

const makeMockLogger = () => ({
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
});

const buildContext = (options: {
  redisStrings?: Record<string, string>;
  redisHashes?: Record<string, Record<string, string>>;
  supabaseData?: unknown[];
  supabaseError?: unknown;
}) => ({
  redis: makeMockRedis({ strings: options.redisStrings, hashes: options.redisHashes }),
  supabase: makeMockSupabase({ data: options.supabaseData, error: options.supabaseError }),
  logger: makeMockLogger(),
  user: undefined,
}) as never;

const SAMPLE_SYNC_JOB_ROW = JSON.stringify({
  id: 24738,
  eventId: 33,
  elementId: 1,
  minutes: 90,
  goalsScored: 0,
  assists: 0,
  cleanSheets: 0,
  goalsConceded: 2,
  ownGoals: 0,
  penaltiesSaved: 0,
  penaltiesMissed: 0,
  yellowCards: 0,
  redCards: 0,
  saves: 2,
  bonus: 0,
  bps: 8,
  starts: true,
  defensiveContribution: 0,
  expectedGoals: '0.00',
  expectedAssists: '0.00',
  expectedGoalInvolvements: '0.00',
  expectedGoalsConceded: '1.36',
  inDreamTeam: false,
  totalPoints: 1,
});

describe('liveRepository.getAllLivePerformances', () => {
  it('returns empty map for invalid eventId', async () => {
    const context = buildContext({});
    const result = await liveRepository.getAllLivePerformances(context, 0);
    expect(result.size).toBe(0);
  });

  it('returns empty map for negative eventId', async () => {
    const context = buildContext({});
    const result = await liveRepository.getAllLivePerformances(context, -1);
    expect(result.size).toBe(0);
  });

  it('parses Performance data from Redis EventLive hash', async () => {
    const field1 = JSON.stringify({
      id: 100, eventId: 33, elementId: 1,
      minutes: 90, goalsScored: 2, assists: 1, cleanSheets: 0, goalsConceded: 1,
      ownGoals: 0, penaltiesSaved: 0, penaltiesMissed: 0, yellowCards: 0, redCards: 0,
      saves: 3, bonus: 2, bps: 15, starts: true, defensiveContribution: 5,
      expectedGoals: '1.20', expectedAssists: '0.30', expectedGoalInvolvements: '1.50',
      expectedGoalsConceded: '0.80', inDreamTeam: true, totalPoints: 10,
    });
    const field2 = JSON.stringify({
      id: 101, eventId: 33, elementId: 2,
      minutes: 45, goalsScored: 1, assists: 0, cleanSheets: 0, goalsConceded: 0,
      ownGoals: 0, penaltiesSaved: 0, penaltiesMissed: 0, yellowCards: 1, redCards: 0,
      saves: 0, bonus: 0, bps: 5, starts: true, defensiveContribution: 3,
      expectedGoals: '0.50', expectedAssists: '0.10', expectedGoalInvolvements: '0.60',
      expectedGoalsConceded: '0.40', inDreamTeam: false, totalPoints: 3,
    });

    const context = buildContext({
      redisStrings: { 'season:current': '2526' },
      redisHashes: { 'EventLive:2526:33': { '1': field1, '2': field2 } },
    });

    const result = await liveRepository.getAllLivePerformances(context, 33);
    expect(result.size).toBe(2);
    expect(result.get(1)).toBeDefined();
    expect(result.get(1)!.playerId).toBe(1);
    expect(result.get(1)!.eventId).toBe(33);
    expect(result.get(1)!.minutes).toBe(90);
    expect(result.get(1)!.goalsScored).toBe(2);
    expect(result.get(1)!.assists).toBe(1);
    expect(result.get(1)!.bonus).toBe(2);
    expect(result.get(1)!.totalPoints).toBe(10);
    expect(result.get(1)!.inDreamTeam).toBe(true);

    expect(result.get(2)).toBeDefined();
    expect(result.get(2)!.playerId).toBe(2);
    expect(result.get(2)!.minutes).toBe(45);
    expect(result.get(2)!.yellowCards).toBe(1);
  });

  it('falls back to DB when Redis hash is empty', async () => {
    const context = buildContext({
      redisStrings: { 'season:current': '2526' },
      redisHashes: {},
      supabaseData: [
        {
          event_id: 33, element_id: 1, minutes: 60, goals_scored: 0, assists: 0,
          clean_sheets: 1, goals_conceded: 0, own_goals: 0, penalties_saved: 0,
          penalties_missed: 0, yellow_cards: 0, red_cards: 0, saves: 0, bonus: 0,
          bps: 0, starts: true, defensive_contribution: 0, expected_goals: null,
          expected_assists: null, expected_goal_involvements: null,
          expected_goals_conceded: null, in_dream_team: false, total_points: 3,
        },
      ],
    });

    const result = await liveRepository.getAllLivePerformances(context, 33);
    expect(result.size).toBe(1);
    expect(result.get(1)).toBeDefined();
    expect(result.get(1)!.playerId).toBe(1);
    expect(result.get(1)!.minutes).toBe(60);
    expect(result.get(1)!.totalPoints).toBe(3);
  });

  it('skips invalid JSON rows in Redis hash', async () => {
    const invalidJson = 'not-valid-json{{{';
    const missingFields = JSON.stringify({ id: 99 });

    const context = buildContext({
      redisStrings: { 'season:current': '2526' },
      redisHashes: { 'EventLive:2526:33': { '1': SAMPLE_SYNC_JOB_ROW, '99': invalidJson, '98': missingFields } },
    });

    const result = await liveRepository.getAllLivePerformances(context, 33);
    expect(result.size).toBe(1);
    expect(result.get(1)).toBeDefined();
    expect(result.get(1)!.playerId).toBe(1);
  });
});

describe('liveRepository.getLivePerformancesByPlayerIds', () => {
  it('filters from getAllLivePerformances by player IDs', async () => {
    const field1 = JSON.stringify({
      id: 100, eventId: 33, elementId: 1,
      minutes: 90, goalsScored: 0, assists: 0, cleanSheets: 0, goalsConceded: 2,
      ownGoals: 0, penaltiesSaved: 0, penaltiesMissed: 0, yellowCards: 0, redCards: 0,
      saves: 2, bonus: 0, bps: 8, starts: true, defensiveContribution: 0,
      expectedGoals: '0.00', expectedAssists: '0.00', expectedGoalInvolvements: '0.00',
      expectedGoalsConceded: '1.36', inDreamTeam: false, totalPoints: 1,
    });
    const field2 = JSON.stringify({
      id: 101, eventId: 33, elementId: 2,
      minutes: 45, goalsScored: 1, assists: 0, cleanSheets: 0, goalsConceded: 0,
      ownGoals: 0, penaltiesSaved: 0, penaltiesMissed: 0, yellowCards: 0, redCards: 0,
      saves: 0, bonus: 0, bps: 5, starts: true, defensiveContribution: 3,
      expectedGoals: '0.50', expectedAssists: '0.10', expectedGoalInvolvements: '0.60',
      expectedGoalsConceded: '0.40', inDreamTeam: false, totalPoints: 3,
    });

    const context = buildContext({
      redisStrings: { 'season:current': '2526' },
      redisHashes: { 'EventLive:2526:33': { '1': field1, '2': field2 } },
    });

    const result = await liveRepository.getLivePerformancesByPlayerIds(context, 33, [2]);
    expect(result).toHaveLength(1);
    expect(result[0].playerId).toBe(2);
    expect(result[0].goalsScored).toBe(1);
  });

  it('returns empty array for empty player IDs', async () => {
    const context = buildContext({});
    const result = await liveRepository.getLivePerformancesByPlayerIds(context, 33, []);
    expect(result).toHaveLength(0);
  });
});

describe('liveRepository.getEventLive', () => {
  it('returns EventLive with all Performances from Redis', async () => {
    const field1 = JSON.stringify({
      id: 100, eventId: 33, elementId: 1,
      minutes: 90, goalsScored: 0, assists: 0, cleanSheets: 0, goalsConceded: 2,
      ownGoals: 0, penaltiesSaved: 0, penaltiesMissed: 0, yellowCards: 0, redCards: 0,
      saves: 2, bonus: 0, bps: 8, starts: true, defensiveContribution: 0,
      expectedGoals: '0.00', expectedAssists: '0.00', expectedGoalInvolvements: '0.00',
      expectedGoalsConceded: '1.36', inDreamTeam: false, totalPoints: 1,
    });

    const context = buildContext({
      redisStrings: { 'season:current': '2526' },
      redisHashes: { 'EventLive:2526:33': { '1': field1 } },
    });

    const result = await liveRepository.getEventLive(context, 33);
    expect(result.eventId).toBe(33);
    expect(result.performances).toHaveLength(1);
    expect(result.performances[0].playerId).toBe(1);
  });
});