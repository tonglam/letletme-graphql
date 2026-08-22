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

describe("official manager live score contract", () => {
	it("uses an official headline even when picks are unavailable", () => {
		const result = buildManagerScore({
			row: row(),
			upstreamErrorCode: null,
			provisional: true,
			available: false,
			transferCost: 0,
			detailEventPoints: 0,
		});
		expect(result.score.source).toBe("FPL_ENTRY_SUMMARY");
		expect(result.score.reconciliation).toBe("NO_LINEUP");
		expect(result.headline.livePoints).toBe(42);
	});

	it("keeps a recently checked official row marked stale", () => {
		const checkedAt = new Date(Date.now() - 45_000);
		const result = buildManagerScore({
			row: row({
				checkedAt: checkedAt.toISOString(),
				staleAt: new Date(checkedAt.getTime() + 90_000).toISOString(),
			}),
			upstreamErrorCode: "UPSTREAM_UNAVAILABLE",
			provisional: true,
			available: true,
			transferCost: 4,
			detailEventPoints: 39,
		});
		expect(result.score.state).toBe("STALE");
		expect(result.score.source).toBe("FPL_ENTRY_SUMMARY");
		expect(result.score.reconciliation).toBe("SOURCE_SKEW");
	});

	it("classifies official event points against the previous overall baseline", () => {
		const net = buildManagerScore({
			row: row({ totalPoints: 142, eventPoints: 42 }),
			upstreamErrorCode: null,
			provisional: true,
			available: true,
			transferCost: 4,
			previousOverallPoints: 100,
			detailEventPoints: 42,
		});
		expect(net.score.eventPointSemantics).toBe("NET");
		expect(net.score.netEventPoints).toBe(42);

		const gross = buildManagerScore({
			row: row({ totalPoints: 142, eventPoints: 46 }),
			upstreamErrorCode: null,
			provisional: true,
			available: true,
			transferCost: 4,
			previousOverallPoints: 100,
			detailEventPoints: 42,
		});
		expect(gross.score.eventPointSemantics).toBe("GROSS");
		expect(gross.score.netEventPoints).toBe(42);
	});

	it("keeps the last-good official value when the upstream refresh is too old", () => {
		const checkedAt = new Date(Date.now() - 11 * 60_000);
		const result = buildManagerScore({
			row: row({
				checkedAt: checkedAt.toISOString(),
				staleAt: new Date(checkedAt.getTime() + 90_000).toISOString(),
			}),
			upstreamErrorCode: "UPSTREAM_UNAVAILABLE",
			provisional: true,
			available: true,
			transferCost: 4,
			detailEventPoints: 39,
		});
		expect(result.score.source).toBe("FPL_ENTRY_SUMMARY");
		expect(result.score.state).toBe("STALE");
		expect(result.score.eventPoints).toBe(42);
		expect(result.score.reasonCodes).toContain("UPSTREAM_UNAVAILABLE");
	});

	it("does not use local totals while an official row is missing its score", () => {
		const result = buildManagerScore({
			row: row({
				eventPoints: null,
				totalPoints: null,
				totalScope: "CLASSIC_PHASE",
			}),
			upstreamErrorCode: null,
			provisional: true,
			available: true,
			previousOverallPoints: 100,
			transferCost: 4,
			detailEventPoints: 39,
		});
		expect(result.score.reasonCodes).toContain("MISSING_SCORE");
		expect(result.headline.livePoints).toBe(0);
		expect(result.headline.liveNetPoints).toBe(0);
		expect(result.headline.liveTotalPoints).toBe(0);
	});

	it("does not expose detail points when the official manager row is absent", () => {
		const result = buildManagerScore({
			upstreamErrorCode: "UPSTREAM_UNAVAILABLE",
			provisional: true,
			available: true,
			transferCost: 4,
			detailEventPoints: 39,
		});
		expect(result.score.source).toBe("UNAVAILABLE");
		expect(result.score.state).toBe("UNAVAILABLE");
		expect(result.headline).toEqual({
			rank: 0,
			livePoints: 0,
			liveNetPoints: 0,
			liveTotalPoints: 0,
		});
	});

	it("stops manager refresh after a final official result", () => {
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
		});
		expect(result.score.state).toBe("FINAL");
		expect(result.score.nextRefreshAt).toBeNull();
		expect(managerScoreBoardIsFinal([{ score: result.score }])).toBe(true);
	});

	it("ranks tournament rows from official event points and leaves unavailable rows unranked", () => {
		const official = (entry: number, eventPoints: number) => ({
			entry,
			rank: 0,
			score: {
				...buildManagerScore({
					row: row({ entryId: entry, eventPoints }),
					upstreamErrorCode: null,
					provisional: true,
					available: true,
					transferCost: 0,
					detailEventPoints: eventPoints,
				}).score,
			},
		});
		const unavailable = {
			entry: 3,
			rank: 0,
			score: buildManagerScore({
				upstreamErrorCode: "UPSTREAM_UNAVAILABLE",
				provisional: true,
				available: true,
				transferCost: 0,
				detailEventPoints: 99,
			}).score,
		};
		const ranked = rankTournamentRowsByOfficialEventPoints([
			official(1, 12),
			official(2, 12),
			unavailable,
		]);
		expect(ranked.find((item) => item.entry === 1)?.rank).toBe(1);
		expect(ranked.find((item) => item.entry === 2)?.rank).toBe(1);
		expect(ranked.find((item) => item.entry === 3)?.rank).toBe(0);
	});

	it("ranks H2H rows only from explicit official net points", () => {
		const netRow = (
			entry: number,
			eventPoints: number,
			totalPoints: number,
			previousOverallPoints: number,
			transferCost: number
		) => ({
			entry,
			rank: 0,
			score: buildManagerScore({
				row: row({ entryId: entry, eventPoints, totalPoints }),
				upstreamErrorCode: null,
				provisional: true,
				available: true,
				transferCost,
				previousOverallPoints,
				detailEventPoints: eventPoints,
			}).score,
		});
		const ranked = rankTournamentRowsByOfficialEventPoints(
			[
				netRow(1, 20, 120, 100, 0),
				netRow(2, 21, 120, 100, 1),
				{
					entry: 3,
					rank: 0,
					score: buildManagerScore({
						row: row({ entryId: 3, eventPoints: 22 }),
						upstreamErrorCode: null,
						provisional: true,
						available: true,
						transferCost: 0,
						detailEventPoints: 22,
					}).score,
				},
			],
			{ useNet: true }
		);

		expect(ranked.find((item) => item.entry === 1)?.rank).toBe(1);
		expect(ranked.find((item) => item.entry === 2)?.rank).toBe(1);
		expect(ranked.find((item) => item.entry === 3)?.rank).toBe(0);
	});
});
