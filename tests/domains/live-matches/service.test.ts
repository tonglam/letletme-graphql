import { describe, expect, it } from "bun:test";
import {
	applyLiveFixtureScores,
	loadLiveFixtureBucketsFromRedis,
	loadUpcomingEventFixtures,
	resolveLiveMatchStatus,
} from "../../../src/domains/live-matches/service";
import {
	isLiveSnapshotConsistencyActive,
	LiveSnapshotCoherenceError,
	loadOperationLiveSnapshotMeta,
} from "../../../src/domains/live/snapshot-meta";
import {
	buildCorePublication,
	buildLivePublication,
	buildSnapshotContext,
	buildTestCoreData,
	TestRedis,
} from "../../helpers/data-publication";

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
	it("prefers publication live scores when the database fixture is lagging", () => {
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

describe("loadLiveFixtureBucketsFromRedis", () => {
	it("reads the complete v3 live publication and keeps one home row per fixture", async () => {
		const core = buildTestCoreData(1);
		const corePublication = buildCorePublication("2627", 7, core);
		const livePublication = buildLivePublication(core, 1, "2627", 8);
		const context = buildSnapshotContext(new TestRedis(corePublication, livePublication));
		const expectedFixtures = core.fixtures.filter((fixture) => fixture.eventId === 1);

		const buckets = await loadLiveFixtureBucketsFromRedis(context, 1, expectedFixtures);

		expect(buckets).not.toBeNull();
		expect(buckets?.notStarted).toHaveLength(10);
		expect(buckets?.playing).toEqual([]);
		expect(buckets?.finished).toEqual([]);
		expect(buckets?.notStarted.map((fixture) => fixture.fixtureId).sort((a, b) => a! - b!)).toEqual(
			expectedFixtures.map((fixture) => fixture.id).sort((a, b) => a - b)
		);
	});

	it("rejects a same-sized expected set with a different fixture identity", async () => {
		const core = buildTestCoreData(1);
		const context = buildSnapshotContext(
			new TestRedis(buildCorePublication("2627", 7, core), buildLivePublication(core, 1, "2627", 8))
		);
		const expectedFixtures = core.fixtures
			.filter((fixture) => fixture.eventId === 1)
			.map((fixture, index) => (index === 0 ? { ...fixture, id: 999_999 } : fixture));

		expect(loadLiveFixtureBucketsFromRedis(context, 1, expectedFixtures)).rejects.toBeInstanceOf(
			LiveSnapshotCoherenceError
		);
	});
});

describe("loadUpcomingEventFixtures", () => {
	it("pins the next event publication while reading fixtures from the same core revision", async () => {
		const core = buildTestCoreData(1);
		const context = buildSnapshotContext(
			new TestRedis(
				buildCorePublication("2627", 7, core),
				buildLivePublication(core, 1, "2627", 8),
				buildLivePublication(core, 2, "2627", 9)
			)
		);

		const fixtures = await loadUpcomingEventFixtures(context, 1);

		expect(fixtures).toHaveLength(10);
		expect(fixtures.every((fixture) => fixture.eventId === 2)).toBe(true);
		expect(await loadOperationLiveSnapshotMeta(context, 2)).toMatchObject({
			eventId: 2,
			revision: "9",
		});
		expect(isLiveSnapshotConsistencyActive(context, 2)).toBe(true);
	});
});
