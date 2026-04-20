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
  player_id: number;
  value: number;
  last_value: number | null;
  transfers_in: number | null;
  transfers_out: number | null;
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
  private fromDateFilter: number | null = null;
  private toDateFilter: number | null = null;
  private limitValue: number | null = null;
  private ascending = false;

  constructor(rows: HistoryRow[]) {
    this.rows = rows;
  }

  select(_columns: string): this {
    return this;
  }

  eq(column: string, value: number): this {
    if (column === 'player_id') {
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
    this.fromDateFilter = new Date(value).getTime();
    return this;
  }

  lte(_column: string, value: string): this {
    this.toDateFilter = new Date(value).getTime();
    return this;
  }

  private run(): QueryResult<HistoryRow> {
    let filtered = [...this.rows];

    if (this.playerIdFilter !== null) {
      filtered = filtered.filter((row) => row.player_id === this.playerIdFilter);
    }

    if (this.fromDateFilter !== null) {
      filtered = filtered.filter((row) => new Date(row.change_date).getTime() >= this.fromDateFilter!);
    }

    if (this.toDateFilter !== null) {
      filtered = filtered.filter((row) => new Date(row.change_date).getTime() <= this.toDateFilter!);
    }

    filtered.sort((left, right) => {
      const leftTime = new Date(left.change_date).getTime();
      const rightTime = new Date(right.change_date).getTime();
      return this.ascending ? leftTime - rightTime : rightTime - leftTime;
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
        player_id: 10,
        value: 1010,
        last_value: 1000,
        transfers_in: 4000,
        transfers_out: 2500,
        change_date: '2026-04-03T00:00:00.000Z',
      },
      {
        player_id: 10,
        value: 1000,
        last_value: 990,
        transfers_in: 3500,
        transfers_out: 2600,
        change_date: '2026-04-02T00:00:00.000Z',
      },
      {
        player_id: 10,
        value: 990,
        last_value: 980,
        transfers_in: 3300,
        transfers_out: 2800,
        change_date: '2026-04-01T00:00:00.000Z',
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
        player_id: 77,
        value: 1000,
        last_value: 990,
        transfers_in: 2000,
        transfers_out: 1500,
        change_date: '2026-04-01T00:00:00.000Z',
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
        player_id: 10,
        value: 1000,
        last_value: 990,
        transfers_in: 3000,
        transfers_out: 2000,
        change_date: '2026-04-01T00:00:00.000Z',
      },
      {
        player_id: 10,
        value: 1010,
        last_value: 1000,
        transfers_in: 3500,
        transfers_out: 2100,
        change_date: '2026-04-03T00:00:00.000Z',
      },
      {
        player_id: 10,
        value: 1005,
        last_value: 1000,
        transfers_in: 3400,
        transfers_out: 2050,
        change_date: '2026-04-02T00:00:00.000Z',
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

  it('preserves nullable transfer fields in response', async () => {
    const rows: HistoryRow[] = [
      {
        player_id: 10,
        value: 1010,
        last_value: 1000,
        transfers_in: null,
        transfers_out: null,
        change_date: '2026-04-03T00:00:00.000Z',
      },
      {
        player_id: 10,
        value: 1000,
        last_value: 990,
        transfers_in: 3200,
        transfers_out: 2100,
        change_date: '2026-04-02T00:00:00.000Z',
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
        player_id: 10,
        value: 1020,
        last_value: 1010,
        transfers_in: 4200,
        transfers_out: 2300,
        change_date: '2026-04-04T00:00:00.000Z',
      },
      {
        player_id: 10,
        value: 1010,
        last_value: 1000,
        transfers_in: 3900,
        transfers_out: 2400,
        change_date: '2026-04-03T00:00:00.000Z',
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
