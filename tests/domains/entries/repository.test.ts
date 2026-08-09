import { describe, expect, it } from "bun:test";
import {
	entriesRepository,
	type Entry,
	type EntryEventResult,
} from "../../../src/domains/entries/repository";

const entryRow = (id: number) => ({
	id,
	entry_name: `Entry ${id}`,
	player_name: `Manager ${id}`,
	region: null,
	started_event: 1,
	overall_points: 100,
	overall_rank: 200,
	bank: 5,
	team_value: 1_000,
	total_transfers: 2,
	last_event_id: 1,
	last_overall_points: 100,
	last_overall_rank: 200,
	last_team_value: 1_000,
	last_bank: 5,
});

describe("entriesRepository.getEntriesByIds", () => {
	it("uses one revisioned cache namespace and one PostgreSQL batch for misses", async () => {
		const readKeys: string[] = [];
		const writtenKeys: string[] = [];
		let databaseReads = 0;
		const context = {
			currentSeason: { seasonId: 2026, seasonCode: "2627" },
			dataRevision: "core-17",
			redis: {
				mget: async (...keys: string[]) => {
					readKeys.push(...keys);
					return keys.map(() => null);
				},
				del: async () => 0,
				pipeline: () => {
					const pipeline = {
						set: (key: string) => {
							writtenKeys.push(key);
							return pipeline;
						},
						exec: async () => [],
					};
					return pipeline;
				},
			},
			data: {
				read: (relation: string) => {
					expect(relation).toBe("competition.entries");
					databaseReads += 1;
					return {
						select: () => ({
							in: async (_column: string, ids: number[]) => ({
								data: ids.map(entryRow),
								error: null,
							}),
						}),
					};
				},
			},
			logger: { warn: () => undefined, error: () => undefined },
		} as never;

		const entries = await entriesRepository.getEntriesByIds(context, [101, 102, 101, 0, 1.5]);

		expect(databaseReads).toBe(1);
		expect([...entries.keys()]).toEqual([101, 102]);
		expect(readKeys).toHaveLength(2);
		expect(writtenKeys).toHaveLength(2);
		for (const key of [...readKeys, ...writtenKeys]) {
			expect(key.startsWith("llm:v3:gql:v3:core-17:entries-info:")).toBe(true);
			expect(key).not.toContain("EntryInfo:");
		}
	});

	it("accepts only a cached entry whose identity matches the requested ID", async () => {
		const cached: Entry = {
			id: 101,
			entryName: "One",
			playerName: "Manager",
			region: null,
			startedEvent: 1,
			overallPoints: 1,
			overallRank: 2,
			bank: 3,
			teamValue: 4,
			totalTransfers: 5,
			lastEventId: 1,
			lastOverallPoints: 1,
			lastOverallRank: 2,
			lastTeamValue: 4,
			lastBank: 3,
		};
		const context = {
			currentSeason: { seasonId: 2026, seasonCode: "2627" },
			dataRevision: "core-17",
			redis: {
				mget: async () => [JSON.stringify(cached)],
				del: async () => 0,
			},
			data: {
				read: () => {
					throw new Error("database should not be read");
				},
			},
			logger: { warn: () => undefined, error: () => undefined },
		} as never;

		expect(await entriesRepository.getEntryById(context, 101)).toEqual(cached);
	});
});

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
			currentSeason: { seasonId: 2025, seasonCode: "2526" },
			dataRevision: "core-test",
			redis: {
				mget: async () => [JSON.stringify(cachedResult)],
				del: async () => 0,
				pipeline: () => ({
					set() {
						return this;
					},
					exec: async () => [],
				}),
			},
			data: {
				read: () => {
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
			currentSeason: { seasonId: 2025, seasonCode: "2526" },
			dataRevision: "core-test",
			redis: {
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
			data: {
				read: () => ({
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
