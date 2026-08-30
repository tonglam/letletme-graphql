import { describe, expect, it } from "bun:test";
import {
	queryEntryLiveCompetitionBoardV2,
	type EntryLiveCompetitionBoardRequest,
	type EntryLiveCompetitionBoardV2,
	type IndexedEntryLiveCompetitionBoardRowV2,
} from "../../../src/domains/live-desks/v2-board";
import type { LiveScoreV2 } from "../../../src/domains/entry-live/v2-service";

const score = (eventPoints: number, netEventPoints: number): LiveScoreV2 => ({
	eventPoints,
	netEventPoints,
	totalPoints: eventPoints,
	totalScope: "OVERALL",
	transferCost: 0,
	source: "FPL_EVENT_LIVE",
	calculationMode: "PROJECTED_AUTOSUBS",
	revisions: {
		publicationId: "00000000-0000-4000-8000-000000000001",
		generation: 1,
		lifecycle: "lifecycle",
		fixtureIdentity: "fixture",
		scoreCore: "score-core",
		displayStats: "display",
		explain: "explain",
		picksBase: "picks",
		officialAdjustment: null,
		previousTotals: null,
		finalResult: null,
		rules: "rules",
		algorithm: "algorithm",
		input: "input",
	},
	times: {
		sourceCheckedAt: "2026-08-30T00:00:00.000Z",
		contentUpdatedAt: "2026-08-30T00:00:00.000Z",
		publishedAt: "2026-08-30T00:00:00.000Z",
		checkpointedAt: null,
		servedAt: "2026-08-30T00:00:00.000Z",
		staleAt: "2026-08-30T00:00:00.000Z",
		nextRefreshAt: null,
	},
	delivery: {
		state: "FRESH",
		servedFrom: "REDIS_CURRENT",
		reasonCodes: [],
	},
});

const row = (
	entry: number,
	rank: number,
	eventPoints: number,
	netEventPoints: number
): IndexedEntryLiveCompetitionBoardRowV2 => ({
	entry,
	entryName: `Entry ${entry}`,
	playerName: "Manager",
	rank,
	overallRank: null,
	teamValue: 100,
	chip: "NONE",
	transferCost: 0,
	played: 1,
	toPlay: 0,
	captainId: 1,
	captainName: "Captain",
	captainPoints: eventPoints,
	score: score(eventPoints, netEventPoints),
	searchText: `entry ${entry} manager`,
	ownerAny: [],
	ownerStarter: [],
	ownerBench: [],
	captains: [],
	viceCaptains: [],
	teamAny: [],
	teamStarter: [],
	teamBench: [],
});

const request = (
	direction: EntryLiveCompetitionBoardRequest["direction"]
): EntryLiveCompetitionBoardRequest => ({
	entryId: 1,
	tournamentId: 1,
	eventId: 1,
	page: 1,
	pageSize: 20,
	sort: "NET_EVENT_POINTS",
	direction,
	search: "",
	chips: [],
	captainPlayerIds: [],
	ownership: null,
	teamCountRules: [],
	expectedBoardRevision: null,
});

describe("live competition board sorting", () => {
	it("keeps unavailable rows after real negative net scores in both directions", () => {
		const board: EntryLiveCompetitionBoardV2 = {
			boardRevision: "board",
			scoreCoreRevision: "score-core",
			rows: [row(2, 0, 0, 0), row(1, 1, -2, -5)],
			unavailableEntryIds: [2],
			failedEntryIds: [],
			computedEntries: 1,
			deferredEntryCount: 0,
			failedEntryCount: 0,
			unavailableEntryCount: 1,
			totalEntries: 2,
			highestEventPoints: -2,
			averageEventPoints: -2,
			partial: true,
		};

		expect(
			queryEntryLiveCompetitionBoardV2(board, request("DESC")).rows.map((item) => item.entry)
		).toEqual([1, 2]);
		expect(
			queryEntryLiveCompetitionBoardV2(board, request("ASC")).rows.map((item) => item.entry)
		).toEqual([1, 2]);
	});
});
