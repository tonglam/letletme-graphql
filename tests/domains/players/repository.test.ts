import { describe, expect, it } from "bun:test";
import { playersRepository } from "../../../src/domains/players/repository";
import {
	buildCorePublication,
	buildSnapshotContext,
	buildTestCoreData,
	TestRedis,
} from "../../helpers/data-publication";

const queryChain = <T>(result: T, methods: string[]) => {
	const promise = Promise.resolve(result) as Promise<T> &
		Record<string, (...args: unknown[]) => unknown>;
	for (const method of methods) promise[method] = () => promise;
	return promise;
};

describe("playersRepository v3 core reads", () => {
	it("pins one immutable core revision per request and exposes a newer revision to a new request", async () => {
		const core = buildTestCoreData(1);
		const redis = new TestRedis(buildCorePublication("2627", 7, core));
		const firstContext = buildSnapshotContext(redis, { dataRevision: "core-7" });

		expect(await playersRepository.getPlayerById(firstContext, 1)).toMatchObject({
			id: 1,
			price: 45,
		});

		const nextCore = {
			...core,
			players: core.players.map((player) => (player.id === 1 ? { ...player, price: 99 } : player)),
		};
		const nextPublication = buildCorePublication("2627", 8, nextCore);
		for (const [key, value] of nextPublication.store) redis.values.set(key, value);

		expect(await playersRepository.getPlayerById(firstContext, 1)).toMatchObject({ price: 45 });

		const nextContext = buildSnapshotContext(redis, { dataRevision: "core-8" });
		expect(await playersRepository.getPlayerById(nextContext, 1)).toMatchObject({ price: 99 });
		expect(
			await playersRepository.listPlayers(
				nextContext,
				{ teamId: 1, minPrice: 99, maxPrice: 99 },
				10,
				0
			)
		).toMatchObject([{ id: 1, price: 99 }]);
	});

	it("query-caches only the event-stat overlay under the core dataset revision", async () => {
		const core = buildTestCoreData(1);
		const redis = new TestRedis(buildCorePublication("2627", 7, core));
		const context = buildSnapshotContext(redis);
		let readCount = 0;
		context.data = {
			read: () => {
				readCount += 1;
				return queryChain(
					{ data: [{ total_points: 9, selected_by_percent: "4.2" }], error: null },
					["select", "eq", "limit"]
				);
			},
		} as never;

		const first = await playersRepository.getPlayerByIdForEvent(context, 1, 1);
		const second = await playersRepository.getPlayerByIdForEvent(context, 1, 1);

		expect(first).toMatchObject({ id: 1, price: 45, totalPoints: 9, selectedByPercent: 4.2 });
		expect(second).toEqual(first);
		expect(readCount).toBe(1);
		const cacheWrite = redis.setCalls.find(([key]) => key.includes(":players-event-stats:"));
		expect(cacheWrite?.[0]).toMatch(/^llm:v3:gql:v3:core-7:players-event-stats:/);
		expect(cacheWrite?.slice(-2)).toEqual(["EX", 3600]);
	});
});

describe("playersRepository.getPlayersForPicker", () => {
	it("uses the core publication, reporting stats, and a normally expiring query cache", async () => {
		const core = buildTestCoreData(null);
		const redis = new TestRedis(buildCorePublication("2627", 7, core));
		const context = buildSnapshotContext(redis);
		let marketReads = 0;
		context.data = {
			read: (table: string) => {
				if (table === "fpl.events") {
					return queryChain({ data: [], error: null }, ["select", "lte", "order", "limit"]);
				}
				if (table === "fpl.player_market_snapshots") {
					return {
						select: (fields: string) => {
							marketReads += 1;
							return fields === "snapshot_date, captured_at"
								? queryChain(
										{
											data: [
												{
													snapshot_date: "2026-08-09",
													captured_at: new Date().toISOString(),
												},
											],
											error: null,
										},
										["order", "limit"]
									)
								: queryChain(
										{ data: [{ element_id: 1, selected_by_percent: "74.6" }], error: null },
										["eq", "in"]
									);
						},
					};
				}
				throw new Error(`Unexpected reporting table ${table}`);
			},
		} as never;

		const first = await playersRepository.getPlayersForPicker(context, 1, null, "Player 1");
		const second = await playersRepository.getPlayersForPicker(context, 1, null, "Player 1");

		expect(first.items).toEqual([
			expect.objectContaining({ id: 1, price: 45, selectedByPercent: 74.6 }),
		]);
		expect(second).toEqual(first);
		expect(marketReads).toBe(2);
		const cacheWrite = redis.setCalls.find(([key]) => key.includes(":players-picker:"));
		expect(cacheWrite?.[0]).toMatch(/^llm:v3:gql:v3:core-7:players-picker:/);
		expect(cacheWrite?.slice(-2)).toEqual(["EX", 300]);
	});
});

describe("playersRepository top transfers", () => {
	it("returns no rows when every event transfer count is zero", async () => {
		const queryResult = {
			data: [
				{
					element_id: 1,
					event_id: 1,
					transfers_in_event: 0,
					transfers_out_event: 0,
				},
			],
			error: null,
		};
		const builder = {
			select: () => builder,
			eq: () => builder,
			not: () => builder,
			order: () => builder,
			limit: async () => queryResult,
		};
		const context = {
			currentSeason: { seasonId: 2026, seasonCode: "2627" },
			dataRevision: "core-7",
			data: { read: () => builder },
			logger: { error: () => undefined },
		} as never;

		expect(await playersRepository.getTopTransfersInEnriched(context, 1, 10)).toEqual({
			stats: [],
			players: {},
		});
		expect(await playersRepository.getTopTransfersOutEnriched(context, 1, 10)).toEqual({
			stats: [],
			players: {},
		});
	});
});
