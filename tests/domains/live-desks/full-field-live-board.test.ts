import { describe, expect, it } from "bun:test";
import type { ManagerScoreLoad } from "../../../src/domains/entry-live/manager-score";
import {
	loadManagerScoresInChunks,
	mergeManagerScoreLoads,
	splitManagerLiveEntryIds,
} from "../../../src/domains/entry-live/manager-score-batches";
import type { ManagerLiveScoreRow } from "../../../src/infra/manager-live-client";
import type { LiveDataSnapshot } from "../../../src/infra/data-snapshot";
import {
	hasComparableFullFieldManagerMetric,
	isScheduledTournamentEvent,
	managerScoresAlignedWithLiveSnapshot,
	selectManagerScoresForBoard,
} from "../../../src/domains/live-desks/resolvers";
import {
	buildFullFieldLiveBoardIndex,
	type FullFieldLiveBoardIndexInput,
} from "../../../src/domains/live-desks/full-field-live-board";
import {
	queryEntryLiveCompetitionBoard,
	type EntryLiveCompetitionBoardRequest,
} from "../../../src/domains/live-desks/entry-live-competition-board";

const makeManagerRow = (entryId: number, eventPoints: number): ManagerLiveScoreRow => ({
	season: "2026",
	eventId: 38,
	entryId,
	eventPoints,
	netEventPoints: eventPoints,
	totalPoints: 100 + eventPoints,
	totalScope: "OVERALL",
	eventRank: null,
	overallRank: entryId,
	leagueRank: entryId,
	source: "FPL_CLASSIC_STANDINGS",
	transferCost: 0,
	eventPointSemantics: "ZERO_COST_EQUIVALENT",
	revision: `manager:${entryId}`,
	checkedAt: "2026-08-25T00:00:00.000Z",
	upstreamUpdatedAt: "2026-08-25T00:00:00.000Z",
	staleAt: "2026-08-25T00:01:00.000Z",
});

const makeLoad = (rows: ManagerLiveScoreRow[], expectedEntries: number): ManagerScoreLoad => ({
	season: "2026",
	rows: new Map(rows.map((row) => [row.entryId, row])),
	errorCode: null,
	managerRevision: `load:${rows.length}`,
	dataAvailability: "FRESH",
	servedFrom: "REDIS",
	refreshQueued: false,
	missingEntryIds: [],
	checkedAt: "2026-08-25T00:00:00.000Z",
	nextRefreshAt: "2026-08-25T00:00:30.000Z",
	tournamentCoverage: {
		rosterRevision: "roster",
		expectedEntries,
		resolvedEntries: expectedEntries,
		fullyFetchedAt: "2026-08-25T00:00:00.000Z",
		managerRevision: `coverage:${expectedEntries}`,
		error: null,
		state: "COMPLETE",
	},
});

describe("full-field live board bounded manager loads", () => {
	it("splits every supported boundary into requests of at most 500", () => {
		for (const size of [499, 500, 501, 1567]) {
			const chunks = splitManagerLiveEntryIds(
				Array.from({ length: size }, (_, index) => size - index)
			);
			expect(chunks.every((chunk) => chunk.length <= 500)).toBe(true);
			expect(chunks.flat()).toEqual(Array.from({ length: size }, (_, index) => index + 1));
		}
	});

	it("merges bounded loads without claiming complete coverage when a row is missing", () => {
		const merged = mergeManagerScoreLoads([makeLoad([makeManagerRow(1, 10)], 2)], [1, 2]);
		expect(merged.rows.size).toBe(1);
		expect(merged.missingEntryIds).toEqual([2]);
		expect(merged.dataAvailability).toBe("PARTIAL");
		expect(merged.tournamentCoverage?.state).toBe("PARTIAL");
	});

	it("preserves a partial coverage state when all rows happen to be present", () => {
		const load = makeLoad([makeManagerRow(1, 10), makeManagerRow(2, 11)], 2);
		const merged = mergeManagerScoreLoads(
			[
				{
					...load,
					tournamentCoverage: {
						...load.tournamentCoverage!,
						resolvedEntries: 2,
						state: "PARTIAL",
					},
				},
			],
			[1, 2]
		);

		expect(merged.rows.size).toBe(2);
		expect(merged.missingEntryIds).toEqual([]);
		expect(merged.tournamentCoverage?.state).toBe("PARTIAL");
	});

	it("preserves partial manager availability when all rows are present", () => {
		const load = makeLoad([makeManagerRow(1, 10), makeManagerRow(2, 11)], 2);
		const merged = mergeManagerScoreLoads(
			[
				{
					...load,
					dataAvailability: "PARTIAL",
				},
			],
			[1, 2]
		);

		expect(merged.rows.size).toBe(2);
		expect(merged.dataAvailability).toBe("PARTIAL");
	});

	it("does not synthesize complete coverage when a manager chunk omits coverage", () => {
		const complete = makeLoad([makeManagerRow(1, 10)], 2);
		const missingCoverage = { ...makeLoad([makeManagerRow(2, 11)], 2), tournamentCoverage: null };
		const merged = mergeManagerScoreLoads([complete, missingCoverage], [1, 2]);

		expect(merged.rows.size).toBe(2);
		expect(merged.tournamentCoverage?.state).toBe("PARTIAL");
	});

	it("does not claim complete coverage when chunks use different manager revisions", () => {
		const first = makeLoad([makeManagerRow(1, 10)], 2);
		const second = makeLoad([makeManagerRow(2, 11)], 2);
		const merged = mergeManagerScoreLoads(
			[
				first,
				{
					...second,
					tournamentCoverage: {
						...second.tournamentCoverage!,
						managerRevision: "coverage:other",
					},
				},
			],
			[1, 2]
		);

		expect(merged.rows.size).toBe(2);
		expect(merged.tournamentCoverage).toMatchObject({
			state: "PARTIAL",
			managerRevision: null,
			error: "INCONSISTENT_MANAGER_REVISION",
		});
	});

	it("does not claim complete coverage when a chunk lacks a roster revision", () => {
		const first = makeLoad([makeManagerRow(1, 10)], 2);
		const second = makeLoad([makeManagerRow(2, 11)], 2);
		const merged = mergeManagerScoreLoads(
			[
				first,
				{
					...second,
					tournamentCoverage: {
						...second.tournamentCoverage!,
						rosterRevision: null,
					},
				},
			],
			[1, 2]
		);

		expect(merged.tournamentCoverage).toMatchObject({
			state: "PARTIAL",
			rosterRevision: null,
			error: "INCONSISTENT_ROSTER_REVISION",
		});
	});

	it("requires final-result rows before a finalized field can be globally ranked", () => {
		const summaryLoad = makeLoad([makeManagerRow(1, 10)], 1);
		const finalLoad = makeLoad([{ ...makeManagerRow(1, 10), source: "FPL_FINAL_RESULT" }], 1);

		expect(
			managerScoresAlignedWithLiveSnapshot(summaryLoad, { finished: true, dataChecked: true }, null)
		).toBe(false);
		expect(
			managerScoresAlignedWithLiveSnapshot(finalLoad, { finished: true, dataChecked: true }, null)
		).toBe(true);
	});

	it("requires active rows to use the current event-live publication", () => {
		const snapshot = {
			source: "redis",
			seasonCode: "2026",
			eventId: 38,
			revision: "38",
			publicationId: "publication",
			sourceCheckedAt: "2026-08-25T00:00:00.000Z",
			lastSuccessfulFetchAt: "2026-08-25T00:00:00.000Z",
			publishedAt: "2026-08-25T00:00:00.000Z",
			state: "live",
			eventLives: [],
			fixtures: [],
			liveFixtures: {},
			liveBonus: {},
		} satisfies LiveDataSnapshot;
		const summaryLoad = makeLoad([makeManagerRow(1, 10)], 1);
		const liveLoad = makeLoad(
			[
				{
					...makeManagerRow(1, 10),
					source: "FPL_EVENT_LIVE",
					revision: "fpl:live:publication:38:entry:1:hash",
				},
			],
			1
		);

		expect(
			managerScoresAlignedWithLiveSnapshot(
				summaryLoad,
				{ finished: false, dataChecked: false },
				snapshot
			)
		).toBe(false);
		expect(
			managerScoresAlignedWithLiveSnapshot(
				liveLoad,
				{ finished: false, dataChecked: false },
				snapshot
			)
		).toBe(true);
	});

	it("requires gross evidence when a classic field is requested in net order", () => {
		const gross = makeManagerRow(1, 10);
		const netOnly = {
			...gross,
			eventPoints: null,
			netEventPoints: 10,
			eventPointSemantics: "NET" as const,
		};

		expect(
			hasComparableFullFieldManagerMetric(gross, { requireNet: false, requestedNet: true })
		).toBe(true);
		expect(
			hasComparableFullFieldManagerMetric(netOnly, { requireNet: false, requestedNet: true })
		).toBe(false);
		expect(
			hasComparableFullFieldManagerMetric(netOnly, { requireNet: true, requestedNet: true })
		).toBe(true);
		expect(
			hasComparableFullFieldManagerMetric(netOnly, { requireNet: true, requestedNet: false })
		).toBe(false);
		expect(
			hasComparableFullFieldManagerMetric(gross, { requireNet: true, requestedNet: false })
		).toBe(true);
	});

	it("does not short-circuit finalized events as scheduled when current event is null", () => {
		expect(
			isScheduledTournamentEvent({
				eventId: 38,
				currentEventId: null,
				anchorEventId: 38,
				dataAvailability: "SCHEDULED",
				finished: true,
				dataChecked: true,
			})
		).toBe(false);
		expect(
			isScheduledTournamentEvent({
				eventId: 38,
				currentEventId: 37,
				anchorEventId: 38,
				dataAvailability: "SCHEDULED",
				finished: false,
				dataChecked: false,
			})
		).toBe(true);
		expect(
			isScheduledTournamentEvent({
				eventId: 38,
				currentEventId: null,
				anchorEventId: 38,
				dataAvailability: "SCHEDULED",
				finished: true,
				dataChecked: false,
			})
		).toBe(false);
	});

	it("loads 1,567 managers two chunks at a time and merges all rows", async () => {
		const entryIds = Array.from({ length: 1567 }, (_, index) => index + 1);
		let active = 0;
		let peak = 0;
		const merged = await loadManagerScoresInChunks(entryIds, async (chunk) => {
			active += 1;
			peak = Math.max(peak, active);
			await Promise.resolve();
			active -= 1;
			return makeLoad(
				chunk.map((entryId) => makeManagerRow(entryId, entryId % 20)),
				entryIds.length
			);
		});
		expect(peak).toBeLessThanOrEqual(2);
		expect(merged.rows.size).toBe(1567);
		expect(merged.missingEntryIds).toEqual([]);
		expect(merged.tournamentCoverage?.state).toBe("COMPLETE");
	});

	it("retains the successful bounded manager load when expansion is incomplete", () => {
		const initial = makeLoad([makeManagerRow(1, 10)], 2);
		const expanded = makeLoad([makeManagerRow(2, 11)], 2);

		expect(selectManagerScoresForBoard(initial, expanded, false)).toBe(initial);
		expect(selectManagerScoresForBoard(initial, expanded, true)).toBe(expanded);
		expect(selectManagerScoresForBoard(initial, null, false)).toBe(initial);
	});
});

describe("full-field live board index", () => {
	it("ranks the complete field and applies ownership filters before page calculation", () => {
		const entryIds = [1, 2, 3];
		const players = new Map(
			Array.from({ length: 45 }, (_, index) => [
				index + 100,
				{
					id: index + 100,
					code: index + 100,
					webName: `Player ${index + 100}`,
					firstName: null,
					secondName: null,
					teamId: index % 2 === 0 ? 1 : 2,
					position: 2,
					price: 50,
					startPrice: 50,
					totalPoints: 0,
					selectedByPercent: null,
				},
			])
		);
		const picks = new Map(
			entryIds.map((entryId) => [
				entryId,
				{
					entryId,
					eventId: 38,
					chip: entryId === 1 ? "wildcard" : null,
					transfersCost: 0,
					picks: Array.from({ length: 15 }, (_, index) => ({
						eventId: 38,
						entryId,
						element: 100 + index,
						position: index + 1,
						multiplier: index === 0 ? 2 : index < 11 ? 1 : 0,
						isCaptain: index === 0,
						isViceCaptain: index === 1,
					})),
				},
			])
		);
		const entries = new Map(
			entryIds.map((id) => [
				id,
				{
					id,
					entryName: `Team ${id}`,
					playerName: `Manager ${id}`,
					region: null,
					startedEvent: 1,
					overallPoints: 100,
					overallRank: id,
					bank: 0,
					teamValue: 1000,
					totalTransfers: 0,
					lastEventId: 37,
					lastOverallPoints: 90,
					lastOverallRank: id,
					lastTeamValue: 1000,
					lastBank: 0,
				},
			])
		);
		const boardInput: FullFieldLiveBoardIndexInput = {
			season: "2026",
			eventId: 38,
			tournamentId: 8,
			coreRevision: "core",
			playerRevision: "live",
			managerRevision: "manager",
			rosterRevision: "roster",
			allEntryIds: entryIds,
			entries,
			picks,
			players,
			managerRows: new Map([
				[1, makeManagerRow(1, 30)],
				[2, makeManagerRow(2, 20)],
				[3, makeManagerRow(3, 10)],
			]),
			requireNet: false,
		};
		const board = buildFullFieldLiveBoardIndex(boardInput);
		const request: EntryLiveCompetitionBoardRequest = {
			entryId: 1,
			tournamentId: 8,
			eventId: 38,
			page: 1,
			pageSize: 20,
			sort: "RANK",
			direction: "ASC",
			search: "",
			chips: ["WILDCARD"],
			captainPlayerIds: [],
			ownership: null,
			teamCountRules: [],
			expectedBoardRevision: null,
		};
		const page = queryEntryLiveCompetitionBoard(board, request);
		expect(board.rows.map((row) => row.rank)).toEqual([1, 2, 3]);
		expect(page.filteredEntries).toBe(1);
		expect(page.rows[0]?.entry).toBe(1);
		expect(page.rows[0]?.score.source).toBe("FPL_CLASSIC_STANDINGS");

		const grossFirstManagerRows = new Map(boardInput.managerRows);
		const grossFirst = grossFirstManagerRows.get(1);
		const netSecond = grossFirstManagerRows.get(2);
		if (!grossFirst || !netSecond) throw new Error("test manager rows missing");
		grossFirstManagerRows.set(1, { ...grossFirst, eventPoints: 30, netEventPoints: 10 });
		grossFirstManagerRows.set(2, { ...netSecond, eventPoints: 20, netEventPoints: 20 });
		const grossRankedBoard = buildFullFieldLiveBoardIndex({
			...boardInput,
			managerRows: grossFirstManagerRows,
			requireNet: false,
		});
		expect(grossRankedBoard.rows.map((row) => row.rank)).toEqual([1, 2, 3]);

		const managerAliasPick = boardInput.picks.get(2);
		if (!managerAliasPick) throw new Error("test manager alias pick missing");
		const managerAliasBoard = buildFullFieldLiveBoardIndex({
			...boardInput,
			picks: new Map(boardInput.picks).set(2, { ...managerAliasPick, chip: "AM" }),
		});
		expect(managerAliasBoard.rows.find((row) => row.entry === 2)?.chip).toBe("MANAGER");

		const finalNoCaptainPick = boardInput.picks.get(1);
		if (!finalNoCaptainPick) throw new Error("test finalized pick missing");
		const finalNoCaptainPicks = finalNoCaptainPick.picks.map((selected, index) => ({
			...selected,
			multiplier: index >= 2 && index <= 12 ? 1 : 0,
			isCaptain: index === 0,
			isViceCaptain: index === 1,
		}));
		const finalPicks = new Map(boardInput.picks).set(1, {
			...finalNoCaptainPick,
			picks: finalNoCaptainPicks,
		});
		expect(() => buildFullFieldLiveBoardIndex({ ...boardInput, picks: finalPicks })).toThrow(
			"Entry 1 has no complete event pick row"
		);
		expect(() =>
			buildFullFieldLiveBoardIndex({
				...boardInput,
				picks: finalPicks,
				allowFinalNoCaptainBoost: true,
			})
		).not.toThrow();

		const missingTeamValueEntries = new Map(boardInput.entries);
		const missingTeamValueEntry = missingTeamValueEntries.get(3);
		if (!missingTeamValueEntry) throw new Error("test team value entry missing");
		missingTeamValueEntries.set(3, { ...missingTeamValueEntry, teamValue: null });
		expect(() =>
			buildFullFieldLiveBoardIndex({
				...boardInput,
				entries: missingTeamValueEntries,
				requireTeamValue: true,
			})
		).toThrow("Entry 3 has no team value for TEAM_VALUE sorting");

		const eventResults = new Map<number, { teamValue: number; overallRank: number }>(
			entryIds.map((entryId) => [
				entryId,
				{ teamValue: 800 + entryId, overallRank: 1000 - entryId },
			])
		);
		const historicalManagerRows = new Map(
			Array.from(
				boardInput.managerRows,
				([entryId, row]) => [entryId, { ...row, overallRank: null }] as const
			)
		);
		const historicalBoard = buildFullFieldLiveBoardIndex({
			...boardInput,
			eventResults,
			managerRows: historicalManagerRows,
			requireEventTeamValue: true,
			requireTeamValue: true,
		});
		expect(historicalBoard.rows.map((row) => row.teamValue)).toEqual([80.1, 80.2, 80.3]);
		expect(historicalBoard.rows.map((row) => row.overallRank)).toEqual([999, 998, 997]);
		const missingHistoricalResult = new Map(eventResults);
		missingHistoricalResult.delete(3);
		expect(() =>
			buildFullFieldLiveBoardIndex({
				...boardInput,
				eventResults: missingHistoricalResult,
				requireEventTeamValue: true,
			})
		).toThrow("Entry 3 has no finalized event team value");

		const eventScopedBoard = buildFullFieldLiveBoardIndex({
			...boardInput,
			playerTeamIds: new Map(
				Array.from(players.values(), (player): [number, number] => [player.id, player.teamId]).map(
					([id, teamId]): [number, number] => [id, id === 100 ? 9 : teamId]
				)
			),
		});
		const eventScopedPage = queryEntryLiveCompetitionBoard(eventScopedBoard, {
			...request,
			chips: [],
			teamCountRules: [{ teamId: 9, exactCount: 1, scope: "ANY" }],
		});
		expect(eventScopedPage.filteredEntries).toBe(3);

		const fallbackPick = boardInput.picks.get(1);
		if (!fallbackPick) throw new Error("test pick missing");
		const fallbackManagerRow = boardInput.managerRows.get(1);
		if (!fallbackManagerRow) throw new Error("test manager row missing");
		const fallbackBoard = buildFullFieldLiveBoardIndex({
			...boardInput,
			picks: new Map(boardInput.picks).set(1, { ...fallbackPick, transfersCost: 4 }),
			managerRows: new Map(boardInput.managerRows).set(1, {
				...fallbackManagerRow,
				transferCost: null,
			}),
		});
		expect(fallbackBoard.rows.find((row) => row.entry === 1)?.transferCost).toBe(4);

		const incompletePicks = new Map(boardInput.picks);
		incompletePicks.delete(3);
		expect(() => buildFullFieldLiveBoardIndex({ ...boardInput, picks: incompletePicks })).toThrow(
			"Entry 3 has no complete event pick row"
		);

		const partialPicks = new Map(boardInput.picks);
		const partialPick = partialPicks.get(3);
		if (!partialPick) throw new Error("test partial pick missing");
		partialPicks.set(3, { ...partialPick, picks: partialPick.picks.slice(0, 14) });
		expect(() => buildFullFieldLiveBoardIndex({ ...boardInput, picks: partialPicks })).toThrow(
			"Entry 3 has no complete event pick row"
		);

		const missingEntries = new Map(boardInput.entries);
		missingEntries.delete(3);
		expect(() => buildFullFieldLiveBoardIndex({ ...boardInput, entries: missingEntries })).toThrow(
			"Entry 3 has no entry metadata"
		);

		const missingPlayers = new Map(boardInput.players);
		missingPlayers.delete(100);
		expect(() => buildFullFieldLiveBoardIndex({ ...boardInput, players: missingPlayers })).toThrow(
			"Entry 1 pick 100 has no player metadata"
		);

		const missingEventTeam = new Map(
			Array.from(players.values(), (player): [number, number] => [player.id, player.teamId]).filter(
				([id]) => id !== 101
			)
		);
		expect(() =>
			buildFullFieldLiveBoardIndex({ ...boardInput, playerTeamIds: missingEventTeam })
		).toThrow("Entry 1 pick 101 has no team metadata");
	});
});
