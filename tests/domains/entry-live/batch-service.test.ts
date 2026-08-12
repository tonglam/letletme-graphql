import { describe, expect, it } from "bun:test";
import { entryLiveBatchService } from "../../../src/domains/entry-live/batch-service";
import { entryLiveRepository } from "../../../src/domains/entry-live/repository";
import { entriesService } from "../../../src/domains/entries/service";
import type { LivePerformance } from "../../../src/domains/live/repository";
import type { GraphQLContext } from "../../../src/graphql/context";
import {
	buildCorePublication,
	buildLivePublication,
	buildSnapshotContext,
	buildTestCoreData,
	TestRedis,
} from "../../helpers/data-publication";

const makeMockContext = (options: {
	livePerformances?: Map<number, LivePerformance>;
	fixtures?: unknown[];
	teams?: unknown[];
	players?: unknown[];
	entries?: Map<number, unknown>;
	picks?: Map<number, unknown>;
	transfers?: Map<number, unknown>;
}): GraphQLContext => {
	const redisState = new Map<string, string>();
	const redisHashes = new Map<string, Record<string, string>>();

	const livePerformances = options.livePerformances ?? new Map();

	return {
		database: {
			query: async () => {
				throw new Error("Unexpected database query");
			},
		} as never,
		currentSeason: { seasonId: 2025, seasonCode: "2526" },
		redis: {
			get: async (key: string) => redisState.get(key) ?? null,
			set: async (key: string, value: string) => {
				redisState.set(key, value);
				return "OK";
			},
			hgetall: async (key: string) => redisHashes.get(key) ?? {},
			hget: async (key: string, field: string) => redisHashes.get(key)?.[field] ?? null,
			hmget: async (key: string, ...fields: string[]) => {
				const hash = redisHashes.get(key) ?? {};
				return fields.map((f) => hash[f] ?? null);
			},
			expire: async () => 1,
		} as never,
		data: {
			read: () => {
				const builder = {
					select: () => builder,
					eq: () => builder,
					in: () => builder,
					order: () => builder,
					limit: async () => ({ data: [], error: null }),
				};
				return builder;
			},
		} as never,
		logger: {
			info: () => undefined,
			warn: () => undefined,
			error: () => undefined,
		} as never,
		user: undefined,
		__livePerformances: livePerformances,
	} as GraphQLContext;
};

describe("entryLiveBatchService.calcLivePointsForEntries", () => {
	it("returns empty results for empty entry IDs", async () => {
		const context = makeMockContext({});
		const result = await entryLiveBatchService.calcLivePointsForEntries(context, 33, []);
		expect(result.results.size).toBe(0);
		expect(result.errors).toHaveLength(0);
		expect(result.meta.totalEntries).toBe(0);
		expect(result.meta.succeededCount).toBe(0);
	});

	it("populates meta correctly", async () => {
		const context = makeMockContext({});
		const result = await entryLiveBatchService.calcLivePointsForEntries(context, 33, []);
		expect(result.meta.eventId).toBe(33);
		expect(result.meta.totalEntries).toBe(0);
		expect(result.meta.failedCount).toBe(0);
	});

	it("rejects duplicate entry IDs before loading shared data", async () => {
		const context = makeMockContext({});
		expect(
			entryLiveBatchService.calcLivePointsForEntries(context, 33, [1001, 1001])
		).rejects.toMatchObject({ extensions: { code: "DUPLICATE_ENTRY_IDS" } });
	});

	it("returns NO_PICKS with entry metadata before heavy acquisition", async () => {
		const originalEntries = entriesService.getEntriesByIds;
		const originalPrevious = entriesService.getEntryEventResultsByEntryIds;
		const originalPicks = entryLiveRepository.getEntryEventPicksByIds;
		entriesService.getEntriesByIds = async () =>
			new Map([
				[
					1001,
					{
						id: 1001,
						entryName: "Batch Team",
						playerName: "Batch Player",
						region: null,
						startedEvent: 1,
						overallPoints: 99,
						overallRank: 100,
						bank: 10,
						teamValue: 1000,
						totalTransfers: 3,
						lastEventId: 34,
						lastOverallPoints: 90,
						lastOverallRank: 110,
						lastTeamValue: 990,
						lastBank: 10,
					},
				],
			]);
		entriesService.getEntryEventResultsByEntryIds = async () =>
			new Map([
				[
					1001,
					{
						eventId: 32,
						overallPoints: 90,
						overallRank: 110,
						teamValue: 990,
					},
				],
			]) as never;
		entryLiveRepository.getEntryEventPicksByIds = async () => new Map();

		try {
			const result = await entryLiveBatchService.calcLivePointsForEntries(
				makeMockContext({}),
				33,
				[1001]
			);
			expect(result.results.get(1001)).toMatchObject({
				availability: "NO_PICKS",
				snapshot: null,
				entryName: "Batch Team",
				playerName: "Batch Player",
				overallPoints: 99,
				lastOverallPoints: 90,
				lastOverallRank: 110,
				lastValue: 99,
				pickList: [],
			});
			expect(result.meta.succeededCount).toBe(1);
		} finally {
			entriesService.getEntriesByIds = originalEntries;
			entriesService.getEntryEventResultsByEntryIds = originalPrevious;
			entryLiveRepository.getEntryEventPicksByIds = originalPicks;
		}
	});

	it("preserves input order while propagating the pinned revision to ready results", async () => {
		const originalEntries = entriesService.getEntriesByIds;
		const originalTransfers = entryLiveRepository.getEntryEventTransfersByIds;
		const core = buildTestCoreData(1);
		const context = buildSnapshotContext(
			new TestRedis(buildCorePublication("2627", 7, core), buildLivePublication(core, 1, "2627", 8))
		);
		const entry = (id: number) => ({
			id,
			entryName: `Team ${id}`,
			playerName: `Player ${id}`,
			region: null,
			startedEvent: 1,
			overallPoints: 0,
			overallRank: null,
			bank: 0,
			teamValue: 1000,
			totalTransfers: 0,
			lastEventId: null,
			lastOverallPoints: null,
			lastOverallRank: null,
			lastTeamValue: null,
			lastBank: null,
		});
		entriesService.getEntriesByIds = async () =>
			new Map([
				[101, entry(101)],
				[202, entry(202)],
			]);
		entryLiveRepository.getEntryEventTransfersByIds = async () => new Map();
		const pick = (element: number) => ({
			chip: null,
			transfersCost: 0,
			picks: [
				{
					element,
					position: 1,
					multiplier: 1,
					isCaptain: false,
					isViceCaptain: false,
				},
			],
		});

		try {
			const result = await entryLiveBatchService.calcLivePointsForEntries(
				context,
				1,
				[101, 202],
				true,
				{
					liveByPlayer: Promise.resolve(new Map()),
					fixtures: Promise.resolve([]),
					teams: Promise.resolve(core.teams as never),
					picksByEntry: Promise.resolve(new Map([[101, pick(1)]]) as never),
				}
			);

			expect([...result.results.keys()]).toEqual([101, 202]);
			expect([...result.results.values()].map((value) => value.availability)).toEqual([
				"READY",
				"NO_PICKS",
			]);
			expect(result.results.get(101)?.snapshot?.revision).toBe("8");
			expect(result.results.get(202)?.snapshot).toBeNull();
		} finally {
			entriesService.getEntriesByIds = originalEntries;
			entryLiveRepository.getEntryEventTransfersByIds = originalTransfers;
		}
	});
});
