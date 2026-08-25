import { describe, expect, it } from "bun:test";
import { entryLiveBatchService } from "../../../src/domains/entry-live/batch-service";
import { entryLiveRepository } from "../../../src/domains/entry-live/repository";
import { entriesService } from "../../../src/domains/entries/service";
import { eventsService } from "../../../src/domains/events/service";
import type { LivePerformance } from "../../../src/domains/live/repository";
import type { GraphQLContext } from "../../../src/graphql/context";
import {
	buildCorePublication,
	buildLivePublication,
	buildSnapshotContext,
	buildTestCoreData,
	TestRedis,
} from "../../helpers/data-publication";

const completePick = (entryId: number, eventId: number, firstElement = 1) => ({
	eventId,
	entryId,
	chip: null,
	transfersCost: 0,
	picks: Array.from({ length: 15 }, (_, index) => ({
		eventId,
		entryId,
		element: firstElement + index,
		position: index + 1,
		multiplier: index === 0 ? 2 : index < 11 ? 1 : 0,
		isCaptain: index === 0,
		isViceCaptain: index === 1,
	})),
});

const livePerformance = (
	playerId: number,
	overrides: Partial<LivePerformance> = {}
): LivePerformance => ({
	eventId: 1,
	playerId,
	minutes: 90,
	goalsScored: 0,
	assists: 0,
	cleanSheets: 0,
	goalsConceded: 0,
	ownGoals: 0,
	penaltiesSaved: 0,
	penaltiesMissed: 0,
	yellowCards: 0,
	redCards: 0,
	saves: 0,
	bonus: 0,
	bps: 0,
	defensiveContribution: 0,
	starts: true,
	expectedGoals: null,
	expectedAssists: null,
	expectedGoalInvolvements: null,
	expectedGoalsConceded: null,
	inDreamTeam: false,
	totalPoints: 1,
	...overrides,
});

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
				bank: 1,
				teamValue: 100,
				pickList: [],
			});
			expect(result.meta.succeededCount).toBe(1);
		} finally {
			entriesService.getEntriesByIds = originalEntries;
			entriesService.getEntryEventResultsByEntryIds = originalPrevious;
			entryLiveRepository.getEntryEventPicksByIds = originalPicks;
		}
	});

	it("preserves a finalized official result when rich picks remain unavailable", async () => {
		const originalEntries = entriesService.getEntriesByIds;
		const originalResults = entriesService.getEntryEventResultsByEntryIds;
		const originalPicks = entryLiveRepository.getEntryEventPicksByIds;
		const originalEvent = eventsService.getEventById;
		const pickCalls: Array<{
			entryIds: number[];
			forceRefresh: boolean | undefined;
			finalizationRevision: string | undefined;
		}> = [];
		let finalEventRank = 79;
		entriesService.getEntriesByIds = async () =>
			new Map([
				[
					1001,
					{
						id: 1001,
						entryName: "Final Team",
						playerName: "Final Player",
						region: null,
						startedEvent: 1,
						overallPoints: 137,
						overallRank: 400,
						bank: 10,
						teamValue: 1000,
						totalTransfers: 2,
						lastEventId: 2,
						lastOverallPoints: 100,
						lastOverallRank: 500,
						lastTeamValue: 990,
						lastBank: 10,
					},
				],
			]);
		entriesService.getEntryEventResultsByEntryIds = async (_context, _entryIds, eventId) => {
			if (eventId === 1) {
				return new Map([
					[
						1001,
						{
							entryId: 1001,
							eventId: 1,
							eventPoints: 100,
							eventRank: 500,
							overallPoints: 100,
							overallRank: 500,
							eventTransfers: 0,
							eventTransfersCost: 0,
							eventNetPoints: 100,
							eventBenchPoints: 0,
							eventChip: null,
							eventPlayedCaptain: 1,
							eventCaptainPoints: 10,
							eventPicks: [],
							eventAutoSub: [],
							richSyncedAt: "2026-08-23T00:09:00.000Z",
							teamValue: 990,
							bank: 10,
						},
					],
				]);
			}
			return new Map([
				[
					1001,
					{
						entryId: 1001,
						eventId: 2,
						eventPoints: 41,
						eventRank: finalEventRank,
						overallPoints: 137,
						overallRank: 400,
						eventTransfers: 2,
						eventTransfersCost: 4,
						eventNetPoints: 37,
						eventBenchPoints: 8,
						eventChip: "bboost",
						eventPlayedCaptain: 1,
						eventCaptainPoints: 12,
						eventPicks: [],
						eventAutoSub: [],
						richSyncedAt: "2026-08-24T00:09:00.000Z",
						teamValue: 1000,
						bank: 10,
					},
				],
			]);
		};
		entryLiveRepository.getEntryEventPicksByIds = async (
			_context,
			entryIds,
			_eventId,
			forceRefresh,
			finalizationRevision
		) => {
			pickCalls.push({ entryIds: [...entryIds], forceRefresh, finalizationRevision });
			return new Map();
		};
		eventsService.getEventById = async () =>
			({ id: 2, finished: true, dataChecked: true }) as never;

		try {
			const result = await entryLiveBatchService.calcLivePointsForEntries(
				makeMockContext({}),
				2,
				[1001]
			);
			expect(result.results.get(1001)).toMatchObject({
				availability: "NO_PICKS",
				provisional: false,
				eventTransfers: 2,
				transferCost: 4,
				chip: "BENCH_BOOST",
				lastOverallPoints: 100,
				livePoints: 41,
				liveNetPoints: 37,
				liveTotalPoints: 137,
				score: {
					source: "FPL_FINAL_RESULT",
					state: "FINAL",
					checkedAt: "2026-08-24T00:09:00.000Z",
					upstreamUpdatedAt: "2026-08-24T00:09:00.000Z",
					reconciliation: "NO_LINEUP",
				},
			});
			const finalPickCall = pickCalls.find((call) => call.forceRefresh === false);
			expect(finalPickCall).toMatchObject({ entryIds: [1001], forceRefresh: false });
			expect(finalPickCall?.finalizationRevision).toMatch(/^event-result:2:[0-9a-f]{24}$/);
			const firstScoreRevision = result.results.get(1001)?.score.revision;
			finalEventRank = 80;
			const reranked = await entryLiveBatchService.calcLivePointsForEntries(
				makeMockContext({}),
				2,
				[1001]
			);
			expect(reranked.results.get(1001)?.score.revision).not.toBe(firstScoreRevision);
		} finally {
			entriesService.getEntriesByIds = originalEntries;
			entriesService.getEntryEventResultsByEntryIds = originalResults;
			entryLiveRepository.getEntryEventPicksByIds = originalPicks;
			eventsService.getEventById = originalEvent;
		}
	});

	it("keeps force-refreshing final picks while the durable result is not published", async () => {
		const originalEntries = entriesService.getEntriesByIds;
		const originalResults = entriesService.getEntryEventResultsByEntryIds;
		const originalPicks = entryLiveRepository.getEntryEventPicksByIds;
		const originalEvent = eventsService.getEventById;
		const calls: Array<{ forceRefresh?: boolean; finalizationRevision?: string }> = [];
		entriesService.getEntriesByIds = async () => new Map();
		entriesService.getEntryEventResultsByEntryIds = async () => new Map();
		entryLiveRepository.getEntryEventPicksByIds = async (
			_context,
			_entryIds,
			_eventId,
			forceRefresh,
			finalizationRevision
		) => {
			calls.push({ forceRefresh, finalizationRevision });
			return new Map();
		};
		eventsService.getEventById = async () =>
			({ id: 2, finished: true, dataChecked: true }) as never;

		try {
			await entryLiveBatchService.calcLivePointsForEntries(makeMockContext({}), 2, [1001]);
			expect(calls).toContainEqual({ forceRefresh: true, finalizationRevision: undefined });
		} finally {
			entriesService.getEntriesByIds = originalEntries;
			entriesService.getEntryEventResultsByEntryIds = originalResults;
			entryLiveRepository.getEntryEventPicksByIds = originalPicks;
			eventsService.getEventById = originalEvent;
		}
	});

	it("uses provisional full-time fixtures for live auto-subs and vice-captain scoring", async () => {
		const originalEntries = entriesService.getEntriesByIds;
		const originalTransfers = entryLiveRepository.getEntryEventTransfersByIds;
		const core = buildTestCoreData(1);
		const context = buildSnapshotContext(
			new TestRedis(
				buildCorePublication("2627", 7, core),
				buildLivePublication(core, 1, "2627", 8, {
					sourceCheckedAt: new Date().toISOString(),
				})
			)
		);
		const starterElements = [1, 2, 6, 10, 3, 7, 11, 14, 4, 8, 15];
		const benchElements = [12, 13, 18, 19];
		const elements = [...starterElements, ...benchElements];
		const picks = {
			eventId: 1,
			entryId: 101,
			chip: null,
			transfersCost: 0,
			picks: elements.map((element, index) => ({
				eventId: 1,
				entryId: 101,
				element,
				position: index + 1,
				multiplier: element === 4 ? 2 : index < 11 ? 1 : 0,
				isCaptain: element === 4,
				isViceCaptain: element === 3,
			})),
		};
		const liveByPlayer = new Map(
			elements.map((element) => {
				if (element === 4 || element === 12 || element === 18 || element === 19) {
					return [
						element,
						livePerformance(element, { minutes: 0, starts: false, totalPoints: 0 }),
					] as const;
				}
				if (element === 13) {
					return [element, livePerformance(element, { totalPoints: 6 })] as const;
				}
				return [element, livePerformance(element)] as const;
			})
		);
		const fixtures = core.fixtures
			.filter((fixture) => fixture.eventId === 1)
			.map((fixture) => ({
				...fixture,
				finished: false,
				finishedProvisional: true,
				started: true,
				minutes: 90,
			}));
		entriesService.getEntriesByIds = async () =>
			new Map([
				[
					101,
					{
						id: 101,
						entryName: "Projected XI",
						playerName: "Projected Manager",
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
					},
				],
			]);
		entryLiveRepository.getEntryEventTransfersByIds = async () => new Map();

		try {
			const result = await entryLiveBatchService.calcLivePointsForEntries(context, 1, [101], true, {
				liveByPlayer: Promise.resolve(liveByPlayer),
				fixtures: Promise.resolve(fixtures),
				teams: Promise.resolve(core.teams as never),
				picksByEntry: Promise.resolve(new Map([[101, picks]]) as never),
			});
			const calc = result.results.get(101);
			expect(calc).toMatchObject({
				provisional: true,
				livePoints: 17,
				liveNetPoints: 17,
				liveTotalPoints: 17,
				playedCaptain: 3,
				activeCaptain: { id: 3, points: 1 },
				score: {
					eventPoints: 17,
					netEventPoints: 17,
					totalPoints: 17,
					source: "FPL_EVENT_LIVE",
					reconciliation: "NOT_COMPARABLE",
				},
			});
			expect(calc?.score.revision).toContain("lineup:projected");
			expect(calc?.pickList.find((pick) => pick.element === 4)).toMatchObject({
				pickActive: false,
				multiplier: 0,
			});
			expect(calc?.pickList.find((pick) => pick.element === 13)).toMatchObject({
				pickActive: true,
				autoSub: true,
				multiplier: 1,
			});
		} finally {
			entriesService.getEntriesByIds = originalEntries;
			entryLiveRepository.getEntryEventTransfersByIds = originalTransfers;
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
					picksByEntry: Promise.resolve(new Map([[101, completePick(101, 1)]]) as never),
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
