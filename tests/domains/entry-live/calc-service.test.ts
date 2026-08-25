import { describe, expect, it } from "bun:test";
import type { GraphQLContext } from "../../../src/graphql/context";
import {
	entryLiveCalcService,
	type ElementEventResultData,
	type LiveCalcData,
} from "../../../src/domains/entry-live/calc-service";
import { entryLiveBatchService } from "../../../src/domains/entry-live/batch-service";
import { entriesService } from "../../../src/domains/entries/service";
import { eventsService } from "../../../src/domains/events/service";
import {
	applyAutoSubs,
	calcElementLivePoints,
	calcOfficialTotalWithEffectiveBonus,
} from "../../../src/domains/entry-live/calc-service";
import { projectLiveLineup } from "../../../src/domains/entry-live/legacy-h2h-adapter";
import type { LivePerformance } from "../../../src/domains/live/repository";
import { loadLiveSnapshotMeta } from "../../../src/domains/live/snapshot-meta";
import { entryLiveRepository } from "../../../src/domains/entry-live/repository";
import {
	buildCorePublication,
	buildLivePublication,
	buildSnapshotContext,
	buildTestCoreData,
	TestRedis,
} from "../../helpers/data-publication";

const makeLive = (overrides: Partial<LivePerformance> = {}): LivePerformance => ({
	eventId: 1,
	playerId: 1,
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
	inDreamTeam: null,
	totalPoints: 0,
	...overrides,
});

const makePick = (overrides: Partial<ElementEventResultData> = {}): ElementEventResultData => ({
	season: null,
	event: 1,
	element: 1,
	code: 1,
	webName: "Test",
	price: 10,
	elementType: 3,
	elementTypeName: "MID",
	teamId: 1,
	teamCode: 1,
	teamName: "Test FC",
	teamShortName: "TFC",
	againstId: 2,
	againstName: "Opp",
	againstShortName: "OPP",
	wasHome: "H",
	score: "1-0",
	position: 1,
	multiplier: 1,
	isCaptain: false,
	isViceCaptain: false,
	isGwStarted: true,
	isGwFinished: true,
	isPlayed: true,
	playStatus: 4,
	minutes: 90,
	goalsScored: 0,
	assists: 0,
	cleanSheets: 0,
	goalsConceded: 0,
	defensiveContribution: 0,
	ownGoals: 0,
	penaltiesSaved: 0,
	penaltiesMissed: 0,
	yellowCards: 0,
	redCards: 0,
	saves: 0,
	bonus: 0,
	bps: 0,
	totalPoints: 5,
	starts: true,
	expectedGoals: null,
	expectedAssists: null,
	expectedGoalInvolvements: null,
	expectedGoalsConceded: null,
	inDreamTeam: false,
	pickActive: false,
	autoSub: false,
	bgw: false,
	dgw: false,
	...overrides,
});

describe("calcElementLivePoints", () => {
	it("preserves the official event-live total including projected bonus", () => {
		const live = makeLive({ totalPoints: 11, bonus: 2, minutes: 180 });
		expect(calcOfficialTotalWithEffectiveBonus(live, 5)).toBe(11);
		expect(calcOfficialTotalWithEffectiveBonus(live)).toBe(11);
	});
	it("returns 0 for undefined live", () => {
		expect(calcElementLivePoints(undefined)).toBe(0);
	});

	it("uses the official total regardless of position-specific stat shape", () => {
		const live = makeLive({
			totalPoints: 7.5,
			minutes: 45,
			goalsScored: 1,
			cleanSheets: 1,
			redCards: 1,
		});
		expect(calcElementLivePoints(live)).toBe(7.5);
	});

	it("ignores deprecated local effective-bonus overrides", () => {
		const live = makeLive({ totalPoints: 12, bonus: 3 });
		expect(calcElementLivePoints(live, 1)).toBe(12);
	});

	it("preserves official negative scores", () => {
		const live = makeLive({ totalPoints: -2, bonus: 0 });
		expect(calcElementLivePoints(live)).toBe(-2);
	});
});

describe("applyAutoSubs", () => {
	it("does nothing during bench boost", () => {
		const picks = [
			makePick({ position: 1, elementType: 1, minutes: 0, multiplier: 1 }),
			makePick({ position: 12, elementType: 2, minutes: 90, multiplier: 0 }),
		];
		applyAutoSubs(picks, "BENCH_BOOST");
		expect(picks[0].multiplier).toBe(1);
		expect(picks[1].multiplier).toBe(0);
	});

	it("subjects bench player in for non-playing starter", () => {
		const picks = [
			// Starters
			makePick({ position: 1, elementType: 1, minutes: 90, multiplier: 1 }), // GK played
			makePick({ position: 2, elementType: 2, minutes: 0, multiplier: 1 }), // DEF didn't play
			makePick({ position: 3, elementType: 2, minutes: 90, multiplier: 1 }),
			makePick({ position: 4, elementType: 2, minutes: 90, multiplier: 1 }),
			makePick({ position: 5, elementType: 2, minutes: 90, multiplier: 1 }),
			makePick({ position: 6, elementType: 3, minutes: 90, multiplier: 1 }),
			makePick({ position: 7, elementType: 3, minutes: 90, multiplier: 1 }),
			makePick({ position: 8, elementType: 3, minutes: 90, multiplier: 1 }),
			makePick({ position: 9, elementType: 3, minutes: 90, multiplier: 1 }),
			makePick({ position: 10, elementType: 4, minutes: 90, multiplier: 1 }),
			makePick({ position: 11, elementType: 4, minutes: 90, multiplier: 1 }),
			// Bench
			makePick({
				position: 12,
				elementType: 2,
				minutes: 90,
				multiplier: 0,
				totalPoints: 6,
			}),
			makePick({ position: 13, elementType: 3, minutes: 0, multiplier: 0 }),
			makePick({ position: 14, elementType: 3, minutes: 0, multiplier: 0 }),
			makePick({ position: 15, elementType: 4, minutes: 0, multiplier: 0 }),
		];
		applyAutoSubs(picks, "NONE");
		// Position 2 (DEF, 0 min) should be subbed out
		// Position 12 (DEF, 90 min) should come on
		expect(picks[1].multiplier).toBe(0); // Starter subbed out
		expect(picks[11].multiplier).toBe(1); // Bench player came on
	});

	it("respects bench order (12 before 13)", () => {
		const picks = [
			makePick({ position: 1, elementType: 1, minutes: 90, multiplier: 1 }),
			makePick({ position: 2, elementType: 2, minutes: 0, multiplier: 1 }),
			makePick({ position: 3, elementType: 2, minutes: 90, multiplier: 1 }),
			makePick({ position: 4, elementType: 2, minutes: 90, multiplier: 1 }),
			makePick({ position: 5, elementType: 2, minutes: 90, multiplier: 1 }),
			makePick({ position: 6, elementType: 3, minutes: 90, multiplier: 1 }),
			makePick({ position: 7, elementType: 3, minutes: 90, multiplier: 1 }),
			makePick({ position: 8, elementType: 3, minutes: 90, multiplier: 1 }),
			makePick({ position: 9, elementType: 3, minutes: 90, multiplier: 1 }),
			makePick({ position: 10, elementType: 4, minutes: 90, multiplier: 1 }),
			makePick({ position: 11, elementType: 4, minutes: 90, multiplier: 1 }),
			makePick({
				position: 12,
				elementType: 3,
				minutes: 90,
				multiplier: 0,
				totalPoints: 8,
			}), // MID bench
			makePick({
				position: 13,
				elementType: 2,
				minutes: 90,
				multiplier: 0,
				totalPoints: 6,
			}), // DEF bench
		];
		applyAutoSubs(picks, "NONE");
		// Position 12 (MID) cannot replace position 2 (DEF) - would give 3 DEF, 6 MID, 2 FWD = valid
		// Actually wait: 1 GK + 2 DEF + 6 MID + 2 FWD = 11, that's valid!
		// So position 12 should come on first
		expect(picks[11].multiplier).toBe(1); // Position 12 came on
		expect(picks[1].multiplier).toBe(0); // Position 2 subbed out
	});

	it("skips bench player who did not play", () => {
		const picks = [
			makePick({ position: 1, elementType: 1, minutes: 90, multiplier: 1 }),
			makePick({ position: 2, elementType: 2, minutes: 0, multiplier: 1 }),
			makePick({ position: 3, elementType: 2, minutes: 90, multiplier: 1 }),
			makePick({ position: 4, elementType: 2, minutes: 90, multiplier: 1 }),
			makePick({ position: 5, elementType: 2, minutes: 90, multiplier: 1 }),
			makePick({ position: 6, elementType: 3, minutes: 90, multiplier: 1 }),
			makePick({ position: 7, elementType: 3, minutes: 90, multiplier: 1 }),
			makePick({ position: 8, elementType: 3, minutes: 90, multiplier: 1 }),
			makePick({ position: 9, elementType: 3, minutes: 90, multiplier: 1 }),
			makePick({ position: 10, elementType: 4, minutes: 90, multiplier: 1 }),
			makePick({ position: 11, elementType: 4, minutes: 90, multiplier: 1 }),
			makePick({ position: 12, elementType: 2, minutes: 0, multiplier: 0 }), // Didn't play
			makePick({ position: 13, elementType: 2, minutes: 90, multiplier: 0 }), // Played
		];
		applyAutoSubs(picks, "NONE");
		expect(picks[11].multiplier).toBe(0); // Position 12 stayed on bench (didn't play)
		expect(picks[12].multiplier).toBe(1); // Position 13 came on
		expect(picks[1].multiplier).toBe(0); // Starter subbed out
	});

	it("does not sub if formation would be invalid", () => {
		const picks = [
			makePick({ position: 1, elementType: 1, minutes: 90, multiplier: 1 }),
			makePick({ position: 2, elementType: 2, minutes: 0, multiplier: 1 }),
			makePick({ position: 3, elementType: 2, minutes: 0, multiplier: 1 }),
			makePick({ position: 4, elementType: 2, minutes: 90, multiplier: 1 }),
			makePick({ position: 5, elementType: 3, minutes: 90, multiplier: 1 }),
			makePick({ position: 6, elementType: 3, minutes: 90, multiplier: 1 }),
			makePick({ position: 7, elementType: 3, minutes: 90, multiplier: 1 }),
			makePick({ position: 8, elementType: 3, minutes: 90, multiplier: 1 }),
			makePick({ position: 9, elementType: 3, minutes: 90, multiplier: 1 }),
			makePick({ position: 10, elementType: 4, minutes: 90, multiplier: 1 }),
			makePick({ position: 11, elementType: 4, minutes: 90, multiplier: 1 }),
			makePick({ position: 12, elementType: 4, minutes: 90, multiplier: 0 }), // FWD bench
		];
		applyAutoSubs(picks, "NONE");
		// Replacing a DEF with a FWD would give: 1 GK + 1 DEF + 5 MID + 3 FWD
		// 1 DEF is invalid (< 3), so no sub should happen
		expect(picks[1].multiplier).toBe(1);
		expect(picks[2].multiplier).toBe(1);
		expect(picks[11].multiplier).toBe(0);
	});

	it("handles multiple auto-subs", () => {
		const picks = [
			makePick({ position: 1, elementType: 1, minutes: 90, multiplier: 1 }),
			makePick({ position: 2, elementType: 2, minutes: 0, multiplier: 1 }),
			makePick({ position: 3, elementType: 2, minutes: 0, multiplier: 1 }),
			makePick({ position: 4, elementType: 2, minutes: 90, multiplier: 1 }),
			makePick({ position: 5, elementType: 3, minutes: 90, multiplier: 1 }),
			makePick({ position: 6, elementType: 3, minutes: 90, multiplier: 1 }),
			makePick({ position: 7, elementType: 3, minutes: 90, multiplier: 1 }),
			makePick({ position: 8, elementType: 3, minutes: 90, multiplier: 1 }),
			makePick({ position: 9, elementType: 3, minutes: 90, multiplier: 1 }),
			makePick({ position: 10, elementType: 4, minutes: 90, multiplier: 1 }),
			makePick({ position: 11, elementType: 4, minutes: 90, multiplier: 1 }),
			makePick({ position: 12, elementType: 2, minutes: 90, multiplier: 0 }), // DEF bench
			makePick({ position: 13, elementType: 2, minutes: 90, multiplier: 0 }), // DEF bench
		];
		applyAutoSubs(picks, "NONE");
		expect(picks[1].multiplier).toBe(0); // First DEF subbed out
		expect(picks[2].multiplier).toBe(0); // Second DEF subbed out
		expect(picks[11].multiplier).toBe(1); // First bench DEF came on
		expect(picks[12].multiplier).toBe(1); // Second bench DEF came on
	});

	it("does nothing when all starters played", () => {
		const picks = [
			makePick({ position: 1, elementType: 1, minutes: 90, multiplier: 1 }),
			makePick({ position: 2, elementType: 2, minutes: 90, multiplier: 1 }),
			makePick({ position: 12, elementType: 2, minutes: 90, multiplier: 0 }),
		];
		applyAutoSubs(picks, "NONE");
		expect(picks[0].multiplier).toBe(1);
		expect(picks[1].multiplier).toBe(1);
		expect(picks[2].multiplier).toBe(0);
	});
});

describe("projectLiveLineup", () => {
	const projectedPicks = () => [
		makePick({ element: 1, position: 1, elementType: 1, totalPoints: 2 }),
		makePick({
			element: 2,
			position: 2,
			elementType: 2,
			minutes: 0,
			totalPoints: 0,
			isPlayed: false,
			isCaptain: true,
			multiplier: 2,
		}),
		makePick({ element: 3, position: 3, elementType: 2, totalPoints: 2 }),
		makePick({ element: 4, position: 4, elementType: 2, totalPoints: 2 }),
		makePick({ element: 5, position: 5, elementType: 2, totalPoints: 2 }),
		makePick({
			element: 6,
			position: 6,
			elementType: 3,
			totalPoints: 5,
			isViceCaptain: true,
		}),
		makePick({ element: 7, position: 7, elementType: 3, totalPoints: 2 }),
		makePick({ element: 8, position: 8, elementType: 3, totalPoints: 2 }),
		makePick({ element: 9, position: 9, elementType: 3, totalPoints: 2 }),
		makePick({ element: 10, position: 10, elementType: 4, totalPoints: 2 }),
		makePick({ element: 11, position: 11, elementType: 4, totalPoints: 2 }),
		makePick({ element: 12, position: 12, elementType: 1, totalPoints: 3, multiplier: 0 }),
		makePick({ element: 13, position: 13, elementType: 2, totalPoints: 6, multiplier: 0 }),
		makePick({ element: 14, position: 14, totalPoints: 1, multiplier: 0 }),
		makePick({ element: 15, position: 15, totalPoints: 1, multiplier: 0 }),
	];

	it("projects both the automatic substitute and vice-captain promotion", () => {
		const picks = projectedPicks();
		const projection = projectLiveLineup(picks, "NONE");
		const vice = picks.find((pick) => pick.isViceCaptain)!;
		expect(picks.find((pick) => pick.element === 13)?.autoSub).toBe(true);
		expect(projection.captainForScoring?.element).toBe(vice.element);
		expect(projection.points).toBe(
			projection.activePicks.reduce((sum, pick) => sum + pick.totalPoints, 0) + vice.totalPoints
		);
	});

	it("applies the triple-captain multiplier to a promoted vice-captain", () => {
		const picks = projectedPicks();
		const projection = projectLiveLineup(picks, "TRIPLE_CAPTAIN");
		const vice = picks.find((pick) => pick.isViceCaptain)!;
		expect(projection.points).toBe(
			projection.activePicks.reduce((sum, pick) => sum + pick.totalPoints, 0) + vice.totalPoints * 2
		);
	});
});

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
			const result = await entryLiveCalcService.calcLivePointsByEntry(context, 7, 123, true);
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
			({
				id: 2,
				finished: true,
				dataChecked: true,
				dataCheckedAt: "2026-08-24T00:08:00.000Z",
			}) as never;
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
			const result = await entryLiveCalcService.calcLivePointsByEntry(context, 2, 123, true);
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
			const result = await entryLiveCalcService.calcLivePointsByEntry(context, 1, 123, true);
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
