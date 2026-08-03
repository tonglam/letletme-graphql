import { describe, expect, it } from "bun:test";
import { entriesRepository, type EntryEventResult } from "../../../src/domains/entries/repository";

const cachedResult: EntryEventResult = {
	entryId: 101,
	eventId: 32,
	eventPoints: 65,
	eventRank: 100,
	overallPoints: 1_900,
	overallRank: 2_000,
	eventTransfers: 1,
	eventTransfersCost: 0,
	eventNetPoints: 65,
	eventBenchPoints: 4,
	eventChip: null,
	eventPlayedCaptain: 10,
	eventCaptainPoints: 16,
	eventPicks: [],
	teamValue: 1_020,
	bank: 5,
};

describe("entriesRepository.getEntryEventResultsByEntryIds", () => {
	it("reuses the per-entry baseline cache before querying PostgreSQL", async () => {
		let databaseReads = 0;
		const context = {
			redis: {
				get: async (key: string) => (key === "Season:active" ? "2526" : null),
				mget: async () => [JSON.stringify(cachedResult)],
				del: async () => 0,
				pipeline: () => ({
					set() {
						return this;
					},
					exec: async () => [],
				}),
			},
			supabase: {
				from: () => {
					databaseReads += 1;
					throw new Error("database should not be read");
				},
			},
			logger: { warn: () => undefined, error: () => undefined },
		} as never;

		const results = await entriesRepository.getEntryEventResultsByEntryIds(context, [101], 32);

		expect(results.get(101)).toEqual(cachedResult);
		expect(databaseReads).toBe(0);
	});
});
