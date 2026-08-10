import { describe, expect, it } from "bun:test";
import {
	applyLiveFixtureScores,
	loadLiveFixtureBucketsFromRedis,
	liveMatchesService,
	resolveLiveMatchStatus,
} from "../../../src/domains/live-matches/service";
import { LiveSnapshotCoherenceError } from "../../../src/domains/live/snapshot-meta";
import {
	buildCorePublication,
	buildLivePublication,
	buildSnapshotContext,
	buildTestCoreData,
	TestRedis,
} from "../../helpers/data-publication";

describe("resolveLiveMatchStatus", () => {
	it("uses the fixture ID status before database fixture flags", () => {
		const fixture = { id: 701, teamHId: 1, teamAId: 2, finished: false, started: true };
		const byFixtureId = new Map([[701, "FINISHED" as const]]);

		expect(resolveLiveMatchStatus(fixture, byFixtureId)).toBe("FINISHED");
		expect(resolveLiveMatchStatus(fixture, new Map())).toBe("PLAYING");
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
	it("binds every live row to its fixture ID", async () => {
		const core = buildTestCoreData(1);
		const context = buildSnapshotContext(
			new TestRedis(buildCorePublication("2627", 7, core), buildLivePublication(core, 1, "2627", 8))
		);
		const expectedFixtures = core.fixtures.filter((fixture) => fixture.eventId === 1);

		const buckets = await loadLiveFixtureBucketsFromRedis(context, 1, expectedFixtures);

		expect(buckets?.notStarted).toHaveLength(10);
		expect(buckets?.notStarted.map((fixture) => fixture.fixtureId).sort((a, b) => a - b)).toEqual(
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

describe("liveMatchesService.getAllLiveMatches", () => {
	it("returns only current-event buckets", async () => {
		const core = buildTestCoreData(1);
		const context = buildSnapshotContext(
			new TestRedis(buildCorePublication("2627", 7, core), buildLivePublication(core, 1, "2627", 8))
		);

		const result = await liveMatchesService.getAllLiveMatches(context);

		expect(result.notStarted).toHaveLength(10);
		expect(result.playing).toEqual([]);
		expect(result.finished).toEqual([]);
	});

	it("returns empty buckets during preseason", async () => {
		const core = buildTestCoreData(null);
		const context = buildSnapshotContext(new TestRedis(buildCorePublication("2627", 7, core)));

		await expect(liveMatchesService.getAllLiveMatches(context)).resolves.toEqual({
			notStarted: [],
			playing: [],
			finished: [],
		});
	});
});
