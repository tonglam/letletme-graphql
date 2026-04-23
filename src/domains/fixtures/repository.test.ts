import { describe, expect, it } from 'bun:test';
import type { GraphQLContext } from '../../graphql/context';
import { fixturesRepository } from './repository';

const buildContext = (options: {
  redisData?: Record<string, string>;
  redisHashes?: Record<string, Record<string, string>>;
  supabaseData?: unknown[];
  supabaseError?: unknown;
}): GraphQLContext => {
  const redisStrings = new Map<string, string>();
  const redisHashes = new Map<string, Record<string, string>>();

  if (options.redisData) {
    for (const [key, value] of Object.entries(options.redisData)) {
      redisStrings.set(key, value);
    }
  }
  if (options.redisHashes) {
    for (const [key, value] of Object.entries(options.redisHashes)) {
      redisHashes.set(key, value);
    }
  }

  return {
    redis: {
      get: async (key: string) => redisStrings.get(key) ?? null,
      set: async (key: string, value: string, ..._args: unknown[]) => {
        redisStrings.set(key, value);
        return 'OK';
      },
      hgetall: async (key: string) => redisHashes.get(key) ?? {},
      expire: async () => 1,
    } as never,
    supabase: {
      from: () => {
        const builder = {
          select: () => builder,
          eq: () => builder,
          order: () => builder,
          then: (resolve: (value: unknown) => unknown) =>
            resolve({ data: options.supabaseData ?? [], error: options.supabaseError ?? null }),
        };
        return builder;
      },
    } as never,
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    } as never,
    user: undefined,
  } as GraphQLContext;
};

describe('fixturesRepository.getEventFixtures', () => {
  it('returns fixtures from Redis hash when available', async () => {
    const fixtureJson = JSON.stringify({
      id: 328,
      code: 2562222,
      event: 33,
      finished: true,
      finishedProvisional: true,
      kickoffTime: '2026-04-18T14:00:00.000Z',
      minutes: 90,
      started: true,
      teamH: 15,
      teamA: 4,
      teamHScore: 1,
      teamAScore: 2,
      teamHDifficulty: 3,
      teamADifficulty: 4,
    });

    const context = buildContext({
      redisHashes: {
        'Fixtures:2526:33': { '328': fixtureJson },
      },
      redisData: {
        'season:current': '2526',
      },
    });

    const result = await fixturesRepository.getEventFixtures(context, 33);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(328);
    expect(result[0].eventId).toBe(33);
    expect(result[0].teamHId).toBe(15);
    expect(result[0].teamAId).toBe(4);
    expect(result[0].teamHScore).toBe(1);
    expect(result[0].teamAScore).toBe(2);
    expect(result[0].finished).toBe(true);
    expect(result[0].started).toBe(true);
  });

  it('handles snake_case fields from sync job fixture data', async () => {
    const fixtureJson = JSON.stringify({
      id: 100,
      code: 12345,
      event: 5,
      finished: false,
      finished_provisional: false,
      kickoff_time: '2026-04-20T15:00:00.000Z',
      minutes: 0,
      started: false,
      team_h: 10,
      team_a: 20,
      team_h_score: null,
      team_a_score: null,
      team_h_difficulty: 4,
      team_a_difficulty: 3,
    });

    const context = buildContext({
      redisHashes: {
        'Fixtures:2526:5': { '100': fixtureJson },
      },
      redisData: {
        'season:current': '2526',
      },
    });

    const result = await fixturesRepository.getEventFixtures(context, 5);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(100);
    expect(result[0].eventId).toBe(5);
    expect(result[0].teamHId).toBe(10);
    expect(result[0].teamAId).toBe(20);
    expect(result[0].finishedProvisional).toBe(false);
    expect(result[0].teamHScore).toBeNull();
  });

  it('falls back to cached string when Redis hash is empty', async () => {
    const cachedFixture = JSON.stringify([{
      id: 200,
      code: 9999,
      eventId: 10,
      finished: false,
      finishedProvisional: false,
      kickoffTime: '2026-04-20T15:00:00.000Z',
      minutes: 0,
      started: false,
      teamHId: 5,
      teamAId: 6,
      teamHScore: null,
      teamAScore: null,
      teamHDifficulty: null,
      teamADifficulty: null,
    }]);

    const context = buildContext({
      redisData: {
        'season:current': '2526',
        'fixtures:event:10': cachedFixture,
      },
    });

    const result = await fixturesRepository.getEventFixtures(context, 10);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(200);
  });

  it('skips invalid rows in Redis hash', async () => {
    const validFixture = JSON.stringify({
      id: 328,
      code: 2562222,
      event: 33,
      finished: true,
      kickoffTime: '2026-04-18T14:00:00.000Z',
      minutes: 90,
      started: true,
      teamH: 15,
      teamA: 4,
    });
    const invalidJson = 'not-json{{{';

    const context = buildContext({
      redisHashes: {
        'Fixtures:2526:33': { '328': validFixture, '999': invalidJson },
      },
      redisData: {
        'season:current': '2526',
      },
    });

    const result = await fixturesRepository.getEventFixtures(context, 33);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(328);
  });
});