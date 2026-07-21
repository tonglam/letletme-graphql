import { describe, expect, it } from "bun:test";
import {
	applyLiveFixtureScores,
	resolveLiveMatchStatus,
} from "../../../src/domains/live-matches/service";

describe("resolveLiveMatchStatus", () => {
	it("prefers the authoritative fixture ID over a stale pair status", () => {
		const fixture = { id: 701, teamHId: 1, teamAId: 2, finished: false, started: true };
		const byFixtureId = new Map([[701, "FINISHED" as const]]);
		const byPair = new Map([["1:2", "PLAYING" as const]]);

		expect(resolveLiveMatchStatus(fixture, byFixtureId, byPair)).toBe("FINISHED");
	});

	it("falls back to the home-away pair and then database fixture flags", () => {
		const fixture = { id: 702, teamHId: 3, teamAId: 4, finished: false, started: false };
		expect(resolveLiveMatchStatus(fixture, new Map(), new Map([["3:4", "PLAYING" as const]]))).toBe(
			"PLAYING"
		);
		expect(resolveLiveMatchStatus(fixture, new Map(), new Map())).toBe("NOT_STARTED");
	});
});

describe("applyLiveFixtureScores", () => {
	it("prefers Redis live scores when the database fixture is lagging", () => {
		const fixture = {
			id: 701,
			code: 701,
			eventId: 12,
			finished: false,
			finishedProvisional: false,
			kickoffTime: null,
			minutes: 0,
			provisionalStartTime: false,
			started: true,
			teamAId: 2,
			teamAScore: 0,
			teamHId: 1,
			teamHScore: 0,
			stats: [],
			teamHDifficulty: 3,
			teamADifficulty: 3,
			pulseId: null,
		};

		expect(applyLiveFixtureScores(fixture, { teamScore: 3, againstTeamScore: 2 })).toMatchObject({
			teamHScore: 3,
			teamAScore: 2,
		});
	});
});
