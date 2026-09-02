import { describe, expect, it } from "bun:test";
import {
	queryEntryLiveCompetitionBoardV2,
	type EntryLiveCompetitionBoardRequest,
	type EntryLiveCompetitionBoardV2,
} from "../../../src/domains/live-desks/v2-board";
import type { LeagueLiveManifestV2 } from "../../../src/domains/live-desks/league-v2";
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
	eventPoints: number,
	netEventPoints: number
): EntryLiveCompetitionBoardV2["rows"][number] => ({
	availability: "READY",
	entry,
	entryName: `Entry ${entry}`,
	playerName: "Manager",
	liveRank: null,
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

const noPicksRow = (entry: number): EntryLiveCompetitionBoardV2["rows"][number] => ({
	...row(entry, 0, 0),
	availability: "MISSING",
	liveRank: null,
	score: null,
	transferCost: null,
	played: null,
	toPlay: null,
	captainId: null,
	captainName: null,
	captainPoints: null,
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
	first: 20,
	after: null,
	sort: "NET_EVENT_POINTS",
	direction,
	search: "",
	chips: [],
	captainPlayerIds: [],
	ownership: null,
	teamCountRules: [],
});

const manifest: LeagueLiveManifestV2 = {
	contractVersion: "live-points-v2",
	publicationId: "00000000-0000-4000-8000-000000000002",
	generation: 1,
	season: "2627",
	eventId: 1,
	tournamentId: 1,
	scope: "CLASSIC",
	state: "LIVE_ACTIVE",
	globalRef: {
		publicationId: "00000000-0000-4000-8000-000000000001",
		generation: 1,
	},
	revisions: {
		roster: "r".repeat(64),
		scoreCore: "s".repeat(64),
		fixtureIdentity: "f".repeat(64),
		entryInputSet: "i".repeat(64),
		identity: "d".repeat(64),
		officialRank: null,
		rules: "u".repeat(64),
		algorithm: "a".repeat(64),
		schedule: null,
		averageSide: null,
		content: "c".repeat(64),
	},
	times: {
		sourceCheckedAt: "2026-08-30T00:00:00.000Z",
		contentUpdatedAt: "2026-08-30T00:00:00.000Z",
		publishedAt: "2026-08-30T00:00:00.000Z",
		checkpointedAt: null,
		expectedNextCheckAt: "2026-08-30T00:00:30.000Z",
	},
	counts: { expected: 2, published: 2, ready: 1, noPicks: 1 },
	items: {
		index: {
			name: "index",
			key: "index",
			type: "string",
			count: 2,
			bytes: 1,
			sha256: "1".repeat(64),
		},
		payload: {
			name: "payload",
			key: "payload",
			type: "string",
			count: 2,
			bytes: 1,
			sha256: "2".repeat(64),
		},
	},
};

describe("live competition board sorting", () => {
	it("keeps unavailable rows after real negative net scores in both directions", () => {
		const board: EntryLiveCompetitionBoardV2 = {
			publication: manifest,
			servedFrom: "REDIS_CURRENT",
			boardRevision: "board",
			scoreCoreRevision: "score-core",
			rows: [noPicksRow(2), row(1, -2, -5)],
			totalEntries: 2,
			highestEventPoints: -2,
			averageEventPoints: -2,
		};

		expect(
			queryEntryLiveCompetitionBoardV2(board, request("DESC")).rows.map((item) => item.entry)
		).toEqual([1, 2]);
		expect(
			queryEntryLiveCompetitionBoardV2(board, request("ASC")).rows.map((item) => item.entry)
		).toEqual([1, 2]);
	});

	it("sorts official overall rank independently from live rank", () => {
		const board: EntryLiveCompetitionBoardV2 = {
			publication: manifest,
			servedFrom: "REDIS_CURRENT",
			boardRevision: "board",
			scoreCoreRevision: "score-core",
			rows: [
				{ ...row(1, 10, 10), overallRank: 2, liveRank: 1 },
				{ ...row(2, 1, 1), overallRank: 1, liveRank: 2 },
			],
			totalEntries: 2,
			highestEventPoints: 10,
			averageEventPoints: 5.5,
		};
		const result = queryEntryLiveCompetitionBoardV2(board, {
			...request("ASC"),
			sort: "OVERALL_RANK",
		});

		expect(result.rows.map((item) => item.entry)).toEqual([2, 1]);
	});
});
