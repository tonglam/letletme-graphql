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

	it("returns PostgreSQL baselines when the best-effort cache write fails", async () => {
		const warnings: string[] = [];
		const context = {
			redis: {
				get: async (key: string) => (key === "Season:active" ? "2526" : null),
				mget: async () => {
					throw new Error("redis unavailable");
				},
				pipeline: () => ({
					set() {
						return this;
					},
					exec: async () => {
						throw new Error("redis still unavailable");
					},
				}),
			},
			supabase: {
				from: () => ({
					select: () => ({
						in: () => ({
							eq: async () => ({
								data: [
									{
										entry_id: cachedResult.entryId,
										event_id: cachedResult.eventId,
										event_points: cachedResult.eventPoints,
										event_rank: cachedResult.eventRank,
										overall_points: cachedResult.overallPoints,
										overall_rank: cachedResult.overallRank,
										event_transfers: cachedResult.eventTransfers,
										event_transfers_cost: cachedResult.eventTransfersCost,
										event_net_points: cachedResult.eventNetPoints,
										event_bench_points: cachedResult.eventBenchPoints,
										event_chip: cachedResult.eventChip,
										event_played_captain: cachedResult.eventPlayedCaptain,
										event_captain_points: cachedResult.eventCaptainPoints,
										event_picks: cachedResult.eventPicks,
										team_value: cachedResult.teamValue,
										bank: cachedResult.bank,
									},
								],
								error: null,
							}),
						}),
					}),
				}),
			},
			logger: {
				warn: (_details: unknown, message: string) => warnings.push(message),
				error: () => undefined,
			},
		} as never;

		const results = await entriesRepository.getEntryEventResultsByEntryIds(context, [101], 32);

		expect(results.get(101)).toEqual(cachedResult);
		expect(warnings).toContain("Failed to batch read entry event caches");
		expect(warnings).toContain("Failed to cache entry event baselines");
	});
});

describe("entriesRepository EntryInfo cache validation", () => {
	it("falls back when a cached optional numeric field changes type", async () => {
		const context = {
			redis: {
				get: async () => "2526",
				hget: async () =>
					JSON.stringify({
						entryName: "Cached Team",
						playerName: "Manager",
						lastEventId: null,
						overallRank: "unknown",
					}),
			},
			supabase: {
				from: () => ({
					select: () => ({
						eq: () => ({
							limit: async () => ({
								data: [
									{
										id: 101,
										entry_name: "Authoritative Team",
										player_name: "Manager",
										region: null,
										started_event: null,
										overall_points: null,
										overall_rank: 123,
										bank: null,
										team_value: null,
										total_transfers: null,
										last_event_id: null,
										last_overall_points: null,
										last_overall_rank: null,
										last_team_value: null,
										last_bank: null,
									},
								],
								error: null,
							}),
						}),
					}),
				}),
			},
			logger: { warn: () => undefined, error: () => undefined },
		} as never;

		const result = await entriesRepository.getEntryById(context, 101);

		expect(result?.entryName).toBe("Authoritative Team");
		expect(result?.overallRank).toBe(123);
	});

	it("falls back when a cached entry name is missing", async () => {
		const context = {
			redis: {
				get: async () => "2526",
				hget: async () =>
					JSON.stringify({
						entryName: "",
						playerName: "Manager",
						lastEventId: null,
					}),
			},
			supabase: {
				from: () => ({
					select: () => ({
						eq: () => ({
							limit: async () => ({
								data: [
									{
										id: 101,
										entry_name: "Authoritative Team",
										player_name: "Manager",
										region: null,
										started_event: null,
										overall_points: null,
										overall_rank: null,
										bank: null,
										team_value: null,
										total_transfers: null,
										last_event_id: null,
										last_overall_points: null,
										last_overall_rank: null,
										last_team_value: null,
										last_bank: null,
									},
								],
								error: null,
							}),
						}),
					}),
				}),
			},
			logger: { warn: () => undefined, error: () => undefined },
		} as never;

		const result = await entriesRepository.getEntryById(context, 101);

		expect(result?.entryName).toBe("Authoritative Team");
	});
});
