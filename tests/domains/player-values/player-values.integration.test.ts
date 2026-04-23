import { describe, expect, it } from 'bun:test';
import { makeExecutableSchema } from '@graphql-tools/schema';
import { graphql } from 'graphql';
import { DateTimeResolver } from 'graphql-scalars';
import type { GraphQLContext } from '../../../src/graphql/context';
import { baseResolvers, baseTypeDefs } from '../../../src/graphql/base-schema';
import { playersTypeDefs } from '../../../src/domains/players/schema';
import { playerValuesResolvers } from '../../../src/domains/player-values/resolvers';
import { playerValuesTypeDefs } from '../../../src/domains/player-values/schema';

type PlayerValueRow = {
  player_id: number;
  player_name: string;
  team_id: number;
  team_name: string;
  team_short_name?: string | null;
  position: string;
  price: number;
  value: number;
  last_value: number;
  points: number;
  selected_by: number;
  transfers_in: number;
  transfers_out: number;
  net_transfers: number;
  form: number | null;
  total_points: number;
  event_points: number | null;
  change_date: string;
};

type QueryResult<T> = {
  data: T[] | null;
  error: { message: string } | null;
};

class MockPlayerValuesQuery implements PromiseLike<QueryResult<PlayerValueRow>> {
  private readonly rows: PlayerValueRow[];
  private orderColumn: string | null = null;
  private ascending = true;

  constructor(rows: PlayerValueRow[]) {
    this.rows = rows;
  }

  select(_columns: string): this {
    return this;
  }

  order(column: string, options: { ascending: boolean }): this {
    this.orderColumn = column;
    this.ascending = options.ascending;
    return this;
  }

  or(_filters: string): this {
    return this;
  }

  private run(): QueryResult<PlayerValueRow> {
    const data = [...this.rows];

    if (this.orderColumn === 'change_date') {
      data.sort((left, right) =>
        this.ascending
          ? left.change_date.localeCompare(right.change_date)
          : right.change_date.localeCompare(left.change_date)
      );
    }

    return {
      data,
      error: null,
    };
  }

  then<TResult1 = QueryResult<PlayerValueRow>, TResult2 = never>(
    onfulfilled?:
      | ((value: QueryResult<PlayerValueRow>) => TResult1 | PromiseLike<TResult1>)
      | null
      | undefined,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null | undefined
  ): Promise<TResult1 | TResult2> {
    return Promise.resolve(this.run()).then(onfulfilled, onrejected);
  }
}

type ContextOptions = {
  redisType?: string;
  redisHashData?: Record<string, string>;
  rows?: PlayerValueRow[];
};

function createGraphQLContext(options: ContextOptions = {}): GraphQLContext & { calls: { supabaseFrom: number } } {
  const calls = { supabaseFrom: 0 };

  const supabase = {
    from: (_table: string): MockPlayerValuesQuery => {
      calls.supabaseFrom += 1;
      return new MockPlayerValuesQuery(options.rows ?? []);
    },
  } as unknown as GraphQLContext['supabase'];

  const redis = {
    type: async (): Promise<string> => options.redisType ?? 'none',
    get: async (): Promise<string | null> => null,
    set: async (): Promise<string> => 'OK',
    hgetall: async (): Promise<Record<string, string>> => options.redisHashData ?? {},
  } as unknown as GraphQLContext['redis'];

  const logger = {
    info: (): void => {},
    warn: (): void => {},
    error: (): void => {},
  } as unknown as GraphQLContext['logger'];

  return {
    supabase,
    redis,
    logger,
    calls,
  };
}

const testSchema = makeExecutableSchema({
  typeDefs: [baseTypeDefs, playersTypeDefs, playerValuesTypeDefs],
  resolvers: [baseResolvers, { DateTime: DateTimeResolver }, playerValuesResolvers],
});

const playerValuesQuery = `
  query PlayerValues($changeDate: DateTime) {
    playerValues(changeDate: $changeDate) {
      playerId
      playerName
      teamName
      position
      lastValue
      value
    }
  }
`;

describe('playerValues integration', () => {
  it('returns empty array for the default current-day query when today cache is missing', async () => {
    const context = createGraphQLContext({
      redisType: 'none',
      rows: [
        {
          player_id: 136,
          player_name: 'Thiago',
          team_id: 4,
          team_name: 'Brentford',
          team_short_name: 'BRE',
          position: 'FWD',
          price: 74,
          value: 74,
          last_value: 73,
          points: 0,
          selected_by: 1.2,
          transfers_in: 1000,
          transfers_out: 500,
          net_transfers: 500,
          form: 2.1,
          total_points: 40,
          event_points: 0,
          change_date: '20260421',
        },
      ],
    });

    const result = await graphql({
      schema: testSchema,
      source: playerValuesQuery,
      contextValue: context,
      variableValues: {},
    });

    expect(result.errors).toBeUndefined();
    const data = result.data as { playerValues: unknown[] } | null;
    expect(data?.playerValues).toEqual([]);
    expect(context.calls.supabaseFrom).toBeGreaterThan(0);
  });

  it('still returns cached rows when the requested cache key exists', async () => {
    const context = createGraphQLContext({
      redisType: 'hash',
      redisHashData: {
        '136': JSON.stringify({
          elementId: 136,
          webName: 'Thiago',
          teamName: 'Brentford',
          teamShortName: 'BRE',
          elementTypeName: 'FWD',
          value: 74,
          lastValue: 73,
        }),
      },
    });

    const result = await graphql({
      schema: testSchema,
      source: playerValuesQuery,
      contextValue: context,
      variableValues: {},
    });

    expect(result.errors).toBeUndefined();
    const data = result.data as
      | {
          playerValues: Array<{
            playerId: number;
            playerName: string;
            teamName: string;
            position: string;
            lastValue: number;
            value: number;
          }>;
        }
      | null;

    expect(data?.playerValues).toEqual([
      {
        playerId: 136,
        playerName: 'Thiago',
        teamName: 'Brentford',
        position: 'FWD',
        lastValue: 73,
        value: 74,
      },
    ]);
    expect(context.calls.supabaseFrom).toBe(0);
  });
});
