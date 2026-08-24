import { describe, expect, it } from "bun:test";
import {
	entryLiveRepository,
	hasCompleteEntryEventPick,
} from "../../../src/domains/entry-live/repository";
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
									{
										element: 11,
										position: 2,
										is_captain: false,
										is_vice_captain: true,
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
		expect(result.get(1)?.picks).toHaveLength(1);
		expect(pipelineWrites).toHaveLength(1);
	});
});

describe("hasCompleteEntryEventPick", () => {
	const complete = () => ({
		eventId: 3,
		entryId: 1,
		chip: null,
		transfersCost: 0,
		picks: Array.from({ length: 15 }, (_, index) => ({
			eventId: 3,
			entryId: 1,
			element: index + 1,
			position: index + 1,
			multiplier: index === 0 ? 2 : index < 11 ? 1 : 0,
			isCaptain: index === 0,
			isViceCaptain: index === 1,
		})),
	});

	it("accepts one complete official 15-player squad", () => {
		expect(hasCompleteEntryEventPick(complete(), 3, 1)).toBe(true);
	});

	it("rejects partial, duplicated, or cross-entry squads", () => {
		const partial = complete();
		partial.picks.pop();
		expect(hasCompleteEntryEventPick(partial, 3, 1)).toBe(false);

		const duplicated = complete();
		duplicated.picks[14]!.element = duplicated.picks[13]!.element;
		expect(hasCompleteEntryEventPick(duplicated, 3, 1)).toBe(false);

		const crossEntry = complete();
		crossEntry.picks[0]!.entryId = 2;
		expect(hasCompleteEntryEventPick(crossEntry, 3, 1)).toBe(false);
	});

	it("rejects missing or impossible official multiplier distributions", () => {
		const missingMultiplier = complete();
		missingMultiplier.picks[2]!.multiplier = undefined as never;
		expect(hasCompleteEntryEventPick(missingMultiplier, 3, 1)).toBe(false);

		const tooManyStarters = complete();
		tooManyStarters.picks[11]!.multiplier = 1;
		expect(hasCompleteEntryEventPick(tooManyStarters, 3, 1)).toBe(false);

		const twoBoostedPlayers = complete();
		twoBoostedPlayers.picks[1]!.multiplier = 2;
		twoBoostedPlayers.picks[2]!.multiplier = 0;
		expect(hasCompleteEntryEventPick(twoBoostedPlayers, 3, 1)).toBe(false);

		const boostOutsideCaptaincy = complete();
		boostOutsideCaptaincy.picks[0]!.multiplier = 1;
		boostOutsideCaptaincy.picks[2]!.multiplier = 2;
		expect(hasCompleteEntryEventPick(boostOutsideCaptaincy, 3, 1)).toBe(false);
	});

	it("rejects a promoted vice-captain while the original captain remains active", () => {
		const impossiblePromotion = complete();
		impossiblePromotion.picks[0]!.multiplier = 1;
		impossiblePromotion.picks[1]!.multiplier = 2;

		expect(hasCompleteEntryEventPick(impossiblePromotion, 3, 1)).toBe(false);

		impossiblePromotion.picks[0]!.multiplier = 0;
		impossiblePromotion.picks[11]!.multiplier = 1;
		expect(hasCompleteEntryEventPick(impossiblePromotion, 3, 1)).toBe(true);
	});
});
