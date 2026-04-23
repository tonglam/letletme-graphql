import { describe, expect, it } from 'bun:test';
import type { GraphQLContext } from '../../graphql/context';
import { entryLiveBatchService } from './batch-service';
import type { LivePerformance } from '../live/repository';

const makeMockContext = (options: {
  livePerformances?: Map<number, LivePerformance>;
  fixtures?: unknown[];
  teams?: unknown[];
  players?: unknown[];
  entries?: Map<number, unknown>;
  picks?: Map<number, unknown>;
  transfers?: Map<number, unknown>;
  eventResults?: Map<string, unknown>;
}): GraphQLContext => {
  const redisState = new Map<string, string>();
  const redisHashes = new Map<string, Record<string, string>>();

  const livePerformances = options.livePerformances ?? new Map();

  return {
    redis: {
      get: async (key: string) => {
        if (key === 'season:current') return '2526';
        return redisState.get(key) ?? null;
      },
      set: async (key: string, value: string) => {
        redisState.set(key, value);
        return 'OK';
      },
      hgetall: async (key: string) => redisHashes.get(key) ?? {},
      hget: async (key: string, field: string) => redisHashes.get(key)?.[field] ?? null,
      expire: async () => 1,
    } as never,
    supabase: {
      from: () => {
        const builder = {
          select: () => builder,
          eq: () => builder,
          in: () => builder,
          order: () => builder,
          limit: async () => ({ data: [], error: null }),
          then: (resolve: (value: unknown) => unknown) =>
            resolve({ data: [], error: null }),
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
    __livePerformances: livePerformances,
  } as GraphQLContext;
};

describe('entryLiveBatchService.calcLivePointsForEntries', () => {
  it('returns empty results for empty entry IDs', async () => {
    const context = makeMockContext({});
    const result = await entryLiveBatchService.calcLivePointsForEntries(context, 33, []);
    expect(result.results.size).toBe(0);
    expect(result.errors).toHaveLength(0);
    expect(result.meta.totalEntries).toBe(0);
    expect(result.meta.succeededCount).toBe(0);
  });

  it('populates meta correctly', async () => {
    const context = makeMockContext({});
    const result = await entryLiveBatchService.calcLivePointsForEntries(context, 33, []);
    expect(result.meta.eventId).toBe(33);
    expect(result.meta.totalEntries).toBe(0);
    expect(result.meta.failedCount).toBe(0);
  });
});