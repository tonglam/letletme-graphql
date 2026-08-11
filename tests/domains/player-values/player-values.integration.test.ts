import { describe, expect, it } from "bun:test";
import { makeExecutableSchema } from "@graphql-tools/schema";
import { graphql } from "graphql";
import { DateResolver, DateTimeResolver } from "graphql-scalars";
import { playerValuesResolvers } from "../../../src/domains/player-values/resolvers";
import { playerValuesTypeDefs } from "../../../src/domains/player-values/schema";
import { playersTypeDefs } from "../../../src/domains/players/schema";
import { baseResolvers, baseTypeDefs } from "../../../src/graphql/base-schema";
import type { GraphQLContext } from "../../../src/graphql/context";
import { gqlCacheKey } from "../../../src/infra/cache-key";
import {
	buildCorePublication,
	buildSnapshotContext,
	buildTestCoreData,
	TestRedis,
} from "../../helpers/data-publication";

type Row = Record<string, unknown>;
type QueryError = { message: string } | null;

const createQueryBuilder = (sourceRows: readonly Row[], error: QueryError = null) => {
	const equals = new Map<string, unknown>();
	const members = new Map<string, readonly unknown[]>();
	const applyFilters = () => ({
		data: sourceRows.filter((row) => {
			for (const [column, value] of equals) if (row[column] !== value) return false;
			for (const [column, values] of members) if (!values.includes(row[column])) return false;
			return true;
		}),
		error,
	});
	let resolve!: (value: ReturnType<typeof applyFilters>) => void;
	const promise = new Promise<ReturnType<typeof applyFilters>>((done) => {
		resolve = done;
	});
	queueMicrotask(() => resolve(applyFilters()));
	const builder = Object.assign(promise, {
		select: () => builder,
		eq: (column: string, value: unknown) => {
			equals.set(column, value);
			return builder;
		},
		in: (column: string, values: readonly unknown[]) => {
			members.set(column, values);
			return builder;
		},
		limit: async () => applyFilters(),
	});
	return builder;
};

type ReportingFixture = {
	changes: Row[];
	stats?: Row[];
	fixtureTeams?: Row[];
	error?: QueryError;
};

const createContext = (
	redis: TestRedis,
	fixture: ReportingFixture,
	dataRevision = "core-7"
): { context: GraphQLContext; reads: string[] } => {
	const reads: string[] = [];
	const context = buildSnapshotContext(redis, { dataRevision });
	context.data = {
		read: (table: string) => {
			reads.push(table);
			if (table === "reporting.player_value_changes") {
				return createQueryBuilder(fixture.changes, fixture.error);
			}
			if (table === "fpl.player_event_snapshots") {
				return createQueryBuilder(fixture.stats ?? []);
			}
			if (table === "fpl.player_fixture_stats") {
				return createQueryBuilder(fixture.fixtureTeams ?? []);
			}
			throw new Error(`Unexpected read model ${table}`);
		},
	} as never;
	return { context, reads };
};

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
			playerId playerName teamId teamName teamShortName position positionEnum
			price lastValue value points selectedBy transfersIn transfersOut
			netTransfers form totalPoints eventPoints
		}
	}
`;

const execute = (context: GraphQLContext) =>
	graphql({
		schema: testSchema,
		source: playerValuesQuery,
		contextValue: context,
		variableValues: { changeDate: "2026-08-09" },
	});

const changedRow = (value = 46, lastValue = 45): Row => ({
	season_id: 2026,
	change_date: "20260809",
	element_id: 1,
	element_type: 1,
	event_id: 1,
	value,
	last_value: lastValue,
	change_type: "rise",
});

const statsRow: Row = {
	season_id: 2026,
	event_id: 1,
	element_id: 1,
	total_points: 40,
	form: "2.1",
	transfers_in_event: 1000,
	transfers_out_event: 500,
	selected_by_percent: "12.5",
};

describe("playerValues GraphQL reporting contract", () => {
	it("reads the season-scoped reporting view, filters the baseline, and normally expires", async () => {
		const core = buildTestCoreData(1);
		core.players[0] = { ...core.players[0]!, teamId: 2 };
		core.players[11] = { ...core.players[11]!, teamId: 1 };
		const redis = new TestRedis(buildCorePublication("2627", 7, core));
		const { context, reads } = createContext(redis, {
			changes: [
				changedRow(),
				{
					season_id: 2026,
					change_date: "20260809",
					element_id: 2,
					element_type: 2,
					event_id: 1,
					value: 50,
					last_value: 0,
					change_type: "start",
				},
			],
			stats: [statsRow],
			fixtureTeams: [{ element_id: 1, event_id: 1, team_id: 1 }],
		});

		const first = await execute(context);
		const readsAfterFirst = [...reads];
		const second = await execute(context);

		expect(first.errors).toBeUndefined();
		expect(first.data?.playerValues).toEqual([
			{
				playerId: 1,
				playerName: "Player 1",
				teamId: 1,
				teamName: "Team 1",
				teamShortName: "T01",
				position: "GKP",
				positionEnum: "GOALKEEPER",
				price: 45,
				lastValue: 45,
				value: 46,
				points: 40,
				selectedBy: 12.5,
				transfersIn: 1000,
				transfersOut: 500,
				netTransfers: 500,
				form: 2.1,
				totalPoints: 40,
				eventPoints: null,
			},
		]);
		expect(second.data).toEqual(first.data);
		expect(readsAfterFirst).toEqual([
			"reporting.player_value_changes",
			"fpl.player_event_snapshots",
			"fpl.player_fixture_stats",
		]);
		expect(reads).toEqual(readsAfterFirst);
		const cacheWrite = redis.setCalls.find(([key]) => key.includes(":player-values-"));
		expect(cacheWrite?.[0]).toMatch(/^llm:gql:core-7:player-values-20260809:/);
		expect(cacheWrite?.slice(-2)).toEqual(["EX", 300]);
	});

	it("caches an empty reporting result only as a revisioned query result", async () => {
		const core = buildTestCoreData(1);
		const redis = new TestRedis(buildCorePublication("2627", 7, core));
		const { context, reads } = createContext(redis, { changes: [] });

		const first = await execute(context);
		const second = await execute(context);

		expect(first.errors).toBeUndefined();
		expect(first.data).toEqual({ playerValues: [] });
		expect(second.data).toEqual(first.data);
		expect(reads).toEqual(["reporting.player_value_changes"]);
		const cacheWrite = redis.setCalls.find(([key]) => key.includes(":player-values-"));
		expect(cacheWrite?.[1]).toBe("__pv:null__");
		expect(cacheWrite?.slice(-2)).toEqual(["EX", 300]);
		expect([...redis.values.keys()].some((key) => key.startsWith("PlayerValue"))).toBe(false);
	});

	it("evicts malformed query data and rebuilds it from the reporting source", async () => {
		const core = buildTestCoreData(1);
		const redis = new TestRedis(buildCorePublication("2627", 7, core));
		const { context, reads } = createContext(redis, {
			changes: [changedRow()],
			stats: [statsRow],
		});
		const key = gqlCacheKey(context, "player-values:20260809");
		redis.values.set(key, JSON.stringify([{ playerId: 1, lastValue: 0 }]));

		const result = await execute(context);

		expect(result.errors).toBeUndefined();
		expect((result.data?.playerValues as unknown[]).length).toBe(1);
		expect(reads).toContain("reporting.player_value_changes");
		expect(JSON.parse(redis.values.get(key) ?? "[]")).toEqual(
			expect.arrayContaining([expect.objectContaining({ playerId: 1, lastValue: 45 })])
		);
	});

	it("does not reuse a player-values query cache across core dataset revisions", async () => {
		const core7 = buildTestCoreData(1);
		const redis = new TestRedis(buildCorePublication("2627", 7, core7));
		const first = createContext(redis, {
			changes: [changedRow(46, 45)],
			stats: [statsRow],
		});
		const firstResult = await execute(first.context);

		const core8 = {
			...core7,
			players: core7.players.map((player) => (player.id === 1 ? { ...player, price: 46 } : player)),
		};
		const publication8 = buildCorePublication("2627", 8, core8);
		for (const [key, value] of publication8.store) redis.values.set(key, value);
		const second = createContext(
			redis,
			{ changes: [changedRow(47, 46)], stats: [statsRow] },
			"core-8"
		);
		const secondResult = await execute(second.context);

		expect(firstResult.data?.playerValues).toEqual([
			expect.objectContaining({ price: 45, value: 46, lastValue: 45 }),
		]);
		expect(secondResult.data?.playerValues).toEqual([
			expect.objectContaining({ price: 46, value: 47, lastValue: 46 }),
		]);
		const keys = redis.setCalls
			.map(([key]) => key)
			.filter((key) => key.includes(":player-values-"));
		expect(keys.some((key) => key.includes(":core-7:"))).toBe(true);
		expect(keys.some((key) => key.includes(":core-8:"))).toBe(true);
	});
});
