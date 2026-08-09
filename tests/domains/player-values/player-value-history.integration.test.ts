import { describe, expect, it } from "bun:test";
import { makeExecutableSchema } from "@graphql-tools/schema";
import { graphql } from "graphql";
import { DateResolver, DateTimeResolver } from "graphql-scalars";
import { playerValuesResolvers } from "../../../src/domains/player-values/resolvers";
import { playerValuesTypeDefs } from "../../../src/domains/player-values/schema";
import { playersTypeDefs } from "../../../src/domains/players/schema";
import { baseResolvers, baseTypeDefs } from "../../../src/graphql/base-schema";
import type { GraphQLContext } from "../../../src/graphql/context";

type HistoryRow = {
	element_id: number;
	value: number;
	last_value: number | null;
	change_date: string;
	change_type?: string | null;
};

type QueryError = {
	message: string;
};

type QueryResult<T> = {
	data: T[] | null;
	error: QueryError | null;
};

function createHistoryQueryBuilder(rows: HistoryRow[]) {
	let playerIdFilter: number | null = null;
	let fromDateFilter: string | null = null;
	let toDateFilter: string | null = null;
	let ascending = false;

	const applyFilters = (): QueryResult<HistoryRow> => {
		let filtered = [...rows];

		if (playerIdFilter !== null) {
			filtered = filtered.filter((row) => row.element_id === playerIdFilter);
		}

		if (fromDateFilter !== null) {
			const fromDate = fromDateFilter;
			filtered = filtered.filter((row) => row.change_date.localeCompare(fromDate) >= 0);
		}

		if (toDateFilter !== null) {
			const toDate = toDateFilter;
			filtered = filtered.filter((row) => row.change_date.localeCompare(toDate) <= 0);
		}

		filtered.sort((left, right) => {
			return ascending
				? left.change_date.localeCompare(right.change_date)
				: right.change_date.localeCompare(left.change_date);
		});

		return {
			data: filtered,
			error: null,
		};
	};

	let resolvePromise!: (value: QueryResult<HistoryRow>) => void;
	const promise = new Promise<QueryResult<HistoryRow>>((resolve) => {
		resolvePromise = resolve;
	});

	queueMicrotask(() => resolvePromise(applyFilters()));

	const builder = Object.assign(promise, {
		select(_columns: string) {
			return builder;
		},
		eq(column: string, value: number) {
			if (column === "element_id") {
				playerIdFilter = value;
			}
			return builder;
		},
		order(_column: string, options: { ascending: boolean }) {
			ascending = options.ascending;
			return builder;
		},
		gte(_column: string, value: string) {
			fromDateFilter = value;
			return builder;
		},
		lte(_column: string, value: string) {
			toDateFilter = value;
			return builder;
		},
	});

	return builder;
}

function createGraphQLContext(rows: HistoryRow[]): GraphQLContext {
	const data = {
		read: (_table: string) => createHistoryQueryBuilder(rows),
	} as unknown as GraphQLContext["data"];

	const redis = {
		type: async (): Promise<string> => "none",
		get: async (): Promise<string | null> => null,
		set: async (): Promise<string> => "OK",
		hgetall: async (): Promise<Record<string, string>> => ({}),
		keys: async (): Promise<string[]> => [],
	} as unknown as GraphQLContext["redis"];

	const logger = {
		info: (): void => {},
		warn: (): void => {},
		error: (): void => {},
	} as unknown as GraphQLContext["logger"];

	return {
		database: {
			query: async () => {
				throw new Error("Unexpected database query");
			},
		} as never,
		currentSeason: { seasonId: 2025, seasonCode: "2526" },
		dataRevision: "core-history-test",
		data,
		redis,
		logger,
	};
}

const testSchema = makeExecutableSchema({
	typeDefs: [baseTypeDefs, playersTypeDefs, playerValuesTypeDefs],
	resolvers: [
		baseResolvers,
		{ Date: DateResolver, DateTime: DateTimeResolver },
		playerValuesResolvers,
	],
});

const historyQuery = `
  query PlayerValueHistory($playerId: Int!, $fromDate: DateTime, $toDate: DateTime) {
    playerValueHistory(playerId: $playerId, fromDate: $fromDate, toDate: $toDate) {
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

describe("playerValueHistory integration", () => {
	it("excludes the season baseline instead of reporting a false zero-price rise", async () => {
		const rows: HistoryRow[] = [
			{
				element_id: 10,
				value: 156,
				last_value: 155,
				change_date: "20260803",
				change_type: "rise",
			},
			{
				element_id: 10,
				value: 155,
				last_value: 0,
				change_date: "20260802",
				change_type: "start",
			},
		];

		const result = await graphql({
			schema: testSchema,
			source: historyQuery,
			contextValue: createGraphQLContext(rows),
			variableValues: { playerId: 10 },
		});

		expect(result.errors).toBeUndefined();
		const data = result.data as {
			playerValueHistory: Array<{ oldValue: number; newValue: number }>;
		} | null;
		expect(data?.playerValueHistory).toHaveLength(1);
		expect(data?.playerValueHistory[0]).toMatchObject({ oldValue: 155, newValue: 156 });
	});

	it("returns history rows with computed changeType", async () => {
		const rows: HistoryRow[] = [
			{
				element_id: 10,
				value: 1010,
				last_value: 1000,
				change_date: "20260403",
			},
			{
				element_id: 10,
				value: 1000,
				last_value: 990,
				change_date: "20260402",
			},
			{
				element_id: 10,
				value: 990,
				last_value: 980,
				change_date: "20260401",
			},
		];

		const result = await graphql({
			schema: testSchema,
			source: historyQuery,
			contextValue: createGraphQLContext(rows),
			variableValues: { playerId: 10 },
		});

		expect(result.errors).toBeUndefined();
		const data = result.data as {
			playerValueHistory: Array<{
				playerId: number;
				changeDate: string;
				oldValue: number;
				newValue: number;
				changeType: string;
				transfersIn: number | null;
				transfersOut: number | null;
			}>;
		} | null;

		expect(data).not.toBeNull();
		expect(data?.playerValueHistory).toHaveLength(3);
		expect(data?.playerValueHistory[0].changeType).toBe("RISE");
		expect(data?.playerValueHistory[0].oldValue).toBe(1000);
		expect(data?.playerValueHistory[0].newValue).toBe(1010);
	});

	it("returns empty array when player has no history", async () => {
		const rows: HistoryRow[] = [
			{
				element_id: 77,
				value: 1000,
				last_value: 990,
				change_date: "20260401",
			},
		];

		const result = await graphql({
			schema: testSchema,
			source: historyQuery,
			contextValue: createGraphQLContext(rows),
			variableValues: { playerId: 10 },
		});

		expect(result.errors).toBeUndefined();
		const data = result.data as { playerValueHistory: unknown[] } | null;
		expect(data?.playerValueHistory).toEqual([]);
	});

	it("returns all rows sorted by changeDate descending", async () => {
		const rows: HistoryRow[] = [
			{
				element_id: 10,
				value: 1000,
				last_value: 990,
				change_date: "20260401",
			},
			{
				element_id: 10,
				value: 1010,
				last_value: 1000,
				change_date: "20260403",
			},
			{
				element_id: 10,
				value: 1005,
				last_value: 1000,
				change_date: "20260402",
			},
		];

		const result = await graphql({
			schema: testSchema,
			source: historyQuery,
			contextValue: createGraphQLContext(rows),
			variableValues: { playerId: 10 },
		});

		expect(result.errors).toBeUndefined();
		const data = result.data as {
			playerValueHistory: Array<{
				changeDate: string;
			}>;
		} | null;

		expect(data).not.toBeNull();
		expect(data?.playerValueHistory).toHaveLength(3);
		expect(new Date(data?.playerValueHistory[0].changeDate ?? "").toISOString()).toBe(
			"2026-04-03T00:00:00.000Z"
		);
		expect(new Date(data?.playerValueHistory[1].changeDate ?? "").toISOString()).toBe(
			"2026-04-02T00:00:00.000Z"
		);
		expect(new Date(data?.playerValueHistory[2].changeDate ?? "").toISOString()).toBe(
			"2026-04-01T00:00:00.000Z"
		);
	});

	it("returns null transfer fields because player_values does not store them", async () => {
		const rows: HistoryRow[] = [
			{
				element_id: 10,
				value: 1010,
				last_value: 1000,
				change_date: "20260403",
			},
			{
				element_id: 10,
				value: 1000,
				last_value: 990,
				change_date: "20260402",
			},
		];

		const result = await graphql({
			schema: testSchema,
			source: historyQuery,
			contextValue: createGraphQLContext(rows),
			variableValues: { playerId: 10 },
		});

		expect(result.errors).toBeUndefined();
		const data = result.data as {
			playerValueHistory: Array<{
				transfersIn: number | null;
				transfersOut: number | null;
			}>;
		} | null;

		expect(data).not.toBeNull();
		expect(data?.playerValueHistory[0].transfersIn).toBeNull();
		expect(data?.playerValueHistory[0].transfersOut).toBeNull();
	});

	it("matches contract snapshot for response shape", async () => {
		const rows: HistoryRow[] = [
			{
				element_id: 10,
				value: 1020,
				last_value: 1010,
				change_date: "20260404",
			},
			{
				element_id: 10,
				value: 1010,
				last_value: 1000,
				change_date: "20260403",
			},
		];

		const result = await graphql({
			schema: testSchema,
			source: historyQuery,
			contextValue: createGraphQLContext(rows),
			variableValues: { playerId: 10 },
		});

		expect(result).toMatchSnapshot();
	});
});
