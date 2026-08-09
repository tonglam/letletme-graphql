import { describe, expect, it } from "bun:test";
import { entryLiveRepository } from "../../../src/domains/entry-live/repository";

const buildContext = (
	options: { cache?: string | null; legacyCache?: string | null; rows?: unknown[] } = {}
) => {
	const strings = new Map<string, string>();
	strings.set("Season:active", "2526");
	if (options.cache !== undefined && options.cache !== null) {
		strings.set("gql:v2:2526:entries:transfers:v3:1:3", options.cache);
	}
	if (options.legacyCache !== undefined && options.legacyCache !== null) {
		strings.set("gql:v2:2526:entries:transfers:v2:1:3", options.legacyCache);
	}

	const redis = {
		get: async (key: string) => strings.get(key) ?? null,
		set: async (key: string, value: string) => {
			strings.set(key, value);
			return "OK";
		},
		del: async (key: string) => (strings.delete(key) ? 1 : 0),
	};

	const result = { data: options.rows ?? [], error: null };
	const supabase = {
		from: () => {
			const query = Promise.resolve(result);
			type Builder = typeof query & {
				select: () => Builder;
				eq: () => Builder;
				in: () => Builder;
				order: () => Builder;
				range: () => Builder;
				limit: () => Builder;
			};
			const builder = query as Builder;
			Object.assign(builder, {
				select: () => builder,
				eq: () => builder,
				in: () => builder,
				order: () => builder,
				range: () => builder,
				limit: () => builder,
			});
			return builder;
		},
	};

	return {
		redis,
		supabase,
		logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
	} as never;
};

describe("entryLiveRepository transfers", () => {
	it("returns every transfer in canonical transfer_time order", async () => {
		const context = buildContext({
			rows: [
				{
					entry_id: "1",
					event_id: "3",
					element_in_id: "20",
					element_in_cost: "55",
					element_out_id: "10",
					element_out_cost: "60",
					transfer_time: "2026-01-02T12:00:00Z",
				},
				{
					entry_id: 1,
					event_id: 3,
					element_in_id: 30,
					element_in_cost: 57,
					element_out_id: 20,
					element_out_cost: 55,
					transfer_time: "2026-01-01T12:00:00Z",
				},
			],
		});

		const transfers = await entryLiveRepository.getEntryEventTransfers(context, 1, 3);
		expect(transfers).toHaveLength(2);
		expect(transfers.map((row) => row.elementIn)).toEqual([30, 20]);
		expect(transfers.every((row) => row.eventId === 3 && row.entryId === 1)).toBe(true);
	});

	it("evicts malformed cache and retries the database", async () => {
		const context = buildContext({
			cache: "not-json",
			rows: [
				{
					entry_id: 1,
					event_id: 3,
					element_in_id: 20,
					element_in_cost: 55,
					element_out_id: 10,
					element_out_cost: 60,
					transfer_time: null,
				},
			],
		});

		const transfers = await entryLiveRepository.getEntryEventTransfers(context, 1, 3);
		expect(transfers).toHaveLength(1);
		expect(transfers[0]?.elementIn).toBe(20);
	});

	it("falls back to a historical transfer time column", async () => {
		const selected: string[] = [];
		const redis = {
			get: async (key: string) => (key === "Season:active" ? "2526" : null),
			set: async () => "OK",
			del: async () => 0,
		};
		const supabase = {
			from: () => {
				let projection = "";
				const builder = {
					select: (columns: string) => {
						projection = columns;
						selected.push(columns);
						return builder;
					},
					eq: () => builder,
					in: () => builder,
					order: () => builder,
					then: <TResult1 = unknown, TResult2 = never>(
						onfulfilled?: ((value: unknown) => TResult1 | PromiseLike<TResult1>) | null,
						onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
					) => {
						const result = projection.includes("transfer_time")
							? {
									data: null,
									error: {
										code: "42703",
										message: "column entry_event_transfers.transfer_time does not exist",
									},
								}
							: {
									data: [
										{
											entry_id: 1,
											event_id: 3,
											element_in_id: 20,
											element_in_cost: 55,
											element_out_id: 10,
											element_out_cost: 60,
											time: "2026-01-01T12:00:00Z",
										},
									],
									error: null,
								};
						return Promise.resolve(result).then(onfulfilled, onrejected);
					},
				};
				return builder;
			},
		};
		const context = {
			redis,
			supabase,
			logger: { warn: () => undefined, error: () => undefined },
		} as never;

		const transfers = await entryLiveRepository.getEntryEventTransfers(context, 1, 3);
		expect(selected.slice(0, 2)).toEqual([
			"entry_id, event_id, element_in_id, element_in_cost, element_out_id, element_out_cost, transfer_time",
			"entry_id, event_id, element_in_id, element_in_cost, element_out_id, element_out_cost, time",
		]);
		expect(transfers[0]?.time).toBe("2026-01-01T12:00:00Z");
	});

	it("rejects stored transfers that are missing official costs", async () => {
		const context = buildContext({
			rows: [
				{
					entry_id: 1,
					event_id: 3,
					element_in_id: 20,
					element_in_cost: null,
					element_out_id: 10,
					element_out_cost: 60,
					transfer_time: null,
				},
			],
		});

		await expect(entryLiveRepository.getEntryEventTransfers(context, 1, 3)).rejects.toThrow(
			"Stored transfer costs are missing"
		);
	});

	it("ignores legacy v2 transfer caches that did not contain official costs", async () => {
		const context = buildContext({
			legacyCache: JSON.stringify([
				{ entryId: 1, eventId: 3, elementIn: 99, elementOut: 98, time: null },
			]),
			rows: [
				{
					entry_id: 1,
					event_id: 3,
					element_in_id: 20,
					element_in_cost: 55,
					element_out_id: 10,
					element_out_cost: 60,
					transfer_time: null,
				},
			],
		});

		const transfers = await entryLiveRepository.getEntryEventTransfers(context, 1, 3);
		expect(transfers[0]).toMatchObject({
			elementIn: 20,
			elementInCost: 55,
			elementOutCost: 60,
		});
	});
});

describe("entryLiveRepository batch picks", () => {
	it("preserves legacy pick, chip, and transfer-cost columns", async () => {
		let projection = "";
		const pipelineWrites: unknown[][] = [];
		const pipeline = {
			set: (...args: unknown[]) => {
				pipelineWrites.push(args);
				return pipeline;
			},
			exec: async () => [],
		};
		const context = {
			redis: {
				get: async (key: string) => (key === "Season:active" ? "2526" : null),
				mget: async () => [null],
				del: async () => 0,
				pipeline: () => pipeline,
			},
			supabase: {
				from: () => {
					const result = {
						data: [
							{
								entry_id: 1,
								event_id: 3,
								pick_list: [
									{
										element: 10,
										position: 1,
										multiplier: 2,
										is_captain: true,
										is_vice_captain: false,
									},
								],
								active_chip: "bboost",
								event_transfers_cost: 4,
							},
						],
						error: null,
					};
					const query = Promise.resolve(result);
					const builder = Object.assign(query, {
						select: (columns: string) => {
							projection = columns;
							return builder;
						},
						in: () => builder,
						eq: () => builder,
					});
					return builder;
				},
			},
			logger: { warn: () => undefined, error: () => undefined },
		} as never;

		const result = await entryLiveRepository.getEntryEventPicksByIds(context, [1], 3);

		expect(projection).toBe("*");
		expect(result.get(1)).toMatchObject({ chip: "bboost", transfersCost: 4 });
		expect(result.get(1)?.picks[0]).toMatchObject({ element: 10, isCaptain: true });
		expect(pipelineWrites).toHaveLength(1);
	});
});
