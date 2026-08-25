import { describe, expect, it } from "bun:test";
import type { GraphQLContext } from "../../../src/graphql/context";
import {
	buildNoPicksLiveCalcData,
	type LiveCalcData,
} from "../../../src/domains/entry-live/calc-service";
import type {
	LiveManagerScore,
	ManagerScoreLoad,
} from "../../../src/domains/entry-live/manager-score";
import {
	buildEntryLiveCompetitionBoard,
	entryLiveCompetitionBoardCacheKey,
	entryLiveCompetitionManagerStatusRevision,
	entryLiveCompetitionRosterRevision,
	normalizeEntryLiveCompetitionBoardRequest,
	queryEntryLiveCompetitionBoard,
	type EntryLiveCompetitionBoardRequest,
} from "../../../src/domains/live-desks/entry-live-competition-board";

const score = (input: Partial<LiveManagerScore> = {}): LiveManagerScore => ({
	eventPoints: 10,
	netEventPoints: 10,
	totalPoints: 100,
	totalScope: "OVERALL",
	eventRank: 1,
	overallRank: 1000,
	leagueRank: 1,
	transferCost: 0,
	source: "FPL_ENTRY_SUMMARY",
	state: "FRESH",
	eventPointSemantics: "ZERO_COST_EQUIVALENT",
	revision: "manager-row-1",
	checkedAt: "2026-08-23T00:00:00.000Z",
	upstreamUpdatedAt: null,
	staleAt: "2026-08-23T00:01:30.000Z",
	nextRefreshAt: "2026-08-23T00:00:30.000Z",
	reconciliation: "MATCHED",
	reasonCodes: [],
	...input,
});

const managerLoad = (checkedAt: string): ManagerScoreLoad => ({
	season: "2627",
	rows: new Map([
		[
			1,
			{
				season: "2627",
				eventId: 1,
				entryId: 1,
				eventPoints: 10,
				netEventPoints: 10,
				totalPoints: 100,
				totalScope: "OVERALL",
				eventRank: 1,
				overallRank: 1000,
				leagueRank: 1,
				source: "FPL_ENTRY_SUMMARY",
				transferCost: 0,
				eventPointSemantics: "ZERO_COST_EQUIVALENT",
				revision: "manager-row-1",
				checkedAt,
				upstreamUpdatedAt: null,
				staleAt: "2026-08-23T00:02:00.000Z",
			},
		],
	]),
	errorCode: null,
	managerRevision: "manager-1",
	dataAvailability: "FRESH",
	servedFrom: "REDIS",
	refreshQueued: false,
	missingEntryIds: [],
	checkedAt,
	nextRefreshAt: "2026-08-23T00:01:00.000Z",
});

type PickInput = {
	element: number;
	teamId: number;
	starter?: boolean;
	active?: boolean;
	captain?: boolean;
	vice?: boolean;
};

const pick = (input: PickInput): LiveCalcData["pickList"][number] =>
	({
		element: input.element,
		teamId: input.teamId,
		pickActive: input.active ?? input.starter !== false,
		isCaptain: input.captain === true,
		isViceCaptain: input.vice === true,
		multiplier: input.captain ? 2 : input.starter === false ? 0 : 1,
		position: input.starter === false ? 12 : 1,
	}) as LiveCalcData["pickList"][number];

const liveRow = (input: {
	entry: number;
	eventPoints?: number | null;
	netEventPoints?: number | null;
	totalPoints?: number | null;
	overallRank?: number;
	transferCost?: number;
	played?: number;
	entryName?: string;
	playerName?: string;
	chip?: string;
	picks?: PickInput[];
	source?: LiveManagerScore["source"];
}): LiveCalcData => {
	const base = buildNoPicksLiveCalcData(input.entry, 1);
	const managerScore = score({
		eventPoints: input.eventPoints === undefined ? 10 : input.eventPoints,
		netEventPoints: input.netEventPoints === undefined ? 10 : input.netEventPoints,
		totalPoints: input.totalPoints === undefined ? 100 : input.totalPoints,
		overallRank: input.overallRank ?? 1000,
		transferCost: input.transferCost ?? 0,
		source: input.source ?? "FPL_ENTRY_SUMMARY",
		revision: `manager-row-${input.entry}`,
	});
	const picks = (input.picks ?? [{ element: input.entry * 10 + 1, teamId: 1, captain: true }]).map(
		pick
	);
	const captain = picks.find((item) => item.isCaptain) ?? picks[0];
	return {
		...base,
		availability: "READY",
		provisional: true,
		score: managerScore,
		rank: input.entry,
		entryName: input.entryName ?? `Team ${input.entry}`,
		playerName: input.playerName ?? `Manager ${input.entry}`,
		overallRank: input.overallRank ?? 1000,
		teamValue: 100 + input.entry / 10,
		chip: input.chip ?? "NONE",
		livePoints: managerScore.eventPoints ?? 0,
		transferCost: input.transferCost ?? 0,
		liveNetPoints: managerScore.netEventPoints ?? 0,
		liveTotalPoints: managerScore.totalPoints ?? 0,
		played: input.played ?? 0,
		toPlay: Math.max(0, 11 - (input.played ?? 0)),
		playedCaptain: captain?.element ?? 0,
		captainName: captain ? `Player ${captain.element}` : "",
		activeCaptain: {
			id: captain?.element ?? 0,
			name: captain ? `Player ${captain.element}` : "",
			points: managerScore.eventPoints ?? 0,
		},
		pickList: picks,
	};
};

const board = (rows: LiveCalcData[], totalEntries = rows.length) =>
	buildEntryLiveCompetitionBoard({
		season: "2026/27",
		eventId: 1,
		tournamentId: 10,
		coreRevision: "core-1",
		playerRevision: "player-1",
		managerRevision: "manager-1",
		rows,
		totalEntries,
	});

const request = (
	overrides: Partial<EntryLiveCompetitionBoardRequest> = {}
): EntryLiveCompetitionBoardRequest => ({
	entryId: 1,
	tournamentId: 10,
	eventId: 1,
	page: 1,
	pageSize: 20,
	sort: "EVENT_POINTS",
	direction: "DESC",
	search: "",
	chips: [],
	captainPlayerIds: [],
	ownership: null,
	teamCountRules: [],
	expectedBoardRevision: null,
	...overrides,
});

describe("entry live competition board request validation", () => {
	it("applies the documented first-page defaults", () => {
		expect(
			normalizeEntryLiveCompetitionBoardRequest({ entryId: 1, tournamentId: 2, eventId: 3 })
		).toMatchObject({
			page: 1,
			pageSize: 20,
			sort: "EVENT_POINTS",
			direction: "DESC",
		});
	});

	it("starts a first-page resync without carrying a stale revision", () => {
		expect(
			normalizeEntryLiveCompetitionBoardRequest({
				entryId: 1,
				tournamentId: 2,
				eventId: 3,
				expectedBoardRevision: "stale",
			}).expectedBoardRevision
		).toBeNull();
	});

	it("enforces page, search, ownership and team-rule limits", () => {
		const base = { entryId: 1, tournamentId: 2, eventId: 3 };
		expect(() => normalizeEntryLiveCompetitionBoardRequest({ ...base, pageSize: 51 })).toThrow();
		expect(() =>
			normalizeEntryLiveCompetitionBoardRequest({ ...base, search: "x".repeat(101) })
		).toThrow();
		expect(() =>
			normalizeEntryLiveCompetitionBoardRequest({
				...base,
				ownership: { playerIds: [1, 2, 3, 4, 5, 6] },
			})
		).toThrow();
		expect(() =>
			normalizeEntryLiveCompetitionBoardRequest({
				...base,
				teamCountRules: [{ teamId: 1, exactCount: 16 }],
			})
		).toThrow();
		expect(() => normalizeEntryLiveCompetitionBoardRequest({ ...base, page: 2 })).toThrow();
	});

	it("accepts every canonical chip, including manager", () => {
		expect(
			normalizeEntryLiveCompetitionBoardRequest({
				entryId: 1,
				tournamentId: 2,
				eventId: 3,
				chips: ["MANAGER"],
			}).chips
		).toEqual(["MANAGER"]);
	});

	it("accepts zero as an exact team count", () => {
		expect(
			normalizeEntryLiveCompetitionBoardRequest({
				entryId: 1,
				tournamentId: 2,
				eventId: 3,
				teamCountRules: [{ teamId: 9, exactCount: 0, scope: "ANY" }],
			}).teamCountRules
		).toEqual([{ teamId: 9, exactCount: 0, scope: "ANY" }]);
	});
});

describe("entry live competition board filtering and paging", () => {
	const rows = [
		liveRow({
			entry: 1,
			entryName: "Alpha XI",
			playerName: "Alice",
			chip: "BENCH_BOOST",
			picks: [
				{ element: 101, teamId: 1, captain: true },
				{ element: 102, teamId: 2 },
				{ element: 103, teamId: 1, starter: false, vice: true },
			],
		}),
		liveRow({
			entry: 2,
			entryName: "Bravo",
			playerName: "Bob",
			chip: "FREE_HIT",
			picks: [
				{ element: 101, teamId: 1 },
				{ element: 104, teamId: 2, captain: true },
			],
		}),
	];

	it("ANDs categories, ORs chip/captain values, and requires every ownership/rule value", () => {
		const built = board(rows);
		const result = queryEntryLiveCompetitionBoard(
			built,
			request({
				search: "alpha",
				chips: ["BENCH_BOOST", "WILDCARD"],
				captainPlayerIds: [101, 999],
				ownership: {
					playerIds: [101, 102],
					scope: "STARTER",
					captainMode: "ANY",
				},
				teamCountRules: [
					{ teamId: 1, exactCount: 2, scope: "ANY" },
					{ teamId: 2, exactCount: 1, scope: "ANY" },
				],
			})
		);
		expect(result.rows.map((row) => row.entry)).toEqual([1]);
	});

	it("supports captain and vice-only ownership modes", () => {
		const built = board(rows);
		expect(
			queryEntryLiveCompetitionBoard(
				built,
				request({
					ownership: { playerIds: [101], scope: "ANY", captainMode: "CAPTAIN" },
				})
			).rows.map((row) => row.entry)
		).toEqual([1]);
		expect(
			queryEntryLiveCompetitionBoard(
				built,
				request({
					ownership: {
						playerIds: [101, 102],
						scope: "STARTER",
						captainMode: "CAPTAIN",
					},
				})
			).rows.map((row) => row.entry)
		).toEqual([1]);
		expect(
			queryEntryLiveCompetitionBoard(
				built,
				request({
					ownership: { playerIds: [103], scope: "BENCH", captainMode: "VICE" },
				})
			).rows.map((row) => row.entry)
		).toEqual([1]);
	});

	it("keeps starter and bench scopes tied to selected positions", () => {
		const built = board([
			liveRow({
				entry: 3,
				picks: [
					{ element: 301, teamId: 1, starter: true, active: false },
					{ element: 302, teamId: 2, starter: false, active: true },
				],
			}),
		]);

		expect(
			queryEntryLiveCompetitionBoard(
				built,
				request({ ownership: { playerIds: [301], scope: "STARTER", captainMode: "ANY" } })
			).filteredEntries
		).toBe(1);
		expect(
			queryEntryLiveCompetitionBoard(
				built,
				request({
					teamCountRules: [{ teamId: 2, exactCount: 1, scope: "BENCH" }],
				})
			).filteredEntries
		).toBe(1);
	});

	it("matches an exact zero count when a team is absent", () => {
		const built = board(rows);
		expect(
			queryEntryLiveCompetitionBoard(
				built,
				request({
					teamCountRules: [{ teamId: 9, exactCount: 0, scope: "ANY" }],
				})
			).rows.map((row) => row.entry)
		).toEqual([1, 2]);
	});

	it("indexes team-count filters with the player's team at the requested event", () => {
		const built = buildEntryLiveCompetitionBoard({
			season: "2627",
			eventId: 7,
			tournamentId: 10,
			coreRevision: "core-1",
			playerRevision: "player-1",
			managerRevision: "manager-1",
			eventTeamIds: new Map([[301, 9]]),
			rows: [
				liveRow({
					entry: 3,
					picks: [{ element: 301, teamId: 2 }],
				}),
			],
			totalEntries: 1,
		});

		expect(
			queryEntryLiveCompetitionBoard(
				built,
				request({
					eventId: 7,
					teamCountRules: [{ teamId: 9, exactCount: 1, scope: "ANY" }],
				})
			).filteredEntries
		).toBe(1);
		expect(
			queryEntryLiveCompetitionBoard(
				built,
				request({
					eventId: 7,
					teamCountRules: [{ teamId: 2, exactCount: 1, scope: "ANY" }],
				})
			).filteredEntries
		).toBe(0);
	});

	it("searches team, manager and exact entry ID text", () => {
		const built = board(rows);
		for (const search of ["alpha", "alice", "2"]) {
			expect(queryEntryLiveCompetitionBoard(built, request({ search })).filteredEntries).toBe(1);
		}
	});

	it("does not substring-match an all-numeric entry search", () => {
		const built = board([liveRow({ entry: 12 }), liveRow({ entry: 112 })]);
		expect(
			queryEntryLiveCompetitionBoard(built, request({ search: "12" })).rows.map((row) => row.entry)
		).toEqual([12]);
	});

	it("returns the filtered viewer row independently from the requested page", () => {
		const built = board([liveRow({ entry: 1 }), liveRow({ entry: 2 }), liveRow({ entry: 3 })]);
		const result = queryEntryLiveCompetitionBoard(
			built,
			request({ entryId: 3, page: 1, pageSize: 1 })
		);
		expect(result.rows.map((row) => row.entry)).toEqual([1]);
		expect(result.viewerRow?.entry).toBe(3);

		const filtered = queryEntryLiveCompetitionBoard(
			built,
			request({ entryId: 3, page: 1, pageSize: 1, search: "1" })
		);
		expect(filtered.viewerRow).toBeNull();
	});

	it("rejects a stale revision without discarding the caller's prior page", () => {
		const built = board(rows);
		try {
			queryEntryLiveCompetitionBoard(
				built,
				request({ page: 2, expectedBoardRevision: "old-revision" })
			);
			throw new Error("Expected revision error");
		} catch (error) {
			expect((error as { extensions?: { code?: string } }).extensions?.code).toBe(
				"LIVE_BOARD_REVISION_GONE"
			);
		}
	});

	it("changes the board revision when a filter index changes", () => {
		const captainOnly = board([
			liveRow({
				entry: 1,
				picks: [
					{ element: 101, teamId: 1, captain: true },
					{ element: 102, teamId: 2 },
				],
			}),
		]);
		const correctedVice = board([
			liveRow({
				entry: 1,
				picks: [
					{ element: 101, teamId: 1, captain: true },
					{ element: 102, teamId: 2, vice: true },
				],
			}),
		]);

		expect(correctedVice.boardRevision).not.toBe(captainOnly.boardRevision);
	});

	it("keeps the board revision stable across a no-op freshness poll", () => {
		const first = liveRow({ entry: 1 });
		const refreshed = liveRow({ entry: 1 });
		refreshed.score = {
			...refreshed.score,
			state: "STALE",
			checkedAt: "2026-08-23T00:00:30.000Z",
			staleAt: "2026-08-23T00:02:00.000Z",
			nextRefreshAt: "2026-08-23T00:01:00.000Z",
		};

		expect(board([refreshed]).boardRevision).toBe(board([first]).boardRevision);
	});

	it("recomputes cached row status for no-op polls and freshness transitions", () => {
		const first = managerLoad("2026-08-23T00:00:00.000Z");
		const refreshed = managerLoad("2026-08-23T00:00:30.000Z");
		const firstStatus = entryLiveCompetitionManagerStatusRevision(
			first,
			Date.parse("2026-08-23T00:00:10.000Z")
		);
		const refreshedStatus = entryLiveCompetitionManagerStatusRevision(
			refreshed,
			Date.parse("2026-08-23T00:00:40.000Z")
		);
		const staleStatus = entryLiveCompetitionManagerStatusRevision(
			first,
			Date.parse("2026-08-23T00:00:31.000Z")
		);

		expect(refreshedStatus).not.toBe(firstStatus);
		expect(staleStatus).not.toBe(firstStatus);

		const context = {
			dataRevision: "core-1",
			currentSeason: { seasonCode: "2627" },
		} as GraphQLContext;
		const identity = {
			season: "2627",
			eventId: 1,
			tournamentId: 10,
			coreRevision: "core-1",
			playerRevision: "player-1",
			managerRevision: "manager-1",
			rosterRevision: "roster-1",
			windowRevision: "window-1",
		};
		expect(
			entryLiveCompetitionBoardCacheKey(context, {
				...identity,
				managerStatusRevision: refreshedStatus,
			})
		).not.toBe(
			entryLiveCompetitionBoardCacheKey(context, {
				...identity,
				managerStatusRevision: firstStatus,
			})
		);
	});

	it("changes cache identity and board revision when tournament membership changes", () => {
		const row = liveRow({ entry: 1 });
		const firstRosterRevision = entryLiveCompetitionRosterRevision([1]);
		const secondRosterRevision = entryLiveCompetitionRosterRevision([1, 2]);
		const first = buildEntryLiveCompetitionBoard({
			season: "2026/27",
			eventId: 1,
			tournamentId: 10,
			coreRevision: "core-1",
			playerRevision: "player-1",
			managerRevision: null,
			rosterRevision: firstRosterRevision,
			windowRevision: firstRosterRevision,
			rows: [row],
			totalEntries: 1,
		});
		const second = buildEntryLiveCompetitionBoard({
			season: "2026/27",
			eventId: 1,
			tournamentId: 10,
			coreRevision: "core-1",
			playerRevision: "player-1",
			managerRevision: null,
			rosterRevision: secondRosterRevision,
			windowRevision: firstRosterRevision,
			rows: [row],
			totalEntries: 2,
			unavailableEntryIds: [2],
		});

		expect(secondRosterRevision).not.toBe(firstRosterRevision);
		expect(second.boardRevision).not.toBe(first.boardRevision);
		expect(second).toMatchObject({
			totalEntries: 2,
			unavailableEntryIds: [2],
			failedEntryIds: [],
			partial: true,
		});
	});
});

describe("entry live competition board sorting and performance envelope", () => {
	const rows = [
		liveRow({
			entry: 3,
			entryName: "Charlie",
			eventPoints: 12,
			netEventPoints: 8,
			transferCost: 4,
			played: 8,
			totalPoints: 90,
			overallRank: 300,
		}),
		liveRow({
			entry: 1,
			entryName: "Alpha",
			eventPoints: 12,
			netEventPoints: 12,
			transferCost: 0,
			played: 5,
			totalPoints: 110,
			overallRank: 100,
		}),
		liveRow({
			entry: 2,
			entryName: "Bravo",
			eventPoints: 5,
			netEventPoints: 5,
			transferCost: 0,
			played: 9,
			totalPoints: 100,
			overallRank: 200,
		}),
	];

	it("supports the existing table sorts plus lightweight board sorts with entry ID as tie-break", () => {
		const built = board(rows);
		const cases: Array<
			[
				EntryLiveCompetitionBoardRequest["sort"],
				EntryLiveCompetitionBoardRequest["direction"],
				number[],
			]
		> = [
			["EVENT_POINTS", "DESC", [1, 3, 2]],
			["NET_EVENT_POINTS", "DESC", [1, 3, 2]],
			["TRANSFER_COST", "DESC", [3, 1, 2]],
			["PLAYED", "DESC", [2, 3, 1]],
			["TOTAL_POINTS", "DESC", [1, 2, 3]],
			["OVERALL_RANK", "ASC", [1, 2, 3]],
			["TEAM_VALUE", "DESC", [3, 2, 1]],
			["RANK", "ASC", [1, 2, 3]],
			["ENTRY_NAME", "ASC", [1, 2, 3]],
		];
		for (const [sort, direction, expected] of cases) {
			expect(
				queryEntryLiveCompetitionBoard(built, request({ sort, direction })).rows.map(
					(row) => row.entry
				)
			).toEqual(expected);
		}
	});

	it("paginates 500 rows, keeps the first page compact and never exposes pickList", () => {
		const largeRows = Array.from({ length: 500 }, (_, index) =>
			liveRow({ entry: index + 1, eventPoints: index % 80, totalPoints: 1000 + index })
		);
		const startedAt = performance.now();
		const built = board(largeRows);
		const firstPage = queryEntryLiveCompetitionBoard(built, request({ pageSize: 50 }));
		expect(firstPage.filteredEntries).toBe(500);
		expect(firstPage.rows).toHaveLength(50);
		expect(firstPage.hasMore).toBe(true);
		expect(firstPage.rows.some((row) => Object.hasOwn(row, "pickList"))).toBe(false);
		expect(JSON.stringify(firstPage.rows).length).toBeLessThan(100_000);
		expect(performance.now() - startedAt).toBeLessThan(500);
	});

	it("pages a 65-entry tournament against one stable board revision", () => {
		const built = board(
			Array.from({ length: 65 }, (_, index) =>
				liveRow({ entry: index + 1, eventPoints: 65 - index })
			)
		);
		const first = queryEntryLiveCompetitionBoard(built, request());
		const fourth = queryEntryLiveCompetitionBoard(
			built,
			request({
				page: 4,
				expectedBoardRevision: built.boardRevision,
			})
		);

		expect(first.rows).toHaveLength(20);
		expect(first.hasMore).toBe(true);
		expect(fourth.rows).toHaveLength(5);
		expect(fourth.hasMore).toBe(false);
	});

	it("calculates tournament aggregates from official manager scores only", () => {
		const built = board([
			liveRow({ entry: 1, eventPoints: 20 }),
			liveRow({ entry: 2, eventPoints: 10 }),
			liveRow({ entry: 3, eventPoints: 99, source: "UNAVAILABLE" }),
		]);
		expect(built.highestEventPoints).toBe(20);
		expect(built.averageEventPoints).toBe(15);
		expect(built.officialCoverage).toBeCloseTo(2 / 3);
		expect(built.unavailableEntryIds).toEqual([3]);
		expect(built.partial).toBe(true);
	});

	it("requires provable official net semantics for H2H coverage", () => {
		const built = buildEntryLiveCompetitionBoard({
			season: "2026/27",
			eventId: 1,
			tournamentId: 10,
			coreRevision: "core-1",
			playerRevision: "player-1",
			managerRevision: "manager-1",
			totalEntries: 2,
			requireNet: true,
			rows: [
				liveRow({ entry: 1, eventPoints: 20, netEventPoints: null }),
				liveRow({ entry: 2, eventPoints: 12, netEventPoints: 8, transferCost: 4 }),
			],
		});

		expect(built.officialCoverage).toBe(0.5);
		expect(built.highestEventPoints).toBe(8);
		expect(built.averageEventPoints).toBe(8);
		expect(built.unavailableEntryIds).toEqual([1]);
	});
});
