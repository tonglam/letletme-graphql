import { describe, expect, it } from "bun:test";
import { playersRepository } from "../../../src/domains/players/repository";

describe("playersRepository.getPlayersForPicker", () => {
	it("uses the bounded server-side search RPC when a query is present", async () => {
		const calls: Array<{ name: string; params: Record<string, unknown> }> = [];
		const context = {
			redis: {
				get: async (key: string) => (key === "Season:active" ? "2627" : null),
				hmget: async () => [
					JSON.stringify({
						code: 26686,
						webName: "Haaland",
						teamId: 12,
						type: 4,
						price: 145,
						startPrice: 145,
					}),
				],
				set: async () => "OK",
				del: async () => 1,
			},
			supabase: {
				from: () => {
					const result = Promise.resolve({ data: [], error: null });
					type Builder = typeof result & {
						select: () => Builder;
						eq: () => Builder;
						gte: () => Builder;
						lt: () => Builder;
						lte: () => Builder;
						order: () => Builder;
						limit: () => Builder;
					};
					const builder = result as Builder;
					Object.assign(builder, {
						select: () => builder,
						eq: () => builder,
						gte: () => builder,
						lt: () => builder,
						lte: () => builder,
						order: () => builder,
						limit: () => builder,
					});
					return builder;
				},
				rpc: async (name: string, params: Record<string, unknown>) => {
					calls.push({ name, params });
					return {
						data: [
							{
								id: 9,
								web_name: "Haaland",
								element_type: 4,
								team_id: 12,
								team_name: "Manchester City",
								team_short_name: "MCI",
							},
						],
						error: null,
					};
				},
			},
			logger: { warn: () => undefined, error: () => undefined },
		} as never;

		const result = await playersRepository.getPlayersForPicker(context, 12, null, "Haal");

		expect(result.items[0]).toMatchObject({ id: 9, webName: "Haaland" });
		expect(calls).toEqual([
			{
				name: "search_players_for_picker",
				params: {
					p_query: "Haal",
					p_limit: 100,
					p_cursor: null,
					p_position: null,
					p_team_id: null,
					p_min_price: null,
					p_max_price: null,
				},
			},
		]);
	});

	it("uses the latest complete market snapshot for picker ownership", async () => {
		const chain = <T>(result: T, methods: string[]) => {
			const promise = Promise.resolve(result) as Promise<T> &
				Record<string, (...args: unknown[]) => unknown>;
			for (const method of methods) promise[method] = () => promise;
			return promise;
		};
		const context = {
			redis: {
				get: async (key: string) => (key === "Season:active" ? "2627" : null),
				hmget: async () => [
					JSON.stringify({
						code: 26686,
						webName: "Haaland",
						teamId: 12,
						type: 4,
						price: 155,
						startPrice: 155,
						selectedByPercent: 1.2,
					}),
				],
				set: async () => "OK",
				del: async () => 1,
			},
			supabase: {
				from: (table: string) => {
					if (table === "player_market_snapshots") {
						return {
							select: (fields: string) =>
								fields === "snapshot_date, captured_at"
									? chain(
											{
												data: [
													{
														snapshot_date: "2026-08-08",
														captured_at: new Date().toISOString(),
													},
												],
												error: null,
											},
											["eq", "gte", "lt", "order", "limit"]
										)
									: chain(
											{
												data: [
													{
														element_id: 9,
														selected_by_percent: "74.6",
														captured_at: new Date().toISOString(),
													},
												],
												error: null,
											},
											["eq", "gte", "lt", "in", "order"]
										),
						};
					}
					return chain({ data: [], error: null }, ["select", "lte", "order", "limit"]);
				},
				rpc: async () => ({
					data: [
						{
							id: 9,
							web_name: "Haaland",
							element_type: 4,
							team_id: 12,
							team_name: "Manchester City",
							team_short_name: "MCI",
						},
					],
					error: null,
				}),
			},
			logger: { warn: () => undefined, error: () => undefined },
		} as never;

		const result = await playersRepository.getPlayersForPicker(context, 20, null, "Haaland");

		expect(result.items[0]).toMatchObject({
			id: 9,
			price: 155,
			selectedByPercent: 74.6,
		});
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
			supabase: { from: () => builder },
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

describe("playersRepository.getPlayerById", () => {
	it("reads the latest Player hash price on every call", async () => {
		let price = 75;
		const redis = {
			get: async (key: string) => (key === "Season:active" ? "2526" : null),
			hget: async () =>
				JSON.stringify({
					code: 101,
					webName: "Fresh Player",
					teamId: 1,
					type: 3,
					price,
					startPrice: 70,
				}),
		};
		const context = {
			redis,
			supabase: { from: () => Promise.reject(new Error("unexpected database query")) },
			logger: { warn: () => undefined, error: () => undefined },
		} as never;

		expect(await playersRepository.getPlayerById(context, 10)).toMatchObject({ price: 75 });
		price = 76;
		expect(await playersRepository.getPlayerById(context, 10)).toMatchObject({ price: 76 });
	});
});

describe("playersRepository.listPlayers", () => {
	it("queries PostgreSQL for each price-filtered read", async () => {
		let price = 75;
		let queryCount = 0;
		const filters: Array<[string, number]> = [];
		const supabase = {
			from: () => {
				queryCount += 1;
				const builder = {
					select: () => builder,
					eq: () => builder,
					gte: (column: string, value: number) => {
						filters.push([column, value]);
						return builder;
					},
					lte: (column: string, value: number) => {
						filters.push([column, value]);
						return builder;
					},
					order: () => builder,
					range: async () => ({
						data: [
							{
								id: 10,
								code: 101,
								web_name: "Listed Player",
								first_name: "Listed",
								second_name: "Player",
								team_id: 1,
								type: 3,
								price,
								start_price: 70,
							},
						],
						error: null,
					}),
				};
				return builder;
			},
		};
		const context = {
			redis: {},
			supabase,
			logger: { warn: () => undefined, error: () => undefined },
		} as never;

		const first = await playersRepository.listPlayers(
			context,
			{ minPrice: 70, maxPrice: 80 },
			10,
			0
		);
		price = 76;
		const second = await playersRepository.listPlayers(
			context,
			{ minPrice: 70, maxPrice: 80 },
			10,
			0
		);

		expect(first[0].price).toBe(75);
		expect(second[0].price).toBe(76);
		expect(queryCount).toBe(2);
		expect(filters).toEqual([
			["price", 70],
			["price", 80],
			["price", 70],
			["price", 80],
		]);
	});
});

describe("playersRepository.getPlayerByIdForEvent", () => {
	it("returns the fresh base player without caching it when event-stat enrichment fails", async () => {
		const cache = new Map<string, string>([["Season:active", "2526"]]);
		const writes: string[] = [];
		const redis = {
			get: async (key: string) => cache.get(key) ?? null,
			hget: async () =>
				JSON.stringify({
					code: 101,
					webName: "Base Player",
					teamId: 1,
					type: 3,
					price: 75,
					startPrice: 70,
					totalPoints: 42,
				}),
			set: async (key: string, value: string) => {
				cache.set(key, value);
				writes.push(key);
				return "OK";
			},
			del: async () => 0,
		};

		const queryResult = { data: null, error: { message: "player_stats unavailable" } };
		const supabase = {
			from: () => {
				const query = Promise.resolve(queryResult);
				type Builder = typeof query & {
					select: () => Builder;
					eq: () => Builder;
					limit: () => Builder;
				};
				const builder = query as Builder;
				Object.assign(builder, {
					select: () => builder,
					eq: () => builder,
					limit: () => builder,
				});
				return builder;
			},
		};

		const context = {
			redis,
			supabase,
			logger: { warn: () => undefined, error: () => undefined },
		} as never;

		const player = await playersRepository.getPlayerByIdForEvent(context, 10, 12);
		expect(player).toMatchObject({ id: 10, webName: "Base Player", totalPoints: 42 });
		expect(writes).toEqual([]);
	});

	it("combines a cached event-stat overlay with the latest Player hash price", async () => {
		const cache = new Map<string, string>([["Season:active", "2526"]]);
		let price = 75;
		const redis = {
			get: async (key: string) => cache.get(key) ?? null,
			hget: async () =>
				JSON.stringify({
					code: 101,
					webName: "Fresh Price",
					teamId: 1,
					type: 3,
					price,
					startPrice: 70,
				}),
			set: async (key: string, value: string) => {
				cache.set(key, value);
				return "OK";
			},
			del: async () => 0,
		};
		const result = { data: [{ total_points: 9, selected_by_percent: "4.2" }], error: null };
		const supabase = {
			from: () => {
				const query = Promise.resolve(result);
				type Builder = typeof query & {
					select: () => Builder;
					eq: () => Builder;
					limit: () => Builder;
				};
				const builder = query as Builder;
				Object.assign(builder, {
					select: () => builder,
					eq: () => builder,
					limit: () => builder,
				});
				return builder;
			},
		};
		const context = {
			redis,
			supabase,
			logger: { warn: () => undefined, error: () => undefined },
		} as never;

		const first = await playersRepository.getPlayerByIdForEvent(context, 10, 12);
		expect(first).toMatchObject({ price: 75, totalPoints: 9, selectedByPercent: 4.2 });
		expect(cache.has("gql:v2:2526:players:event-stats:v1:10:12")).toBe(true);

		price = 76;
		const second = await playersRepository.getPlayerByIdForEvent(context, 10, 12);
		expect(second).toMatchObject({ price: 76, totalPoints: 9, selectedByPercent: 4.2 });
	});
});

describe("playersRepository.getPlayersByIdsForEvent", () => {
	it("reuses cached stats but always reads the current base prices", async () => {
		let prices = new Map([
			[1, 50],
			[2, 60],
		]);
		const overlay = (id: number) =>
			JSON.stringify({ totalPoints: id * 3, selectedByPercent: id / 10 });
		const redis = {
			get: async (key: string) => (key === "Season:active" ? "2526" : null),
			hmget: async (_key: string, ...ids: string[]) =>
				ids.map((rawId) => {
					const id = Number(rawId);
					return JSON.stringify({
						code: 1000 + id,
						webName: `Player ${id}`,
						teamId: 1,
						type: 3,
						price: prices.get(id),
						startPrice: 50,
					});
				}),
			mget: async (...keys: string[]) => keys.map((key) => overlay(Number(key.split(":").at(-2)))),
			del: async () => 0,
		};
		const context = {
			redis,
			supabase: { from: () => Promise.reject(new Error("unexpected database query")) },
			logger: { warn: () => undefined, error: () => undefined },
		} as never;

		const first = await playersRepository.getPlayersByIdsForEvent(context, [1, 2], 4);
		expect(first.get(1)).toMatchObject({ price: 50, totalPoints: 3 });
		expect(first.get(2)).toMatchObject({ price: 60, totalPoints: 6 });

		prices = new Map([
			[1, 51],
			[2, 59],
		]);
		const second = await playersRepository.getPlayersByIdsForEvent(context, [1, 2], 4);
		expect(second.get(1)).toMatchObject({ price: 51, totalPoints: 3 });
		expect(second.get(2)).toMatchObject({ price: 59, totalPoints: 6 });
	});
});
