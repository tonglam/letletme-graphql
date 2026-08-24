import { describe, expect, it } from "bun:test";
import {
	buildManagerScore,
	managerScoreBoardIsFinal,
	rankTournamentRowsByOfficialEventPoints,
} from "../../../src/domains/entry-live/manager-score";

const row = (overrides: Record<string, unknown> = {}) => ({
	season: "2627",
	eventId: 1,
	entryId: 10,
	eventPoints: 42,
	netEventPoints: null,
	totalPoints: 142,
	totalScope: "OVERALL" as const,
	eventRank: 7,
	overallRank: 101,
	leagueRank: null,
	transferCost: null,
	eventPointSemantics: "UNKNOWN" as const,
	source: "FPL_ENTRY_SUMMARY" as const,
	revision: "r1",
	checkedAt: new Date().toISOString(),
	upstreamUpdatedAt: null,
	staleAt: new Date(Date.now() + 90_000).toISOString(),
	...overrides,
});

const authority = (checkedAt = new Date().toISOString()) => ({
	revision: "live-8",
	checkedAt,
});

describe("event-live manager score contract", () => {
	it("does not expose an entry-summary score without a traceable lineup", () => {
		const result = buildManagerScore({
			row: row(),
			upstreamErrorCode: null,
			provisional: true,
			available: false,
			transferCost: 0,
			detailEventPoints: 0,
		});
		expect(result.score.source).toBe("UNAVAILABLE");
		expect(result.score.reconciliation).toBe("NO_LINEUP");
		expect(result.score.reasonCodes).toContain("MISSING_LINEUP");
		expect(result.headline.livePoints).toBe(0);
	});

	it("uses official event-live player totals as the active score authority", () => {
		const result = buildManagerScore({
			row: row({ eventPoints: 23, totalPoints: 23 }),
			upstreamErrorCode: null,
			provisional: true,
			available: true,
			transferCost: 0,
			detailEventPoints: 37,
			previousOverallPoints: 0,
			eventLiveAuthority: authority(),
		});
		expect(result.score.source).toBe("FPL_EVENT_LIVE");
		expect(result.score.eventPoints).toBe(37);
		expect(result.score.netEventPoints).toBe(37);
		expect(result.score.totalPoints).toBe(37);
		expect(result.score.eventPointSemantics).toBe("ZERO_COST_EQUIVALENT");
		expect(result.score.reconciliation).toBe("SOURCE_SKEW");
		expect(result.headline.livePoints).toBe(37);
	});

	it("marks an old event-live revision stale without reverting to manager summary", () => {
		const checkedAt = new Date(Date.now() - 45_000).toISOString();
		const result = buildManagerScore({
			row: row({ eventPoints: 42 }),
			upstreamErrorCode: "UPSTREAM_UNAVAILABLE",
			provisional: true,
			available: true,
			transferCost: 4,
			detailEventPoints: 39,
			previousOverallPoints: 100,
			eventLiveAuthority: authority(checkedAt),
		});
		expect(result.score.state).toBe("STALE");
		expect(result.score.source).toBe("FPL_EVENT_LIVE");
		expect(result.score.eventPoints).toBe(39);
		expect(result.score.netEventPoints).toBe(35);
		expect(result.score.reasonCodes).toContain("SOURCE_TOO_OLD");
		expect(result.score.reasonCodes).toContain("UPSTREAM_UNAVAILABLE");
	});

	it("derives net and season totals from event-live plus the finalized baseline", () => {
		const result = buildManagerScore({
			row: row({ eventPoints: 41, totalPoints: 141 }),
			upstreamErrorCode: null,
			provisional: true,
			available: true,
			transferCost: 4,
			previousOverallPoints: 100,
			detailEventPoints: 46,
			eventLiveAuthority: authority(),
		});
		expect(result.score.eventPointSemantics).toBe("GROSS");
		expect(result.score.eventPoints).toBe(46);
		expect(result.score.netEventPoints).toBe(42);
		expect(result.score.totalPoints).toBe(142);
		expect(result.score.totalScope).toBe("OVERALL");
	});

	it("remains event-live authoritative when manager metadata has no score", () => {
		const result = buildManagerScore({
			row: row({ eventPoints: null, totalPoints: null, totalScope: "CLASSIC_PHASE" }),
			upstreamErrorCode: null,
			provisional: true,
			available: true,
			previousOverallPoints: 100,
			transferCost: 4,
			detailEventPoints: 39,
			eventLiveAuthority: authority(),
		});
		expect(result.score.source).toBe("FPL_EVENT_LIVE");
		expect(result.score.eventPoints).toBe(39);
		expect(result.score.netEventPoints).toBe(35);
		expect(result.score.totalPoints).toBe(135);
	});

	it("does not require entry-summary metadata to expose a traceable live score", () => {
		const result = buildManagerScore({
			upstreamErrorCode: "UPSTREAM_UNAVAILABLE",
			provisional: true,
			available: true,
			transferCost: 4,
			detailEventPoints: 39,
			previousOverallPoints: 100,
			eventLiveAuthority: authority(),
		});
		expect(result.score.source).toBe("FPL_EVENT_LIVE");
		expect(result.score.state).toBe("FRESH");
		expect(result.headline).toEqual({
			rank: 0,
			livePoints: 39,
			liveNetPoints: 35,
			liveTotalPoints: 135,
		});
	});

	it("fails closed when event-live provenance has no usable revision or timestamp", () => {
		for (const eventLiveAuthority of [
			{ revision: "", checkedAt: new Date().toISOString() },
			{ revision: "live-8", checkedAt: "not-a-timestamp" },
		]) {
			const result = buildManagerScore({
				row: row({ eventPoints: 23 }),
				upstreamErrorCode: null,
				provisional: true,
				available: true,
				transferCost: 0,
				detailEventPoints: 37,
				previousOverallPoints: 0,
				eventLiveAuthority,
			});
			expect(result.score.source).toBe("UNAVAILABLE");
			expect(result.score.eventPoints).toBeNull();
		}
	});

	it("uses the persisted final result only after FPL data_checked", () => {
		const result = buildManagerScore({
			row: row({
				source: "FPL_FINAL_RESULT",
				eventPointSemantics: "ZERO_COST_EQUIVALENT",
			}),
			upstreamErrorCode: null,
			provisional: false,
			available: true,
			transferCost: 0,
			detailEventPoints: 42,
			eventLiveAuthority: authority(),
		});
		expect(result.score.state).toBe("FINAL");
		expect(result.score.source).toBe("FPL_FINAL_RESULT");
		expect(result.score.nextRefreshAt).toBeNull();
		expect(managerScoreBoardIsFinal([{ score: result.score }])).toBe(true);
	});

	it("ranks tournament rows from event-live points and leaves unavailable rows unranked", () => {
		const live = (entry: number, eventPoints: number) => ({
			entry,
			rank: 0,
			score: buildManagerScore({
				row: row({ entryId: entry, eventPoints }),
				upstreamErrorCode: null,
				provisional: true,
				available: true,
				transferCost: 0,
				detailEventPoints: eventPoints,
				previousOverallPoints: 0,
				eventLiveAuthority: authority(),
			}).score,
		});
		const unavailable = {
			entry: 3,
			rank: 0,
			score: buildManagerScore({
				upstreamErrorCode: "UPSTREAM_UNAVAILABLE",
				provisional: true,
				available: false,
				transferCost: 0,
				detailEventPoints: 99,
			}).score,
		};
		const ranked = rankTournamentRowsByOfficialEventPoints([live(1, 12), live(2, 12), unavailable]);
		expect(ranked.find((item) => item.entry === 1)?.rank).toBe(1);
		expect(ranked.find((item) => item.entry === 2)?.rank).toBe(1);
		expect(ranked.find((item) => item.entry === 3)?.rank).toBe(0);
	});

	it("ranks H2H rows from event-live-derived net points", () => {
		const netRow = (entry: number, eventPoints: number, transferCost: number) => ({
			entry,
			rank: 0,
			score: buildManagerScore({
				row: row({ entryId: entry }),
				upstreamErrorCode: null,
				provisional: true,
				available: true,
				transferCost,
				previousOverallPoints: 100,
				detailEventPoints: eventPoints,
				eventLiveAuthority: authority(),
			}).score,
		});
		const ranked = rankTournamentRowsByOfficialEventPoints(
			[netRow(1, 20, 0), netRow(2, 21, 1), netRow(3, 22, 1)],
			{ useNet: true }
		);

		expect(ranked.find((item) => item.entry === 1)?.rank).toBe(2);
		expect(ranked.find((item) => item.entry === 2)?.rank).toBe(2);
		expect(ranked.find((item) => item.entry === 3)?.rank).toBe(1);
	});
});
