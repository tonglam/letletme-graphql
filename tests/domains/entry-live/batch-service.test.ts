import { describe, expect, it } from "bun:test";
import {
	calcLivePointsForEntriesInChunks,
	entryLiveBatchService,
	normalizeChip,
} from "../../../src/domains/entry-live/batch-service";
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

const originalFetch = globalThis.fetch;
const originalDataUrl = process.env.LETLETME_DATA_URL;

const installManagerLiveResponse = (
	eventId: number,
	rows: readonly Record<string, unknown>[],
	requestedEntryIds: readonly number[] = rows.flatMap((row) =>
		typeof row.entryId === "number" ? [row.entryId] : []
	)
) => {
	process.env.LETLETME_DATA_URL = "http://manager-live.test";
	const checkedAt = new Date().toISOString();
	const rowEntryIds = new Set(
		rows.flatMap((row) => (typeof row.entryId === "number" ? [row.entryId] : []))
	);
	const missingEntryIds = requestedEntryIds.filter((entryId) => !rowEntryIds.has(entryId));
	globalThis.fetch = (async () =>
		new Response(
			JSON.stringify({
				success: true,
				data: {
					season: "2627",
					eventId,
					checkedAt,
					servedAt: checkedAt,
					calculationMode: rows[0]?.calculationMode ?? "PROJECTED_AUTOSUBS",
					rows,
					missingEntryIds,
					partial: missingEntryIds.length > 0,
					errorCode: null,
					nextRefreshAt: new Date(Date.parse(checkedAt) + 30_000).toISOString(),
				},
			}),
			{ status: 200, headers: { "content-type": "application/json" } }
		)) as unknown as typeof fetch;
};

const restoreManagerLiveResponse = (): void => {
	globalThis.fetch = originalFetch;
	if (originalDataUrl === undefined) delete process.env.LETLETME_DATA_URL;
	else process.env.LETLETME_DATA_URL = originalDataUrl;
};

const managerRow = (
	entryId: number,
	eventId: number,
	overrides: Record<string, unknown> = {}
): Record<string, unknown> => {
	const now = new Date().toISOString();
	const source = overrides.source ?? "FPL_EVENT_LIVE";
	const calculationMode = overrides.calculationMode ?? "PROJECTED_AUTOSUBS";
	return {
		season: "2627",
		eventId,
		entryId,
		eventPoints: 17,
		netEventPoints: 17,
		totalPoints: 17,
		totalScope: "OVERALL",
		eventRank: null,
		overallRank: null,
		leagueRank: null,
		transferCost: 0,
		eventPointSemantics: "ZERO_COST_EQUIVALENT",
		source,
		revision: `score-${entryId}`,
		checkedAt: now,
		upstreamUpdatedAt: now,
		staleAt: new Date(Date.parse(now) + 90_000).toISOString(),
		calculationMode,
		algorithmVersion: calculationMode === "FINAL_RESULT" ? null : "fpl-projected-autosubs-v1",
		provenance: {
			scoreSource: source,
			calculationMode,
			algorithmVersion: calculationMode === "FINAL_RESULT" ? null : "fpl-projected-autosubs-v1",
			inputRevision: `input-${entryId}`,
			scoreRevision: `score-${entryId}`,
			rankRevision: null,
			livePublicationId:
				calculationMode === "FINAL_RESULT" ? null : "00000000-0000-4000-8000-000000000008",
			liveRevision: calculationMode === "FINAL_RESULT" ? null : "8",
			liveCheckedAt: calculationMode === "FINAL_RESULT" ? null : now,
			picksRevision: `picks-${entryId}`,
			picksCheckedAt: now,
			previousTotalsRevision: `totals-${entryId}`,
			previousTotalsThroughEventId: eventId > 1 ? eventId - 1 : null,
			resultRevision: calculationMode === "FINAL_RESULT" ? `result-${entryId}` : null,
			resultCheckedAt: calculationMode === "FINAL_RESULT" ? now : null,
			dataCheckedAt: calculationMode === "FINAL_RESULT" ? now : null,
			rankSource: null,
			rankCheckedAt: null,
		},
		...overrides,
	};
};

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
	it("canonicalizes the manager chip and its persisted AM alias", () => {
		expect(normalizeChip("MANAGER")).toBe("MANAGER");
		expect(normalizeChip("AM")).toBe("MANAGER");
	});

	it("fails closed when the effective lineup has the wrong player membership", async () => {
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
		const picks = completePick(101, 1);
		const liveByPlayer = new Map(
			picks.picks.map((pick) => [pick.element, livePerformance(pick.element)] as const)
		);
		const effectiveLineup = picks.picks.map((pick, index) => ({
			elementId: index === 14 ? 16 : pick.element,
			position: pick.position,
			sourceMultiplier: pick.multiplier,
			effectiveMultiplier: pick.multiplier,
			pickActive: pick.multiplier > 0,
			autoSub: false,
			isCaptain: pick.isCaptain,
			isViceCaptain: pick.isViceCaptain,
			captainForScoring: pick.isCaptain,
		}));
		entriesService.getEntriesByIds = async () =>
			new Map([
				[
					101,
					{
						id: 101,
						entryName: "Membership Team",
						playerName: "Membership Player",
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
		installManagerLiveResponse(1, [
			managerRow(101, 1, {
				eventPoints: 0,
				netEventPoints: 0,
				totalPoints: 0,
				effectiveLineup,
			}),
		]);
		try {
			const result = await entryLiveBatchService.calcLivePointsForEntries(context, 1, [101], {
				liveByPlayer: Promise.resolve(liveByPlayer),
				fixtures: Promise.resolve([]),
				teams: Promise.resolve(core.teams as never),
				picksByEntry: Promise.resolve(new Map([[101, picks]]) as never),
			});
			const calc = result.results.get(101);
			expect(calc?.availability).toBe("LINEUP_UNAVAILABLE");
			expect(calc?.score.reconciliation).toBe("NO_LINEUP");
			expect(calc?.score.reasonCodes).toContain("MISSING_LINEUP");
			expect(calc?.pickList).toEqual([]);
			expect(calc?.snapshot).toBeNull();
		} finally {
			restoreManagerLiveResponse();
			entriesService.getEntriesByIds = originalEntries;
			entryLiveRepository.getEntryEventTransfersByIds = originalTransfers;
		}
	});

	it("clears all detail fields when headline reconciliation fails", async () => {
		const originalEntries = entriesService.getEntriesByIds;
		const originalTransfers = entryLiveRepository.getEntryEventTransfersByIds;
		const core = buildTestCoreData(1);
		const context = buildSnapshotContext(
			new TestRedis(buildCorePublication("2627", 7, core), buildLivePublication(core, 1, "2627", 8))
		);
		const picks = completePick(101, 1);
		const liveByPlayer = new Map(
			picks.picks.map((pick) => [pick.element, livePerformance(pick.element)] as const)
		);
		const effectiveLineup = picks.picks.map((pick) => ({
			elementId: pick.element,
			position: pick.position,
			sourceMultiplier: pick.multiplier,
			effectiveMultiplier: pick.multiplier,
			pickActive: pick.multiplier > 0,
			autoSub: false,
			isCaptain: pick.isCaptain,
			isViceCaptain: pick.isViceCaptain,
			captainForScoring: pick.isCaptain,
		}));
		entriesService.getEntriesByIds = async () =>
			new Map([
				[
					101,
					{
						id: 101,
						entryName: "Skew Team",
						playerName: "Skew Player",
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
		installManagerLiveResponse(1, [
			managerRow(101, 1, {
				eventPoints: 99,
				netEventPoints: 99,
				totalPoints: 99,
				effectiveLineup,
			}),
		]);
		try {
			const result = await entryLiveBatchService.calcLivePointsForEntries(context, 1, [101], {
				liveByPlayer: Promise.resolve(liveByPlayer),
				fixtures: Promise.resolve([]),
				teams: Promise.resolve(core.teams as never),
				picksByEntry: Promise.resolve(new Map([[101, picks]]) as never),
			});
			const calc = result.results.get(101);
			expect(calc?.score.reconciliation).toBe("SOURCE_SKEW");
			expect(calc).toMatchObject({
				availability: "LINEUP_UNAVAILABLE",
				pickList: [],
				activeCaptain: { id: 0, name: "", points: 0 },
				snapshot: null,
				played: 0,
				toPlay: 0,
				playedCaptain: 0,
				captainName: "",
			});
		} finally {
			restoreManagerLiveResponse();
			entriesService.getEntriesByIds = originalEntries;
			entryLiveRepository.getEntryEventTransfersByIds = originalTransfers;
		}
	});

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

	it("calculates a large cohort in bounded, ordered chunks", async () => {
		const originalCalc = entryLiveBatchService.calcLivePointsForEntries;
		const calls: number[][] = [];
		let active = 0;
		let maxActive = 0;
		entryLiveBatchService.calcLivePointsForEntries = async (_context, eventId, entryIds) => {
			active += 1;
			maxActive = Math.max(maxActive, active);
			calls.push([...entryIds]);
			await Promise.resolve();
			active -= 1;
			const results = new Map(
				entryIds.map((entryId) => [entryId, { entry: entryId, event: eventId } as never])
			);
			return {
				results,
				errors: [],
				meta: {
					eventId,
					totalEntries: entryIds.length,
					succeededCount: entryIds.length,
					failedCount: 0,
				},
			};
		};
		try {
			const entryIds = Array.from({ length: 1001 }, (_, index) => index + 1);
			const checkedAt = new Date().toISOString();
			const result = await calcLivePointsForEntriesInChunks(makeMockContext({}), 33, entryIds, {
				managerScores: {
					season: "2627",
					rows: new Map(
						entryIds.map((entryId) => [
							entryId,
							{
								entryId,
								source: "FPL_EVENT_LIVE",
								provenance: { livePublicationId: "pub", liveRevision: "1" },
							} as never,
						])
					),
					errorCode: null,
					managerRevision: "manager-revision",
					dataAvailability: "FRESH",
					servedFrom: "POSTGRES",
					refreshQueued: false,
					missingEntryIds: [],
					checkedAt,
					tournamentCoverage: null,
					nextRefreshAt: checkedAt,
				},
			});
			expect(calls.map((chunk) => chunk.length)).toEqual([500, 500, 1]);
			expect(maxActive).toBeLessThanOrEqual(2);
			expect([...result.results.keys()]).toEqual(entryIds);
			expect(result.meta).toEqual({
				eventId: 33,
				totalEntries: 1001,
				succeededCount: 1001,
				failedCount: 0,
			});
		} finally {
			entryLiveBatchService.calcLivePointsForEntries = originalCalc;
		}
	});

	it("rejects an unverified mixed manager revision before calculating chunks", async () => {
		const originalCalc = entryLiveBatchService.calcLivePointsForEntries;
		let calls = 0;
		entryLiveBatchService.calcLivePointsForEntries = async () => {
			calls += 1;
			throw new Error("must not calculate an incoherent cohort");
		};
		try {
			const now = new Date().toISOString();
			const result = await calcLivePointsForEntriesInChunks(makeMockContext({}), 33, [1, 2], {
				managerScores: {
					season: "2627",
					rows: new Map([
						[
							1,
							{
								entryId: 1,
								source: "FPL_EVENT_LIVE",
								provenance: { livePublicationId: "p", liveRevision: "1" },
							} as never,
						],
						[
							2,
							{
								entryId: 2,
								source: "FPL_EVENT_LIVE",
								provenance: { livePublicationId: "p", liveRevision: "2" },
							} as never,
						],
					]),
					errorCode: null,
					managerRevision: "mixed",
					dataAvailability: "FRESH",
					servedFrom: "POSTGRES",
					refreshQueued: false,
					missingEntryIds: [],
					checkedAt: now,
					tournamentCoverage: null,
					nextRefreshAt: now,
				},
			});
			expect(calls).toBe(0);
			expect(result.results.size).toBe(0);
			expect(result.errors.map((error) => error.entryId)).toEqual([1, 2]);
			expect(result.meta.failedCount).toBe(2);
		} finally {
			entryLiveBatchService.calcLivePointsForEntries = originalCalc;
		}
	});

	it("keeps available rows when a cache-only cohort has cold entries", async () => {
		const originalCalc = entryLiveBatchService.calcLivePointsForEntries;
		let receivedPrefetched: Record<string, unknown> | undefined;
		const receivedEntryIds: number[][] = [];
		entryLiveBatchService.calcLivePointsForEntries = async (
			_context,
			eventId,
			entryIds,
			prefetched
		) => {
			receivedPrefetched = prefetched as Record<string, unknown>;
			receivedEntryIds.push([...entryIds]);
			return {
				results: new Map(
					entryIds.map((entryId) => [entryId, { entry: entryId, event: eventId } as never])
				),
				errors: [],
				meta: {
					eventId,
					totalEntries: entryIds.length,
					succeededCount: entryIds.length,
					failedCount: 0,
				},
			};
		};
		try {
			const now = new Date().toISOString();
			const result = await calcLivePointsForEntriesInChunks(makeMockContext({}), 33, [1, 2, 3], {
				entriesById: new Map([
					[1, {} as never],
					[2, {} as never],
					[3, {} as never],
				]),
				liveRef: { publicationId: "pub", revision: "1" },
				managerScores: {
					season: "2627",
					rows: new Map([
						[
							1,
							{
								entryId: 1,
								source: "FPL_EVENT_LIVE",
								provenance: { livePublicationId: "pub", liveRevision: "1" },
							} as never,
						],
						[
							2,
							{
								entryId: 2,
								source: "FPL_EVENT_LIVE",
								provenance: { livePublicationId: "pub", liveRevision: "1" },
							} as never,
						],
					]),
					errorCode: "INPUT_INCOMPLETE",
					managerRevision: "partial",
					dataAvailability: "PARTIAL",
					servedFrom: "POSTGRES",
					refreshQueued: true,
					missingEntryIds: [3],
					checkedAt: now,
					tournamentCoverage: null,
					nextRefreshAt: now,
				},
			});
			expect([...result.results.keys()]).toEqual([1, 2, 3]);
			expect(result.errors.map((error) => error.entryId)).toEqual([3]);
			expect(result.meta.succeededCount).toBe(2);
			expect(result.meta.failedCount).toBe(1);
			expect(receivedEntryIds).toEqual([[1, 2]]);
			expect(result.results.get(3)?.availability).toBe("LINEUP_UNAVAILABLE");
			expect(result.results.get(3)?.score.reasonCodes).toContain("UPSTREAM_UNAVAILABLE");
			expect(receivedPrefetched?.allowPartialManagerScores).toBe(true);
			expect((receivedPrefetched?.managerScores as { errorCode?: unknown })?.errorCode).toBe(
				"INPUT_INCOMPLETE"
			);
		} finally {
			entryLiveBatchService.calcLivePointsForEntries = originalCalc;
		}
	});

	it("rejects duplicate entry IDs before loading shared data", async () => {
		const context = makeMockContext({});
		expect(
			entryLiveBatchService.calcLivePointsForEntries(context, 33, [1001, 1001])
		).rejects.toMatchObject({ extensions: { code: "DUPLICATE_ENTRY_IDS" } });
	});

	it("starts the authoritative manager request before independent entry reads finish", async () => {
		const originalEntries = entriesService.getEntriesByIds;
		let releaseEntries = (): void => undefined;
		let entryReadSettled = false;
		entriesService.getEntriesByIds = async () =>
			new Promise((resolve) => {
				releaseEntries = () => {
					entryReadSettled = true;
					resolve(new Map());
				};
			});
		installManagerLiveResponse(1, [], [1001]);
		const managerFetch = globalThis.fetch;
		let signalManagerRequest = (): void => undefined;
		const managerRequestStarted = new Promise<void>((resolve) => {
			signalManagerRequest = resolve;
		});
		let managerStartedBeforeEntries = false;
		globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
			managerStartedBeforeEntries = !entryReadSettled;
			signalManagerRequest();
			return managerFetch(...args);
		}) as typeof fetch;

		const calculation = entryLiveBatchService.calcLivePointsForEntries(
			makeMockContext({}),
			1,
			[1001],
			{
				picksByEntry: Promise.resolve(new Map()),
			}
		);

		try {
			const requestStartedPromptly = await Promise.race([
				managerRequestStarted.then(() => true),
				new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 250)),
			]);
			releaseEntries();
			const result = await calculation;

			expect(requestStartedPromptly).toBe(true);
			expect(managerStartedBeforeEntries).toBe(true);
			expect(result.results.get(1001)?.availability).toBe("NO_PICKS");
		} finally {
			releaseEntries();
			await calculation.catch(() => undefined);
			restoreManagerLiveResponse();
			entriesService.getEntriesByIds = originalEntries;
		}
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
				pickList: [],
				score: { source: "UNAVAILABLE", reconciliation: "NO_LINEUP" },
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
			({
				id: 2,
				finished: true,
				dataChecked: true,
				dataCheckedAt: "2026-08-24T00:00:00.000Z",
			}) as never;
		installManagerLiveResponse(2, [
			managerRow(1001, 2, {
				source: "FPL_FINAL_RESULT",
				calculationMode: "FINAL_RESULT",
				algorithmVersion: null,
				eventPoints: 41,
				netEventPoints: 37,
				totalPoints: 137,
				transferCost: 4,
				eventPointSemantics: "GROSS",
				revision: "final-score-1001-79",
				checkedAt: "2026-08-24T00:09:00.000Z",
				upstreamUpdatedAt: "2026-08-24T00:09:00.000Z",
				eventRank: finalEventRank,
				provenance: {
					scoreSource: "FPL_FINAL_RESULT",
					calculationMode: "FINAL_RESULT",
					algorithmVersion: null,
					inputRevision: "input-1001",
					scoreRevision: "score-1001",
					rankRevision: "rank-1001",
					livePublicationId: null,
					liveRevision: null,
					liveCheckedAt: null,
					picksRevision: "picks-1001",
					picksCheckedAt: "2026-08-24T00:09:00.000Z",
					previousTotalsRevision: null,
					previousTotalsThroughEventId: 1,
					resultRevision: "result-1001",
					resultCheckedAt: "2026-08-24T00:09:00.000Z",
					dataCheckedAt: "2026-08-24T00:00:00.000Z",
					rankSource: null,
					rankCheckedAt: null,
				},
			}),
		]);

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
			expect(pickCalls.some((call) => call.finalizationRevision !== undefined)).toBe(false);
			const firstScoreRevision = result.results.get(1001)?.score.revision;
			finalEventRank = 80;
			restoreManagerLiveResponse();
			installManagerLiveResponse(2, [
				managerRow(1001, 2, {
					source: "FPL_FINAL_RESULT",
					calculationMode: "FINAL_RESULT",
					algorithmVersion: null,
					eventPoints: 41,
					netEventPoints: 37,
					totalPoints: 137,
					transferCost: 4,
					eventPointSemantics: "GROSS",
					revision: "final-score-1001-80",
					checkedAt: "2026-08-24T00:09:00.000Z",
					eventRank: finalEventRank,
					provenance: {
						scoreSource: "FPL_FINAL_RESULT",
						calculationMode: "FINAL_RESULT",
						algorithmVersion: null,
						inputRevision: "input-1001",
						scoreRevision: "score-1001",
						rankRevision: "rank-1001-80",
						livePublicationId: null,
						liveRevision: null,
						liveCheckedAt: null,
						picksRevision: "picks-1001",
						picksCheckedAt: "2026-08-24T00:09:00.000Z",
						previousTotalsRevision: null,
						previousTotalsThroughEventId: 1,
						resultRevision: "result-1001",
						resultCheckedAt: "2026-08-24T00:09:00.000Z",
						dataCheckedAt: "2026-08-24T00:00:00.000Z",
						rankSource: null,
						rankCheckedAt: null,
					},
				}),
			]);
			const reranked = await entryLiveBatchService.calcLivePointsForEntries(
				makeMockContext({}),
				2,
				[1001]
			);
			expect(reranked.results.get(1001)?.score.revision).not.toBe(firstScoreRevision);
		} finally {
			restoreManagerLiveResponse();
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
		const effectiveLineup = elements.map((element, index) => {
			const isCaptain = element === 4;
			const isViceCaptain = element === 3;
			const isSubstitute = element === 13;
			const pickActive = !isCaptain && (index < 11 || isSubstitute);
			return {
				elementId: element,
				position: index + 1,
				sourceMultiplier: isCaptain ? 2 : index < 11 ? 1 : 0,
				effectiveMultiplier: isCaptain ? 0 : isViceCaptain ? 2 : pickActive ? 1 : 0,
				pickActive,
				autoSub: isSubstitute,
				isCaptain,
				isViceCaptain,
				captainForScoring: isViceCaptain,
			};
		});
		installManagerLiveResponse(1, [
			managerRow(101, 1, { effectiveLineup, eventPoints: 17, netEventPoints: 17, totalPoints: 17 }),
		]);
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
			const result = await entryLiveBatchService.calcLivePointsForEntries(context, 1, [101], {
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
					reconciliation: "MATCHED",
				},
			});
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
			restoreManagerLiveResponse();
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
			overallRank: id * 10,
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
		const inputPicks = completePick(101, 1).picks;
		const staleRankRow = managerRow(101, 1, {
			eventPoints: 0,
			netEventPoints: 0,
			totalPoints: 0,
			overallRank: 999,
			effectiveLineup: inputPicks.map((pick) => ({
				elementId: pick.element,
				position: pick.position,
				sourceMultiplier: pick.multiplier,
				effectiveMultiplier: pick.multiplier,
				pickActive: pick.multiplier > 0,
				autoSub: false,
				isCaptain: pick.isCaptain,
				isViceCaptain: pick.isViceCaptain,
				captainForScoring: pick.isCaptain,
			})),
		});
		const staleRankCheckedAt = new Date(Date.now() - 5 * 60_000).toISOString();
		staleRankRow.provenance = {
			...(staleRankRow.provenance as Record<string, unknown>),
			rankRevision: "rank-101",
			rankSource: "FPL_ENTRY_SUMMARY",
			rankCheckedAt: staleRankCheckedAt,
		};
		installManagerLiveResponse(1, [staleRankRow], [101, 202]);
		try {
			const result = await entryLiveBatchService.calcLivePointsForEntries(context, 1, [101, 202], {
				liveByPlayer: Promise.resolve(new Map()),
				fixtures: Promise.resolve([]),
				teams: Promise.resolve(core.teams as never),
				picksByEntry: Promise.resolve(
					new Map([[101, { ...completePick(101, 1), picks: inputPicks }]]) as never
				),
			});

			expect([...result.results.keys()]).toEqual([101, 202]);
			expect([...result.results.values()].map((value) => value.availability)).toEqual([
				"LINEUP_UNAVAILABLE",
				"NO_PICKS",
			]);
			expect(result.results.get(101)?.snapshot).toBeNull();
			expect(result.results.get(101)?.score.overallRank).toBe(999);
			expect(result.results.get(101)?.score.provenance?.rankCheckedAt).toBe(staleRankCheckedAt);
			expect(result.results.get(101)?.overallRank).toBe(999);
			expect(result.results.get(202)?.snapshot).toBeNull();
		} finally {
			restoreManagerLiveResponse();
			entriesService.getEntriesByIds = originalEntries;
			entryLiveRepository.getEntryEventTransfersByIds = originalTransfers;
		}
	});

	it("retains the entry-summary overall rank when an authoritative live row has no rank", async () => {
		const originalEntries = entriesService.getEntriesByIds;
		const core = buildTestCoreData(1);
		const context = buildSnapshotContext(
			new TestRedis(buildCorePublication("2627", 7, core), buildLivePublication(core, 1, "2627", 8))
		);
		entriesService.getEntriesByIds = async () =>
			new Map([
				[
					101,
					{
						id: 101,
						entryName: "Ranked Team",
						playerName: "Ranked Player",
						region: null,
						startedEvent: 1,
						overallPoints: 0,
						overallRank: 4321,
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
		installManagerLiveResponse(1, [managerRow(101, 1)]);
		try {
			const result = await entryLiveBatchService.calcLivePointsForEntries(context, 1, [101], {
				liveByPlayer: Promise.resolve(new Map()),
				fixtures: Promise.resolve([]),
				teams: Promise.resolve(core.teams as never),
				picksByEntry: Promise.resolve(new Map()),
			});

			expect(result.results.get(101)?.availability).toBe("NO_PICKS");
			expect(result.results.get(101)?.score.overallRank).toBeNull();
			expect(result.results.get(101)?.overallRank).toBe(4321);
		} finally {
			restoreManagerLiveResponse();
			entriesService.getEntriesByIds = originalEntries;
		}
	});
});
