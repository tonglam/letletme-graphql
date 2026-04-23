import { describe, expect, it } from 'bun:test';
import { makeExecutableSchema } from '@graphql-tools/schema';
import { graphql } from 'graphql';
import { DateTimeResolver } from 'graphql-scalars';
import type { GraphQLContext } from '../../graphql/context';
import { baseResolvers, baseTypeDefs } from '../../graphql/base-schema';
import { playersTypeDefs } from '../players/schema';
import { playerValuesResolvers } from './resolvers';
import { playerValuesTypeDefs } from './schema';

type HistoryRow = {
  element_id: number;
  value: number;
  last_value: number | null;
  change_date: string;
};

type QueryError = {
  message: string;
};

type QueryResult<T> = {
  data: T[] | null;
  error: QueryError | null;
};

class MockPlayerValuesHistoryQuery implements PromiseLike<QueryResult<HistoryRow>> {
  private readonly rows: HistoryRow[];
  private playerIdFilter: number | null = null;
  private fromDateFilter: string | null = null;
  private toDateFilter: string | null = null;
  private limitValue: number | null = null;
  private ascending = false;

  constructor(rows: HistoryRow[]) {
    this.rows = rows;
  }

  select(_columns: string): this {
    return this;
  }

  eq(column: string, value: number): this {
    if (column === 'element_id') {
      this.playerIdFilter = value;
    }
    return this;
  }

  order(_column: string, options: { ascending: boolean }): this {
    this.ascending = options.ascending;
    return this;
  }

  limit(value: number): this {
    this.limitValue = value;
    return this;
  }

  gte(_column: string, value: string): this {
    this.fromDateFilter = value;
    return this;
  }

  lte(_column: string, value: string): this {
    this.toDateFilter = value;
    return this;
  }

  private run(): QueryResult<HistoryRow> {
    let filtered = [...this.rows];

    if (this.playerIdFilter !== null) {
      filtered = filtered.filter((row) => row.element_id === this.playerIdFilter);
    }

    if (this.fromDateFilter !== null) {
      filtered = filtered.filter((row) => row.change_date.localeCompare(this.fromDateFilter!) >= 0);
    }

    if (this.toDateFilter !== null) {
      filtered = filtered.filter((row) => row.change_date.localeCompare(this.toDateFilter!) <= 0);
    }

    filtered.sort((left, right) => {
      // change_date is stored as yyyyMMdd string; lexicographic sort matches chronological
      return this.ascending
        ? left.change_date.localeCompare(right.change_date)
        : right.change_date.localeCompare(left.change_date);
    });

    if (this.limitValue !== null) {
      filtered = filtered.slice(0, this.limitValue);
    }

    return {
      data: filtered,
      error: null,
    };
  }

  then<TResult1 = QueryResult<HistoryRow>, TResult2 = never>(
    onfulfilled?:
      | ((value: QueryResult<HistoryRow>) => TResult1 | PromiseLike<TResult1>)
      | null
      | undefined,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null | undefined
  ): Promise<TResult1 | TResult2> {
    return Promise.resolve(this.run()).then(onfulfilled, onrejected);
  }
}

function createGraphQLContext(rows: HistoryRow[]): GraphQLContext {
  const supabase = {
    from: (_table: string): MockPlayerValuesHistoryQuery => new MockPlayerValuesHistoryQuery(rows),
  } as unknown as GraphQLContext['supabase'];

  const redis = {
    type: async (): Promise<string> => 'none',
    get: async (): Promise<string | null> => null,
    set: async (): Promise<string> => 'OK',
    hgetall: async (): Promise<Record<string, string>> => ({}),
    keys: async (): Promise<string[]> => [],
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
  };
}

const testSchema = makeExecutableSchema({
  typeDefs: [baseTypeDefs, playersTypeDefs, playerValuesTypeDefs],
  resolvers: [baseResolvers, { DateTime: DateTimeResolver }, playerValuesResolvers],
});

const historyQuery = `
  query PlayerValueHistory($playerId: Int!, $limit: Int, $fromDate: DateTime, $toDate: DateTime) {
    playerValueHistory(playerId: $playerId, limit: $limit, fromDate: $fromDate, toDate: $toDate) {
      playerId
      changeDate
      oldValue
      newValue
      changeType
      transfersIn
      transfersOut
    }
  }
`;

describe('playerValueHistory integration', () => {
  it('returns history rows with computed changeType', async () => {
    const rows: HistoryRow[] = [
      {
        element_id: 10,
        value: 1010,
        last_value: 1000,
        change_date: '20260403',
      },
      {
        element_id: 10,
        value: 1000,
        last_value: 990,
        change_date: '20260402',
      },
      {
        element_id: 10,
        value: 990,
        last_value: 980,
        change_date: '20260401',
      },
    ];

    const result = await graphql({
      schema: testSchema,
      source: historyQuery,
      contextValue: createGraphQLContext(rows),
      variableValues: { playerId: 10, limit: 3 },
    });

    expect(result.errors).toBeUndefined();
    const data = result.data as
      | {
          playerValueHistory: Array<{
            playerId: number;
            changeDate: string;
            oldValue: number;
            newValue: number;
            changeType: string;
            transfersIn: number | null;
            transfersOut: number | null;
          }>;
        }
      | null;

    expect(data).not.toBeNull();
    expect(data?.playerValueHistory).toHaveLength(3);
    expect(data?.playerValueHistory[0].changeType).toBe('RISE');
    expect(data?.playerValueHistory[0].oldValue).toBe(1000);
    expect(data?.playerValueHistory[0].newValue).toBe(1010);
  });

  it('returns empty array when player has no history', async () => {
    const rows: HistoryRow[] = [
      {
        element_id: 77,
        value: 1000,
        last_value: 990,
        change_date: '20260401',
      },
    ];

    const result = await graphql({
      schema: testSchema,
      source: historyQuery,
      contextValue: createGraphQLContext(rows),
      variableValues: { playerId: 10, limit: 3 },
    });

    expect(result.errors).toBeUndefined();
    const data = result.data as { playerValueHistory: unknown[] } | null;
    expect(data?.playerValueHistory).toEqual([]);
  });

  it('returns rows sorted by changeDate descending', async () => {
    const rows: HistoryRow[] = [
      {
        element_id: 10,
        value: 1000,
        last_value: 990,
        change_date: '20260401',
      },
      {
        element_id: 10,
        value: 1010,
        last_value: 1000,
        change_date: '20260403',
      },
      {
        element_id: 10,
        value: 1005,
        last_value: 1000,
        change_date: '20260402',
      },
    ];

    const result = await graphql({
      schema: testSchema,
      source: historyQuery,
      contextValue: createGraphQLContext(rows),
      variableValues: { playerId: 10, limit: 2 },
    });

    expect(result.errors).toBeUndefined();
    const data = result.data as
      | {
          playerValueHistory: Array<{
            changeDate: string;
          }>;
        }
      | null;

    expect(data).not.toBeNull();
    expect(data?.playerValueHistory).toHaveLength(2);
    expect(new Date(data?.playerValueHistory[0].changeDate ?? '').toISOString()).toBe(
      '2026-04-03T00:00:00.000Z'
    );
    expect(new Date(data?.playerValueHistory[1].changeDate ?? '').toISOString()).toBe(
      '2026-04-02T00:00:00.000Z'
    );
  });

  it('returns null transfer fields because player_values does not store them', async () => {
    const rows: HistoryRow[] = [
      {
        element_id: 10,
        value: 1010,
        last_value: 1000,
        change_date: '20260403',
      },
      {
        element_id: 10,
        value: 1000,
        last_value: 990,
        change_date: '20260402',
      },
    ];

    const result = await graphql({
      schema: testSchema,
      source: historyQuery,
      contextValue: createGraphQLContext(rows),
      variableValues: { playerId: 10, limit: 2 },
    });

    expect(result.errors).toBeUndefined();
    const data = result.data as
      | {
          playerValueHistory: Array<{
            transfersIn: number | null;
            transfersOut: number | null;
          }>;
        }
      | null;

    expect(data).not.toBeNull();
    expect(data?.playerValueHistory[0].transfersIn).toBeNull();
    expect(data?.playerValueHistory[0].transfersOut).toBeNull();
  });

  it('matches contract snapshot for response shape', async () => {
    const rows: HistoryRow[] = [
      {
        element_id: 10,
        value: 1020,
        last_value: 1010,
        change_date: '20260404',
      },
      {
        element_id: 10,
        value: 1010,
        last_value: 1000,
        change_date: '20260403',
      },
    ];

    const result = await graphql({
      schema: testSchema,
      source: historyQuery,
      contextValue: createGraphQLContext(rows),
      variableValues: { playerId: 10, limit: 2 },
    });

    expect(result).toMatchSnapshot();
  });
});
