import { describe, expect, it } from "bun:test";
import {
	queryEntryLiveCompetitionBoardV2,
	withBoardReadDelivery,
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
		expect(result.rows.map((item) => item.liveRank)).toEqual([1, 2]);
	});
});

describe("live competition board selected-metric ranks", () => {
	const board = (): EntryLiveCompetitionBoardV2 => ({
		publication: manifest,
		servedFrom: "REDIS_CURRENT",
		boardRevision: "board",
		scoreCoreRevision: "score-core",
		rows: [256, 250, 241, 241, 240].map((value, index) => ({
			...row(index + 1, 50 + index, 50 + index),
			liveRank: 5 - index,
			score: { ...score(50 + index, 50 + index), totalPoints: value },
			overallRank: value,
			teamValue: value / 10,
			transferCost: value,
			played: value,
		})),
		totalEntries: 5,
		highestEventPoints: 54,
		averageEventPoints: 52,
	});
	const totals = { ...request("DESC"), sort: "TOTAL_POINTS" as const };

	it("changes ranks with the metric and direction without mutating the cached board", () => {
		const source = board();
		const original = structuredClone(source);
		const query = (input: EntryLiveCompetitionBoardRequest) =>
			queryEntryLiveCompetitionBoardV2(source, input).rows.map((item) => [
				item.entry,
				item.liveRank,
			]);
		expect(query(totals)).toEqual([
			[1, 1],
			[2, 2],
			[3, 3],
			[4, 3],
			[5, 5],
		]);
		expect(query({ ...totals, direction: "ASC" })).toEqual([
			[5, 1],
			[3, 2],
			[4, 2],
			[2, 4],
			[1, 5],
		]);
		expect(query({ ...totals, sort: "EVENT_POINTS" })).toEqual([
			[5, 1],
			[4, 2],
			[3, 3],
			[2, 4],
			[1, 5],
		]);
		expect(source).toEqual(original);
	});

	for (const sort of [
		"TOTAL_POINTS",
		"OVERALL_RANK",
		"TEAM_VALUE",
		"TRANSFER_COST",
		"PLAYED",
	] as const) {
		it(`uses equal ${sort} values for ties, independent of entry and event rank`, () => {
			const result = queryEntryLiveCompetitionBoardV2(board(), { ...totals, sort });
			expect(result.rows.map((item) => item.liveRank)).toEqual([1, 2, 3, 3, 5]);
		});
	}

	it("preserves a tie across pages and returns the same rank for the pinned viewer", () => {
		const source = board();
		const input = { ...totals, first: 3, entryId: 4 };
		const first = queryEntryLiveCompetitionBoardV2(source, input);
		const second = queryEntryLiveCompetitionBoardV2(source, {
			...input,
			after: first.pageInfo.endCursor,
		});
		expect(first.rows.map((item) => item.liveRank)).toEqual([1, 2, 3]);
		expect(first.viewerRow?.liveRank).toBe(3);
		expect(second.rows.map((item) => item.liveRank)).toEqual([3, 5]);
		expect(first.viewerRow).toEqual(second.rows[0]!);
		expect(second.pageInfo.hasNextPage).toBe(false);
	});

	it("retains league-wide ranks when search or ownership filters hide earlier teams", () => {
		const source = board();
		source.rows[3]!.ownerAny = [99];
		for (const filter of [
			{ search: "Entry 4" },
			{ ownership: { playerIds: [99], scope: "ANY" as const, captainMode: "ANY" as const } },
		]) {
			const result = queryEntryLiveCompetitionBoardV2(source, { ...totals, ...filter, entryId: 4 });
			expect(result.filteredEntries).toBe(1);
			expect(result.rows.map((item) => item.liveRank)).toEqual([3]);
			expect(result.viewerRow?.liveRank).toBe(3);
		}
	});

	it("leaves missing metrics and unavailable rows unranked in either direction", () => {
		const source = board();
		source.rows = [...source.rows, { ...row(6, 0, 0), overallRank: null }, noPicksRow(7)];
		for (const direction of ["ASC", "DESC"] as const) {
			const result = queryEntryLiveCompetitionBoardV2(source, {
				...totals,
				sort: "OVERALL_RANK",
				direction,
			});
			expect(result.rows.slice(-2).map((item) => [item.entry, item.liveRank])).toEqual([
				[6, null],
				[7, null],
			]);
		}
	});

	it("keeps canonical event ranks for explicit rank and name ordering", () => {
		const source = board();
		for (const sort of ["RANK", "ENTRY_NAME"] as const) {
			const result = queryEntryLiveCompetitionBoardV2(source, { ...totals, sort });
			for (const item of result.rows) expect(item.liveRank).toBe(6 - item.entry);
		}
	});
});

describe("live competition board cached delivery provenance", () => {
	const freshnessPublication = {
		sourceCheckedAt: "2099-08-30T00:00:00.000Z",
		expectedNextCheckAt: "2099-08-30T00:00:30.000Z",
	};

	it("refreshes same-generation league cadence without changing cached scores or publication identity", () => {
		const cached: EntryLiveCompetitionBoardV2 = {
			publication: manifest,
			servedFrom: "REDIS_CURRENT",
			boardRevision: "board",
			scoreCoreRevision: "score-core",
			rows: [row(1, 10, 10)],
			totalEntries: 1,
			highestEventPoints: 10,
			averageEventPoints: 10,
		};
		const oldTimes = { ...cached.publication.times };
		const observedPublication = {
			...cached.publication,
			times: {
				...cached.publication.times,
				sourceCheckedAt: "2099-08-30T00:00:00.000Z",
				expectedNextCheckAt: "2099-08-30T00:05:00.000Z",
				checkpointedAt: "2099-08-30T00:00:01.000Z",
			},
		};
		const refreshed = withBoardReadDelivery(
			cached,
			"REDIS_CURRENT",
			freshnessPublication,
			observedPublication
		);
		expect(refreshed.publication.times).toEqual(observedPublication.times);
		expect(refreshed.publication.publicationId).toBe(cached.publication.publicationId);
		expect(refreshed.publication.generation).toBe(cached.publication.generation);
		expect(refreshed.boardRevision).toBe(cached.boardRevision);
		expect(
			refreshed.rows.map((item) => [item.entry, item.liveRank, item.score?.eventPoints])
		).toEqual(cached.rows.map((item) => [item.entry, item.liveRank, item.score?.eventPoints]));
		expect(cached.publication.times).toEqual(oldTimes);
		expect(withBoardReadDelivery(cached, "PROCESS_LKG").publication).toBe(cached.publication);
	});

	it("recovers an exact cached projection after Redis current becomes readable again", () => {
		const cachedRow = row(1, 10, 10);
		cachedRow.score = {
			...cachedRow.score!,
			delivery: {
				state: "DEGRADED",
				servedFrom: "PROCESS_LKG",
				reasonCodes: ["FALLBACK_SERVED", "LEAGUE_PUBLICATION_FALLBACK"],
			},
		};
		const cached: EntryLiveCompetitionBoardV2 = {
			publication: manifest,
			servedFrom: "PROCESS_LKG",
			boardRevision: "board",
			scoreCoreRevision: "score-core",
			rows: [cachedRow],
			totalEntries: 1,
			highestEventPoints: 10,
			averageEventPoints: 10,
		};

		const recovered = withBoardReadDelivery(cached, "REDIS_CURRENT", freshnessPublication);

		expect(recovered.servedFrom).toBe("REDIS_CURRENT");
		expect(recovered.rows[0]?.score?.delivery).toEqual({
			state: "FRESH",
			servedFrom: "REDIS_CURRENT",
			reasonCodes: [],
		});
	});

	it("keeps independently worse row provenance while the board source recovers", () => {
		const cachedRow = row(1, 10, 10);
		cachedRow.score = {
			...cachedRow.score!,
			delivery: {
				state: "DEGRADED",
				servedFrom: "POSTGRES_CHECKPOINT",
				reasonCodes: ["FALLBACK_SERVED", "LEAGUE_PUBLICATION_FALLBACK"],
			},
		};
		const cached: EntryLiveCompetitionBoardV2 = {
			publication: manifest,
			servedFrom: "PROCESS_LKG",
			boardRevision: "board",
			scoreCoreRevision: "score-core",
			rows: [cachedRow],
			totalEntries: 1,
			highestEventPoints: 10,
			averageEventPoints: 10,
		};

		const recovered = withBoardReadDelivery(cached, "REDIS_CURRENT", freshnessPublication);

		expect(recovered.servedFrom).toBe("REDIS_CURRENT");
		expect(recovered.rows[0]?.score?.delivery.servedFrom).toBe("POSTGRES_CHECKPOINT");
		expect(recovered.rows[0]?.score?.delivery.state).toBe("DEGRADED");
	});

	it("downgrades a cached current projection when this request uses fallback", () => {
		const cached: EntryLiveCompetitionBoardV2 = {
			publication: manifest,
			servedFrom: "REDIS_CURRENT",
			boardRevision: "board",
			scoreCoreRevision: "score-core",
			rows: [row(1, 10, 10)],
			totalEntries: 1,
			highestEventPoints: 10,
			averageEventPoints: 10,
		};

		const degraded = withBoardReadDelivery(cached, "PROCESS_LKG");

		expect(degraded.servedFrom).toBe("PROCESS_LKG");
		expect(degraded.rows[0]?.score?.delivery).toMatchObject({
			state: "DEGRADED",
			servedFrom: "PROCESS_LKG",
		});
		expect(degraded.rows[0]?.score?.delivery.reasonCodes).toContain("LEAGUE_PUBLICATION_FALLBACK");
	});
});
