import { describe, expect, it } from "bun:test";
import { entryLiveRepository } from "../../../src/domains/entry-live/repository";
import { gqlCacheKey } from "../../../src/infra/cache-key";

const buildContext = (options: { cache?: string | null; rows?: unknown[] } = {}) => {
	const strings = new Map<string, string>();

	const redis = {
		get: async (key: string) => strings.get(key) ?? null,
		set: async (key: string, value: string) => {
			strings.set(key, value);
			return "OK";
		},
		del: async (key: string) => (strings.delete(key) ? 1 : 0),
	};

	const result = { data: options.rows ?? [], error: null };
	const data = {
		read: () => {
			const query = Promise.resolve(result);
			type Builder = typeof query & {
				select: () => Builder;
				eq: () => Builder;
				in: () => Builder;
				order: () => Builder;
				limit: () => Builder;
			};
			const builder = query as Builder;
			Object.assign(builder, {
				select: () => builder,
				eq: () => builder,
				in: () => builder,
				order: () => builder,
				limit: () => builder,
			});
			return builder;
		},
	};

	const context = {
		currentSeason: { seasonId: 2025, seasonCode: "2526" },
		dataRevision: "core-test",
		redis,
		data,
		logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
	} as never;
	if (options.cache !== undefined && options.cache !== null) {
		strings.set(gqlCacheKey(context, "entries:transfers:1:3"), options.cache);
	}
	return context;
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

	it("reads only the canonical transfer_time projection", async () => {
		const selected: string[] = [];
		const redis = {
			get: async () => null,
			set: async () => "OK",
			del: async () => 0,
		};
		const data = {
			read: () => {
				const builder = {
					select: (columns: string) => {
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
						const result = {
							data: [
								{
									entry_id: 1,
									event_id: 3,
									element_in_id: 20,
									element_in_cost: 55,
									element_out_id: 10,
									element_out_cost: 60,
									transfer_time: "2026-01-01T12:00:00Z",
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
			currentSeason: { seasonId: 2025, seasonCode: "2526" },
			dataRevision: "core-test",
			redis,
			data,
			logger: { warn: () => undefined, error: () => undefined },
		} as never;

		const transfers = await entryLiveRepository.getEntryEventTransfers(context, 1, 3);
		expect(selected).toEqual([
			"entry_id, event_id, element_in_id, element_in_cost, element_out_id, element_out_cost, transfer_time",
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
});

describe("entryLiveRepository batch picks", () => {
	it("reads the canonical pick, chip, and transfer-cost columns", async () => {
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
			currentSeason: { seasonId: 2025, seasonCode: "2526" },
			dataRevision: "core-test",
			redis: {
				get: async () => null,
				mget: async () => [null],
				del: async () => 0,
				pipeline: () => pipeline,
			},
			data: {
				read: () => {
					const result = {
						data: [
							{
								entry_id: 1,
								event_id: 3,
								picks: [
									{
										element: 10,
										position: 1,
										multiplier: 2,
										is_captain: true,
										is_vice_captain: false,
									},
								],
								chip: "bboost",
								transfers_cost: 4,
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

		expect(projection).toBe("entry_id, event_id, chip, picks, transfers_cost");
		expect(result.get(1)).toMatchObject({ chip: "bboost", transfersCost: 4 });
		expect(result.get(1)?.picks[0]).toMatchObject({ element: 10, isCaptain: true });
		expect(pipelineWrites).toHaveLength(1);
	});
});
