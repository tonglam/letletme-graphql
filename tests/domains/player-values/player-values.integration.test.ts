import { describe, expect, it } from "bun:test";
import { makeExecutableSchema } from "@graphql-tools/schema";
import { graphql } from "graphql";
import { DateResolver, DateTimeResolver } from "graphql-scalars";
import { playerValuesResolvers } from "../../../src/domains/player-values/resolvers";
import { playerValuesTypeDefs } from "../../../src/domains/player-values/schema";
import { playersTypeDefs } from "../../../src/domains/players/schema";
import { baseResolvers, baseTypeDefs } from "../../../src/graphql/base-schema";
import type { GraphQLContext } from "../../../src/graphql/context";

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

function createPlayerValuesQueryBuilder(rows: PlayerValueRow[]) {
	const eqFilters: Record<string, string | number> = {};

	const applyFilters = (): QueryResult<PlayerValueRow> => {
		let data = [...rows];

		if (eqFilters.change_date) {
			data = data.filter((row) => row.change_date === eqFilters.change_date);
		}

		return {
			data,
			error: null,
		};
	};

	let resolvePromise!: (value: QueryResult<PlayerValueRow>) => void;
	const promise = new Promise<QueryResult<PlayerValueRow>>((resolve) => {
		resolvePromise = resolve;
	});

	queueMicrotask(() => resolvePromise(applyFilters()));

	const builder = Object.assign(promise, {
		select(_columns: string) {
			return builder;
		},
		eq(column: string, value: string | number) {
			eqFilters[column] = value;
			return builder;
		},
		async limit(_value: number) {
			return applyFilters();
		},
	});

	return builder;
}

type ContextOptions = {
	redisHashData?: Record<string, string>;
	rows?: PlayerValueRow[];
};

function createGraphQLContext(
	options: ContextOptions = {},
): GraphQLContext & { calls: { supabaseFrom: number } } {
	const calls = { supabaseFrom: 0 };

	const supabase = {
		from: (_table: string) => {
			calls.supabaseFrom += 1;
			return createPlayerValuesQueryBuilder(options.rows ?? []);
		},
	} as unknown as GraphQLContext["supabase"];

	const redis = {
		get: async (): Promise<string | null> => null,
		set: async (): Promise<string> => "OK",
		hgetall: async (): Promise<Record<string, string>> =>
			options.redisHashData ?? {},
		hset: async (): Promise<number> => 1,
	} as unknown as GraphQLContext["redis"];

	const logger = {
		info: (): void => {},
		warn: (): void => {},
		error: (): void => {},
	} as unknown as GraphQLContext["logger"];

	return {
		supabase,
		redis,
		logger,
		calls,
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

const playerValuesQuery = `
  query PlayerValues($changeDate: Date!) {
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

describe("playerValues integration", () => {
	it("accepts a date-only changeDate value", async () => {
		const context = createGraphQLContext({
			rows: [
				{
					player_id: 136,
					player_name: "Thiago",
					team_id: 4,
					team_name: "Brentford",
					team_short_name: "BRE",
					position: "FWD",
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
					change_date: "20260421",
				},
			],
		});

		const result = await graphql({
			schema: testSchema,
			source: playerValuesQuery,
			contextValue: context,
			variableValues: { changeDate: "2026-04-21" },
		});

		expect(result.errors).toBeUndefined();
		const data = result.data as { playerValues: unknown[] } | null;
		expect(data?.playerValues).toHaveLength(1);
	});

	it("returns empty array when no rows match the exact changeDate", async () => {
		const context = createGraphQLContext({
			rows: [
				{
					player_id: 136,
					player_name: "Thiago",
					team_id: 4,
					team_name: "Brentford",
					team_short_name: "BRE",
					position: "FWD",
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
					change_date: "20260421",
				},
			],
		});

		const result = await graphql({
			schema: testSchema,
			source: playerValuesQuery,
			contextValue: context,
			variableValues: { changeDate: "2026-04-22" },
		});

		expect(result.errors).toBeUndefined();
		const data = result.data as { playerValues: unknown[] } | null;
		expect(data?.playerValues).toEqual([]);
		expect(context.calls.supabaseFrom).toBeGreaterThan(0);
	});

	it("still returns cached rows when the requested cache key exists", async () => {
		const context = createGraphQLContext({
			redisHashData: {
				"136": JSON.stringify({
					elementId: 136,
					webName: "Thiago",
					teamName: "Brentford",
					teamShortName: "BRE",
					elementTypeName: "FWD",
					value: 74,
					lastValue: 73,
				}),
			},
		});

		const result = await graphql({
			schema: testSchema,
			source: playerValuesQuery,
			contextValue: context,
			variableValues: { changeDate: "2026-04-21" },
		});

		expect(result.errors).toBeUndefined();
		const data = result.data as {
			playerValues: Array<{
				playerId: number;
				playerName: string;
				teamName: string;
				position: string;
				lastValue: number;
				value: number;
			}>;
		} | null;

		expect(data?.playerValues).toEqual([
			{
				playerId: 136,
				playerName: "Thiago",
				teamName: "Brentford",
				position: "FWD",
				lastValue: 73,
				value: 74,
			},
		]);
		expect(context.calls.supabaseFrom).toBe(0);
	});
});
