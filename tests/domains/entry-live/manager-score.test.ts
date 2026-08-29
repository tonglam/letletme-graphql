import { describe, expect, it } from "bun:test";
import {
	buildManagerScore,
	isManagerScoreLiveHeartbeatFresh,
	managerScoreHeartbeatRefreshDeadline,
	managerScoreBoardIsFinal,
	rankTournamentRowsByOfficialEventPoints,
} from "../../../src/domains/entry-live/manager-score";
import type { ManagerLiveScoreRow } from "../../../src/infra/manager-live-client";

const checkedAt = new Date().toISOString();

const provenance = {
	scoreSource: "FPL_EVENT_LIVE" as const,
	calculationMode: "PROJECTED_AUTOSUBS" as const,
	algorithmVersion: "fpl-projected-autosubs-v1",
	inputRevision: "input-1",
	scoreRevision: "score-1",
	rankRevision: "rank-1",
	livePublicationId: "00000000-0000-4000-8000-000000000001",
	liveRevision: "8",
	liveCheckedAt: checkedAt,
	picksRevision: "picks-1",
	picksCheckedAt: checkedAt,
	previousTotalsRevision: "totals-1",
	previousTotalsThroughEventId: 0,
	resultRevision: null,
	resultCheckedAt: null,
	dataCheckedAt: null,
	rankSource: "FPL_ENTRY_SUMMARY" as const,
	rankCheckedAt: checkedAt,
};

const row = (overrides: Partial<ManagerLiveScoreRow> = {}): ManagerLiveScoreRow => ({
	season: "2627",
	eventId: 1,
	entryId: 10,
	eventPoints: 42,
	netEventPoints: 42,
	totalPoints: 142,
	totalScope: "OVERALL",
	eventRank: 7,
	overallRank: 101,
	leagueRank: null,
	transferCost: 0,
	eventPointSemantics: "ZERO_COST_EQUIVALENT",
	source: "FPL_EVENT_LIVE",
	revision: "score-1",
	checkedAt,
	upstreamUpdatedAt: checkedAt,
	staleAt: new Date(Date.now() + 90_000).toISOString(),
	calculationMode: "PROJECTED_AUTOSUBS",
	algorithmVersion: "fpl-projected-autosubs-v1",
	provenance,
	...overrides,
});

const finalRow = (overrides: Partial<ManagerLiveScoreRow> = {}): ManagerLiveScoreRow =>
	row({
		source: "FPL_FINAL_RESULT",
		calculationMode: "FINAL_RESULT",
		algorithmVersion: null,
		provenance: {
			...provenance,
			scoreSource: "FPL_FINAL_RESULT",
			calculationMode: "FINAL_RESULT",
			algorithmVersion: null,
			livePublicationId: null,
			liveRevision: null,
			liveCheckedAt: null,
			resultRevision: "result-1",
			resultCheckedAt: checkedAt,
			dataCheckedAt: checkedAt,
			rankSource: null,
			rankCheckedAt: null,
		},
		...overrides,
	});

describe("Data manager score contract", () => {
	it("bounds the shared live heartbeat to the active-live grace", () => {
		const now = Date.now();
		expect(isManagerScoreLiveHeartbeatFresh(new Date(now - 89_000).toISOString(), now)).toBe(true);
		expect(isManagerScoreLiveHeartbeatFresh(new Date(now - 91_000).toISOString(), now)).toBe(false);
	});

	it("caps a wider live-window refresh deadline at heartbeat expiry", () => {
		const heartbeat = "2026-08-29T02:00:00.000Z";
		expect(managerScoreHeartbeatRefreshDeadline(heartbeat, "2026-08-29T02:05:00.000Z")).toBe(
			"2026-08-29T02:01:30.000Z"
		);
		expect(managerScoreHeartbeatRefreshDeadline(heartbeat, "2026-08-29T02:00:30.000Z")).toBe(
			"2026-08-29T02:00:30.000Z"
		);
	});

	it("does not expose a row with the wrong calculation mode as an active authority", () => {
		const result = buildManagerScore({
			row: row({ calculationMode: "FINAL_RESULT" }),
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

	it("keeps a projected headline when the detail lineup is unavailable", () => {
		const result = buildManagerScore({
			row: row({ eventPoints: 61, netEventPoints: 57, totalPoints: 157, transferCost: 4 }),
			upstreamErrorCode: null,
			provisional: true,
			available: false,
			transferCost: 4,
			detailEventPoints: 0,
		});
		expect(result.score).toMatchObject({
			source: "FPL_EVENT_LIVE",
			eventPoints: 61,
			netEventPoints: 57,
			totalPoints: 157,
			reconciliation: "NO_LINEUP",
		});
		expect(result.score.reasonCodes).toContain("MISSING_LINEUP");
		expect(result.headline.livePoints).toBe(61);
	});

	it("uses the Data projected event-live row as the active score authority", () => {
		const result = buildManagerScore({
			row: row({ eventPoints: 37, netEventPoints: 37, totalPoints: 37 }),
			upstreamErrorCode: null,
			provisional: true,
			available: true,
			transferCost: 0,
			detailEventPoints: 37,
		});
		expect(result.score).toMatchObject({
			source: "FPL_EVENT_LIVE",
			eventPoints: 37,
			netEventPoints: 37,
			totalPoints: 37,
			reconciliation: "MATCHED",
		});
		expect(result.headline.livePoints).toBe(37);
	});

	it("changes the row revision when the authoritative rank observation changes", () => {
		const first = buildManagerScore({
			row: row({ revision: "score-1", eventRank: 7 }),
			upstreamErrorCode: null,
			provisional: true,
			available: true,
			transferCost: 0,
			detailEventPoints: 42,
		});
		const second = buildManagerScore({
			row: row({ revision: "score-2", eventRank: 8 }),
			upstreamErrorCode: null,
			provisional: true,
			available: true,
			transferCost: 0,
			detailEventPoints: 42,
		});
		expect(first.score.revision).not.toBe(second.score.revision);
	});

	it("marks an old projected row stale without reverting to a summary", () => {
		const oldCheckedAt = new Date(Date.now() - 45_000).toISOString();
		const result = buildManagerScore({
			row: row({ checkedAt: oldCheckedAt, eventPoints: 39, netEventPoints: 35, transferCost: 4 }),
			upstreamErrorCode: "UPSTREAM_UNAVAILABLE",
			provisional: true,
			available: true,
			transferCost: 4,
			detailEventPoints: 39,
		});
		expect(result.score.state).toBe("STALE");
		expect(result.score.source).toBe("FPL_EVENT_LIVE");
		expect(result.score.reasonCodes).toContain("SOURCE_TOO_OLD");
		expect(result.score.reasonCodes).toContain("UPSTREAM_UNAVAILABLE");
	});

	it("uses a fenced global live heartbeat without mutating immutable row provenance", () => {
		const oldCheckedAt = new Date(Date.now() - 5 * 60_000).toISOString();
		const heartbeatCheckedAt = new Date().toISOString();
		const authority = row({
			checkedAt: oldCheckedAt,
			provenance: {
				...provenance,
				liveCheckedAt: oldCheckedAt,
				rankCheckedAt: oldCheckedAt,
			},
		});
		const result = buildManagerScore({
			row: authority,
			upstreamErrorCode: null,
			provisional: true,
			available: true,
			transferCost: 0,
			detailEventPoints: 42,
			nextRefreshAt: new Date(Date.now() - 4 * 60_000).toISOString(),
			freshnessCheckedAt: heartbeatCheckedAt,
		});

		expect(result.score.state).toBe("FRESH");
		expect(result.score.reasonCodes).not.toContain("SOURCE_TOO_OLD");
		expect(result.score.checkedAt).toBe(oldCheckedAt);
		expect(result.score.provenance?.liveCheckedAt).toBe(oldCheckedAt);
		expect(result.score.revision).toBe(authority.revision);
		expect(result.score.eventRank).toBeNull();
		expect(result.score.overallRank).toBeNull();
		expect(result.score.leagueRank).toBeNull();
		expect(result.score.nextRefreshAt).toBe(
			new Date(Date.parse(heartbeatCheckedAt) + 90_000).toISOString()
		);
	});

	it("reconciles gross event points, net points, and transfer cost from Data", () => {
		const result = buildManagerScore({
			row: row({
				eventPoints: 46,
				netEventPoints: 42,
				totalPoints: 142,
				transferCost: 4,
				eventPointSemantics: "GROSS",
			}),
			upstreamErrorCode: null,
			provisional: true,
			available: true,
			transferCost: 4,
			detailEventPoints: 46,
		});
		expect(result.score).toMatchObject({
			eventPoints: 46,
			netEventPoints: 42,
			totalPoints: 142,
			eventPointSemantics: "GROSS",
			reconciliation: "MATCHED",
		});
	});

	it("does not match an unknown-semantics row from net points alone", () => {
		const result = buildManagerScore({
			row: row({
				eventPoints: 999,
				netEventPoints: 42,
				eventPointSemantics: "UNKNOWN",
			}),
			upstreamErrorCode: null,
			provisional: true,
			available: true,
			transferCost: 0,
			detailEventPoints: 42,
		});
		expect(result.score.reconciliation).toBe("SOURCE_SKEW");
		expect(result.score.reasonCodes).toContain("SOURCE_SKEW");
	});

	it("fails closed when the Data row has no score values", () => {
		const result = buildManagerScore({
			row: row({ eventPoints: null, netEventPoints: null, totalPoints: null }),
			upstreamErrorCode: null,
			provisional: true,
			available: true,
			transferCost: 0,
			detailEventPoints: 39,
		});
		expect(result.score.source).toBe("FPL_EVENT_LIVE");
		expect(result.score.eventPoints).toBeNull();
		expect(result.score.reasonCodes).toContain("MISSING_SCORE");
	});

	it("fails closed when no Data row is available", () => {
		const result = buildManagerScore({
			upstreamErrorCode: "UPSTREAM_UNAVAILABLE",
			provisional: true,
			available: true,
			transferCost: 4,
			detailEventPoints: 39,
		});
		expect(result.score.source).toBe("UNAVAILABLE");
		expect(result.score.reasonCodes).toContain("UPSTREAM_UNAVAILABLE");
	});

	it("fails closed when the transfer cost is unavailable", () => {
		const result = buildManagerScore({
			row: row({ transferCost: null }),
			upstreamErrorCode: null,
			provisional: true,
			available: true,
			transferCost: null,
			detailEventPoints: 42,
		});
		expect(result.score.source).toBe("UNAVAILABLE");
		expect(result.score.eventPoints).toBeNull();
	});

	it("uses the persisted final result only after data_checked", () => {
		const result = buildManagerScore({
			row: finalRow({ eventPoints: 42, netEventPoints: 42, totalPoints: 142 }),
			upstreamErrorCode: null,
			provisional: false,
			available: true,
			transferCost: 0,
			detailEventPoints: 42,
		});
		expect(result.score.state).toBe("FINAL");
		expect(result.score.source).toBe("FPL_FINAL_RESULT");
		expect(result.score.nextRefreshAt).toBeNull();
		expect(managerScoreBoardIsFinal([{ score: result.score }])).toBe(true);
	});

	it("does not accept a final-result row during the provisional phase", () => {
		const result = buildManagerScore({
			row: finalRow(),
			upstreamErrorCode: null,
			provisional: true,
			available: true,
			transferCost: 0,
			detailEventPoints: 42,
		});
		expect(result.score.source).toBe("UNAVAILABLE");
	});

	it("ranks tournament rows from event-live points and leaves unavailable rows unranked", () => {
		const live = (entry: number, eventPoints: number) => ({
			entry,
			rank: 0,
			score: buildManagerScore({
				row: row({
					entryId: entry,
					eventPoints,
					netEventPoints: eventPoints,
					totalPoints: eventPoints,
				}),
				upstreamErrorCode: null,
				provisional: true,
				available: true,
				transferCost: 0,
				detailEventPoints: eventPoints,
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

	it("ranks tournament rows from event-live net points", () => {
		const netRow = (entry: number, eventPoints: number, transferCost: number) => ({
			entry,
			rank: 0,
			score: buildManagerScore({
				row: row({
					entryId: entry,
					eventPoints,
					netEventPoints: eventPoints - transferCost,
					totalPoints: 100 + eventPoints - transferCost,
					transferCost,
					eventPointSemantics: transferCost > 0 ? "GROSS" : "ZERO_COST_EQUIVALENT",
				}),
				upstreamErrorCode: null,
				provisional: true,
				available: true,
				transferCost,
				detailEventPoints: eventPoints,
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
