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
	last_value: number | null;
	points: number;
	selected_by: number;
	transfers_in: number;
	transfers_out: number;
	net_transfers: number;
	form: number | null;
	total_points: number;
	event_points: number | null;
	change_date: string;
	change_type?: string | null;
};

type QueryResult<T> = {
	data: T[] | null;
	error: { message: string } | null;
};

function createPlayerValuesQueryBuilder(
	rows: PlayerValueRow[],
	error: { message: string } | null = null
) {
	const eqFilters: Record<string, string | number> = {};

	const applyFilters = (): QueryResult<PlayerValueRow> => {
		let data = [...rows];

		if (eqFilters.change_date) {
			data = data.filter((row) => row.change_date === eqFilters.change_date);
		}

		return {
			data,
			error,
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
		in(_column: string, _values: unknown[]) {
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
	redisStrings?: Record<string, string>;
	redisType?: string;
	rows?: PlayerValueRow[];
	supabaseError?: { message: string };
};

function createGraphQLContext(options: ContextOptions = {}): GraphQLContext & {
	calls: { redisCommands: string[]; supabaseFrom: number };
} {
	const calls = { redisCommands: [] as string[], supabaseFrom: 0 };

	const supabase = {
		from: (_table: string) => {
			calls.supabaseFrom += 1;
			return createPlayerValuesQueryBuilder(options.rows ?? [], options.supabaseError ?? null);
		},
	} as unknown as GraphQLContext["supabase"];

	const pipeline = {
		del: (...keys: string[]) => {
			calls.redisCommands.push(`pipeline.del:${keys.join(",")}`);
			return pipeline;
		},
		hset: (key: string) => {
			calls.redisCommands.push(`pipeline.hset:${key}`);
			return pipeline;
		},
		set: (key: string, value: string, mode: string, ttl: number) => {
			calls.redisCommands.push(`pipeline.set:${key}:${value}:${mode}:${ttl}`);
			return pipeline;
		},
		exec: async () => [],
	};

	const redis = {
		type: async (): Promise<string> =>
			options.redisType ??
			(options.redisHashData && Object.keys(options.redisHashData).length > 0 ? "hash" : "none"),
		get: async (key: string): Promise<string | null> =>
			options.redisStrings?.[key] ?? (key === "Season:active" ? "2526" : null),
		set: async (key: string, value: string, mode?: string, ttl?: number): Promise<string> => {
			calls.redisCommands.push(`set:${key}:${value}:${mode}:${ttl}`);
			return "OK";
		},
		hgetall: async (): Promise<Record<string, string>> => options.redisHashData ?? {},
		pipeline: () => pipeline,
	} as unknown as GraphQLContext["redis"];

	const logger = {
		debug: (): void => {},
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
	  eventPoints
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

	it("merges compact and ISO rows for the same change date", async () => {
		const baseRow = {
			team_id: 4,
			team_name: "Brentford",
			team_short_name: "BRE",
			position: "FWD",
			price: 74,
			last_value: 73,
			points: 0,
			selected_by: 1.2,
			transfers_in: 1000,
			transfers_out: 500,
			net_transfers: 500,
			form: 2.1,
			total_points: 40,
			event_points: 0,
			change_type: "rise",
		};
		const context = createGraphQLContext({
			rows: [
				{
					...baseRow,
					player_id: 136,
					player_name: "Thiago",
					value: 74,
					change_date: "20260421",
				},
				{
					...baseRow,
					player_id: 351,
					player_name: "Salah",
					value: 125,
					change_date: "2026-04-21",
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
		const data = result.data as { playerValues: Array<{ playerId: number }> } | null;
		expect(data?.playerValues.map((row) => row.playerId).sort()).toEqual([136, 351]);
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
				eventPoints: number | null;
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
				eventPoints: null,
			},
		]);
		expect(context.calls.supabaseFrom).toBe(0);
	});

	it("migrates the legacy null sentinel to a bounded negative-cache key", async () => {
		const context = createGraphQLContext({
			redisType: "string",
			redisStrings: { "PlayerValue:20260421": "__pv:null__" },
		});

		const result = await graphql({
			schema: testSchema,
			source: playerValuesQuery,
			contextValue: context,
			variableValues: { changeDate: "2026-04-21" },
		});

		expect(result.errors).toBeUndefined();
		expect(result.data).toEqual({ playerValues: [] });
		expect(context.calls.supabaseFrom).toBe(0);
		expect(context.calls.redisCommands).toContain("set:PlayerValueMissing:20260421:1:EX:600");
	});

	it("returns a negative-cache hit without querying Supabase", async () => {
		const context = createGraphQLContext({
			redisStrings: { "PlayerValueMissing:20260421": "1" },
		});

		const result = await graphql({
			schema: testSchema,
			source: playerValuesQuery,
			contextValue: context,
			variableValues: { changeDate: "2026-04-21" },
		});

		expect(result.errors).toBeUndefined();
		expect(result.data).toEqual({ playerValues: [] });
		expect(context.calls.supabaseFrom).toBe(0);
	});

	it("does not negative-cache a Supabase failure", async () => {
		const context = createGraphQLContext({
			supabaseError: { message: "database unavailable" },
		});

		const result = await graphql({
			schema: testSchema,
			source: playerValuesQuery,
			contextValue: context,
			variableValues: { changeDate: "2026-04-21" },
		});

		expect(result.errors?.[0]?.message).toBe("database unavailable");
		expect(context.calls.redisCommands).toEqual([]);
	});

	it("filters season-baseline Start rows out of cached hashes", async () => {
		const context = createGraphQLContext({
			redisHashData: {
				"19": JSON.stringify({
					elementId: 19,
					webName: "Zubimendi",
					teamName: "Arsenal",
					elementTypeName: "MID",
					value: 55,
					lastValue: 0,
					changeType: "Start",
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
		expect(result.data).toEqual({ playerValues: [] });
		expect(context.calls.supabaseFrom).toBe(0);
		// No missing-marker write: the marker is only consulted when the shared
		// key is absent, so writing it while a hash exists would be dead work.
		expect(context.calls.redisCommands.some((cmd) => cmd.includes("PlayerValueMissing"))).toBe(
			false
		);
	});

	it("keeps real changes while dropping Start rows from cached hashes", async () => {
		const context = createGraphQLContext({
			redisHashData: {
				"19": JSON.stringify({
					elementId: 19,
					webName: "Zubimendi",
					teamName: "Arsenal",
					elementTypeName: "MID",
					value: 55,
					lastValue: 0,
					changeType: "Start",
				}),
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
			playerValues: Array<{ playerId: number; lastValue: number }>;
		} | null;
		expect(data?.playerValues).toHaveLength(1);
		expect(data?.playerValues[0]).toMatchObject({ playerId: 136, lastValue: 73 });
		expect(context.calls.supabaseFrom).toBe(0);
	});

	it("filters Start rows from the database fallback and negative-caches the day", async () => {
		const context = createGraphQLContext({
			rows: [
				{
					player_id: 19,
					player_name: "Zubimendi",
					team_id: 1,
					team_name: "Arsenal",
					position: "MID",
					price: 55,
					value: 55,
					last_value: 0,
					points: 0,
					selected_by: 10.1,
					transfers_in: 0,
					transfers_out: 0,
					net_transfers: 0,
					form: null,
					total_points: 0,
					event_points: null,
					change_date: "20260421",
					change_type: "start",
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
		expect(result.data).toEqual({ playerValues: [] });
		expect(context.calls.redisCommands).toContain("set:PlayerValueMissing:20260421:1:EX:600");
	});

	it("keeps legacy database rows with NULL change_type and a positive last_value", async () => {
		const context = createGraphQLContext({
			rows: [
				{
					player_id: 136,
					player_name: "Thiago",
					team_id: 4,
					team_name: "Brentford",
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
					change_type: null,
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
		const data = result.data as { playerValues: Array<{ playerId: number }> } | null;
		expect(data?.playerValues).toHaveLength(1);
		expect(data?.playerValues[0]?.playerId).toBe(136);
	});

	it("filters stale season-baseline rows from the private cache", async () => {
		const context = createGraphQLContext({
			redisStrings: {
				"gql:v2:2526:player-values:20260421": JSON.stringify([
					{
						playerId: 19,
						playerName: "Zubimendi",
						teamName: "Arsenal",
						position: "MID",
						value: 55,
						lastValue: 0,
					},
					{
						playerId: 136,
						playerName: "Thiago",
						teamName: "Brentford",
						position: "FWD",
						value: 74,
						lastValue: 73,
					},
				]),
			},
		});

		const result = await graphql({
			schema: testSchema,
			source: playerValuesQuery,
			contextValue: context,
			variableValues: { changeDate: "2026-04-21" },
		});

		expect(result.errors).toBeUndefined();
		const data = result.data as { playerValues: Array<{ playerId: number }> } | null;
		expect(data?.playerValues).toHaveLength(1);
		expect(data?.playerValues[0]?.playerId).toBe(136);
		expect(context.calls.supabaseFrom).toBe(0);
	});

	it("falls back when a shared hash row contains invalid numeric fields", async () => {
		const context = createGraphQLContext({
			redisHashData: {
				"136": JSON.stringify({
					playerId: 136,
					playerName: "Thiago",
					teamName: "Brentford",
					position: "FWD",
					price: "unknown",
					value: 74,
					lastValue: 73,
				}),
			},
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
					selected_by: 0,
					transfers_in: 0,
					transfers_out: 0,
					net_transfers: 0,
					form: null,
					total_points: 0,
					event_points: null,
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
		expect((result.data as { playerValues: Array<{ playerId: number }> }).playerValues).toEqual([
			expect.objectContaining({ playerId: 136 }),
		]);
		expect(context.calls.supabaseFrom).toBeGreaterThan(0);
	});

	it("falls back when a legacy string row contains invalid numeric fields", async () => {
		const context = createGraphQLContext({
			redisType: "string",
			redisStrings: {
				"PlayerValue:20260421": JSON.stringify([
					{
						playerId: 136,
						playerName: "Thiago",
						teamName: "Brentford",
						position: "FWD",
						price: "unknown",
						value: 74,
						lastValue: 73,
					},
				]),
			},
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
					selected_by: 0,
					transfers_in: 0,
					transfers_out: 0,
					net_transfers: 0,
					form: null,
					total_points: 0,
					event_points: null,
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
		expect((result.data as { playerValues: Array<{ playerId: number }> }).playerValues).toEqual([
			expect.objectContaining({ playerId: 136 }),
		]);
		expect(context.calls.supabaseFrom).toBeGreaterThan(0);
	});
});
