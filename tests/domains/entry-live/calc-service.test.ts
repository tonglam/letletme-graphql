import { describe, expect, it } from "bun:test";
import type { GraphQLContext } from "../../../src/graphql/context";
import {
	entryLiveCalcService,
	type LiveCalcData,
} from "../../../src/domains/entry-live/calc-service";
import { entryLiveBatchService } from "../../../src/domains/entry-live/batch-service";
import { entriesService } from "../../../src/domains/entries/service";
import { eventsService } from "../../../src/domains/events/service";
import { loadLiveSnapshotMeta } from "../../../src/domains/live/snapshot-meta";
import { entryLiveRepository } from "../../../src/domains/entry-live/repository";
import {
	buildCorePublication,
	buildLivePublication,
	buildSnapshotContext,
	buildTestCoreData,
	TestRedis,
} from "../../helpers/data-publication";

describe("entryLiveCalcService.calcLivePointsByEntry", () => {
	it("returns NO_PICKS before acquiring a live snapshot or enrichment", async () => {
		const originalGetPick = entryLiveRepository.getEntryEventPick;
		const originalGetEntry = entriesService.getEntryById;
		const originalGetPrevious = entriesService.getEntryEventResult;
		const stages: string[] = [];
		entryLiveRepository.getEntryEventPick = async () => null;
		entriesService.getEntryById = async () => ({
			id: 123,
			entryName: "Legacy Team",
			playerName: "Legacy Player",
			region: "AU",
			startedEvent: 1,
			overallPoints: 321,
			overallRank: 456,
			bank: 15,
			teamValue: 1005,
			totalTransfers: 7,
			lastEventId: 8,
			lastOverallPoints: 300,
			lastOverallRank: 500,
			lastTeamValue: 995,
			lastBank: 10,
		});
		entriesService.getEntryEventResult = async () =>
			({
				eventId: 6,
				overallPoints: 300,
				overallRank: 500,
				teamValue: 995,
			}) as never;
		const context = {
			requestTiming: {
				start: (stage: string) => {
					stages.push(stage);
					return () => undefined;
				},
			},
		} as unknown as GraphQLContext;

		try {
			const result = await entryLiveCalcService.calcLivePointsByEntry(context, 7, 123);
			expect(result.availability).toBe("NO_PICKS");
			expect(result.snapshot).toBeNull();
			expect(result.event).toBe(7);
			expect(result.pickList).toEqual([]);
			expect(result).toMatchObject({
				entryName: "Legacy Team",
				playerName: "Legacy Player",
				overallPoints: 321,
				overallRank: 456,
				value: 100.5,
				bank: 1.5,
				teamValue: 100.5,
				lastOverallPoints: 300,
				lastOverallRank: 500,
				lastValue: 99.5,
				liveTotalPoints: 0,
			});
			expect(stages).toEqual(["entryLive.picks"]);
		} finally {
			entryLiveRepository.getEntryEventPick = originalGetPick;
			entriesService.getEntryById = originalGetEntry;
			entriesService.getEntryEventResult = originalGetPrevious;
		}
	});

	it("delegates finalized missing-picks entries to the durable final-result path", async () => {
		const originalGetPick = entryLiveRepository.getEntryEventPick;
		const originalGetEvent = eventsService.getEventById;
		const originalBatchCalc = entryLiveBatchService.calcLivePointsForEntries;
		const stages: string[] = [];
		const finalResult = {
			availability: "NO_PICKS",
			event: 2,
			entry: 123,
			score: { source: "FPL_FINAL_RESULT", state: "FINAL" },
		} as LiveCalcData;
		entryLiveRepository.getEntryEventPick = async () => null;
		eventsService.getEventById = async () =>
			({ id: 2, finished: true, dataChecked: true }) as never;
		entryLiveBatchService.calcLivePointsForEntries = async () => ({
			results: new Map([[123, finalResult]]),
			errors: [],
			meta: { eventId: 2, totalEntries: 1, succeededCount: 1, failedCount: 0 },
		});
		const context = {
			requestTiming: {
				start: (stage: string) => {
					stages.push(stage);
					return () => undefined;
				},
			},
		} as unknown as GraphQLContext;

		try {
			const result = await entryLiveCalcService.calcLivePointsByEntry(context, 2, 123);
			expect(result).toBe(finalResult);
			expect(stages).toEqual(["entryLive.picks", "entryLive.aggregate"]);
		} finally {
			entryLiveRepository.getEntryEventPick = originalGetPick;
			eventsService.getEventById = originalGetEvent;
			entryLiveBatchService.calcLivePointsForEntries = originalBatchCalc;
		}
	});

	it("returns READY while reusing one request-scoped live snapshot", async () => {
		const originalGetPick = entryLiveRepository.getEntryEventPick;
		const originalBatchCalc = entryLiveBatchService.calcLivePointsForEntries;
		const core = buildTestCoreData(1);
		const context = buildSnapshotContext(
			new TestRedis(buildCorePublication("2627", 7, core), buildLivePublication(core, 1, "2627", 8))
		);
		const stages: string[] = [];
		Object.assign(context, {
			requestTiming: {
				start: (stage: string) => {
					stages.push(stage);
					return () => undefined;
				},
			},
		});
		entryLiveRepository.getEntryEventPick = async () =>
			({
				eventId: 1,
				entryId: 123,
				chip: null,
				transfersCost: 0,
				picks: Array.from({ length: 15 }, (_, index) => ({
					eventId: 1,
					entryId: 123,
					element: index + 1,
					position: index + 1,
					multiplier: index === 0 ? 2 : index < 11 ? 1 : 0,
					isCaptain: index === 0,
					isViceCaptain: index === 1,
				})),
			}) as Awaited<ReturnType<typeof originalGetPick>>;
		let batchSnapshot: Awaited<ReturnType<typeof loadLiveSnapshotMeta>> | undefined;
		entryLiveBatchService.calcLivePointsForEntries = async (batchContext, eventId, entryIds) => {
			batchSnapshot = await loadLiveSnapshotMeta(batchContext, eventId);
			return {
				results: new Map([
					[
						entryIds[0]!,
						{
							availability: "READY",
							entry: entryIds[0]!,
							event: eventId,
							snapshot: batchSnapshot,
						} as LiveCalcData,
					],
				]),
				errors: [],
				meta: {
					eventId,
					totalEntries: 1,
					succeededCount: 1,
					failedCount: 0,
				},
			};
		};

		try {
			const result = await entryLiveCalcService.calcLivePointsByEntry(context, 1, 123);
			const observedSnapshot = batchSnapshot;
			if (!observedSnapshot) throw new Error("Batch did not observe the request-scoped snapshot");
			expect(result.availability).toBe("READY");
			expect(result.snapshot).toEqual(observedSnapshot);
			expect(result.snapshot).toMatchObject({ revision: "8", eventId: 1 });
			expect(stages).toEqual(["entryLive.picks", "entryLive.aggregate"]);
		} finally {
			entryLiveRepository.getEntryEventPick = originalGetPick;
			entryLiveBatchService.calcLivePointsForEntries = originalBatchCalc;
		}
	});
});
