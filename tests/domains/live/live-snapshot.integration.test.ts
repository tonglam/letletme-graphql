import { describe, expect, it } from "bun:test";
import { graphql } from "graphql";
import { schema } from "../../../src/graphql/schema";
import {
	buildCorePublication,
	buildLivePublication,
	buildSnapshotContext,
	buildTestCoreData,
	buildTestEventLives,
	TestRedis,
} from "../../helpers/data-publication";

const buildLiveCore = () => {
	const base = buildTestCoreData(1);
	const fixtures = base.fixtures.map((fixture, index) =>
		fixture.eventId === 1 && index === 0
			? {
					...fixture,
					started: true,
					minutes: 45,
					teamHScore: 1,
					teamAScore: 0,
				}
			: fixture
	);
	return { ...base, fixtures };
};

const buildLiveEventRows = (core: ReturnType<typeof buildLiveCore>) =>
	buildTestEventLives(core, 1).map((row) =>
		row.elementId === 1
			? { ...row, minutes: 45, goalsScored: 1, starts: true, totalPoints: 8 }
			: row
	);

const buildPartiallySettledLiveCore = () => {
	const core = buildLiveCore();
	const firstFixture = core.fixtures.find((fixture) => fixture.eventId === 1);
	return {
		...core,
		fixtures: core.fixtures.map((fixture) =>
			fixture.id === firstFixture?.id
				? { ...fixture, started: true, finished: true, finishedProvisional: false }
				: fixture
		),
	};
};

describe("liveSnapshot GraphQL contract", () => {
	it("exposes the validated publication metadata and event-live data", async () => {
		const core = buildLiveCore();
		const live = buildLivePublication(core, 1, "2627", 8, {
			eventLives: buildLiveEventRows(core),
			state: "live",
		});
		const context = buildSnapshotContext(
			new TestRedis(buildCorePublication("2627", 7, core), live)
		);

		const result = await graphql({
			schema,
			source: `
				query Snapshot($eventId: Int!) {
					liveSnapshot(eventId: $eventId) {
						season eventId revision state
						publishedAt checkedAt eventLiveCount fixtureCount
						fixtureTeamCount bonusTeamCount
					}
					eventLive(eventId: $eventId) {
						performances { totalPoints }
						topPerformers(limit: 1) { totalPoints }
					}
				}
			`,
			variableValues: { eventId: 1 },
			contextValue: context,
		});

		expect(result.errors).toBeUndefined();
		expect(result.data?.liveSnapshot).toEqual({
			season: "2627",
			eventId: 1,
			revision: "8",
			state: "LIVE",
			publishedAt: "2026-08-09T01:00:00.000Z",
			checkedAt: "2026-08-09T01:00:00.000Z",
			eventLiveCount: 220,
			fixtureCount: 10,
			fixtureTeamCount: 20,
			bonusTeamCount: 0,
		});
		const eventLive = result.data?.eventLive as {
			performances: Array<{ totalPoints: number }>;
			topPerformers: Array<{ totalPoints: number }>;
		};
		expect(eventLive.performances).toHaveLength(220);
		expect(eventLive.topPerformers[0]?.totalPoints).toBeGreaterThan(0);
	});

	it("pins one current event and one live publication across sibling roots", async () => {
		const core = buildLiveCore();
		const live = buildLivePublication(core, 1, "2627", 8, {
			eventLives: buildLiveEventRows(core),
			state: "live",
			sourceCheckedAt: new Date().toISOString(),
		});
		const redis = new TestRedis(buildCorePublication("2627", 7, core), live);
		const originalGet = redis.get;
		let liveManifestReads = 0;
		redis.get = async (key: string) => {
			if (key === `llm:data:fpl:live:2627:1:active`) liveManifestReads += 1;
			return originalGet(key);
		};
		const context = buildSnapshotContext(redis);

		const result = await graphql({
			schema,
			source: `query {
				first: liveSnapshot { eventId revision }
				second: liveSnapshot { eventId revision }
				eventLive(eventId: 1) { topPerformers(limit: 1) { totalPoints } }
			}`,
			contextValue: context,
		});

		expect(result.errors).toBeUndefined();
		expect(result.data?.first).toEqual({ eventId: 1, revision: "8" });
		expect(result.data?.second).toEqual({ eventId: 1, revision: "8" });
		expect(liveManifestReads).toBe(1);
	});

	it("keeps a gameweek live after one fixture settles while another is pending", async () => {
		const core = buildPartiallySettledLiveCore();
		const live = buildLivePublication(core, 1, "2627", 8, {
			eventLives: buildLiveEventRows(core),
			state: "live",
		});
		const context = buildSnapshotContext(
			new TestRedis(buildCorePublication("2627", 7, core), live)
		);

		const result = await graphql({
			schema,
			source: `query { liveSnapshot(eventId: 1) { state } }`,
			contextValue: context,
		});

		expect(result.errors).toBeUndefined();
		expect(result.data?.liveSnapshot).toEqual({ state: "LIVE" });
	});

	it("publishes fixture minutes through the live matchday desk", async () => {
		const core = buildLiveCore();
		const live = buildLivePublication(core, 1, "2627", 8, {
			eventLives: buildLiveEventRows(core),
			state: "live",
			sourceCheckedAt: new Date().toISOString(),
		});
		const context = buildSnapshotContext(
			new TestRedis(buildCorePublication("2627", 7, core), live)
		);

		const result = await graphql({
			schema,
			source: `query {
				liveMatchdayDesk(ref: { season: "2627", eventId: 1, revision: "8" }) {
					sourceCheckedAt stale
					matches { fixtureId minutes started homeTeamName awayTeamName }
					nextFixtures { fixtureId minutes started }
				}
			}`,
			contextValue: context,
		});

		expect(result.errors).toBeUndefined();
		const desk = result.data?.liveMatchdayDesk as {
			sourceCheckedAt: unknown;
			stale: boolean;
			matches: Array<{
				fixtureId: number;
				minutes: number;
				started: boolean;
				homeTeamName: string;
				awayTeamName: string;
			}>;
			nextFixtures: Array<{ fixtureId: number; minutes: number; started: boolean }>;
		};
		expect(desk.sourceCheckedAt).toBeTruthy();
		expect(desk.stale).toBe(false);
		expect(desk.matches[0]).toMatchObject({
			homeTeamName: "Team 1",
			awayTeamName: "Team 20",
		});
		expect(desk.matches.find((match) => match.fixtureId === 1)).toMatchObject({
			minutes: 45,
			started: true,
		});
		expect(desk.nextFixtures[0]).toMatchObject({ minutes: 0, started: false });
	});

	it("uses core fixtures when scheduled live payload is unavailable without a live ref", async () => {
		const core = buildTestCoreData(1);
		const live = buildLivePublication(core, 1, "2627", 8, { state: "scheduled" });
		const redis = new TestRedis(buildCorePublication("2627", 7, core), live);
		const eventLiveItem = live.manifest.items.find((item) => item.name === "eventLive");
		if (!eventLiveItem) throw new Error("test live publication is missing eventLive");
		redis.values.delete(eventLiveItem.key);

		const result = await graphql({
			schema,
			source: `query {
				liveMatchdayDesk {
					season eventId revision state sourceCheckedAt publishedAt stale
					matches { fixtureId eventId minutes started finished }
					nextFixtures { fixtureId eventId minutes started finished }
					highlights { totalPoints }
				}
			}`,
			contextValue: buildSnapshotContext(redis),
		});

		expect(result.errors).toBeUndefined();
		const desk = result.data?.liveMatchdayDesk as {
			season: string;
			eventId: number;
			revision: string;
			state: string;
			sourceCheckedAt: string;
			stale: boolean;
			matches: Array<{ fixtureId: number; eventId: number }>;
			nextFixtures: Array<{ fixtureId: number; eventId: number }>;
			highlights: Array<{ totalPoints: number }>;
		};
		expect(desk).toMatchObject({
			season: "2627",
			eventId: 1,
			revision: "scheduled-core-7",
			state: "SCHEDULED",
		});
		expect(desk.sourceCheckedAt).toBeTruthy();
		expect(desk.stale).toBe(true);
		expect(desk.matches.length).toBeGreaterThan(0);
		expect(desk.matches.every((match) => match.eventId === 1)).toBe(true);
		expect(desk.nextFixtures.length).toBeGreaterThan(0);
		expect(desk.highlights).toEqual([]);
	});

	it("maps the manifest live state to LIVE_ACTIVE and tracks source age", async () => {
		const core = buildLiveCore();
		const live = buildLivePublication(core, 1, "2627", 8, {
			eventLives: buildLiveEventRows(core),
			state: "live",
			sourceCheckedAt: new Date().toISOString(),
		});
		const context = buildSnapshotContext(
			new TestRedis(buildCorePublication("2627", 7, core), live)
		);

		const result = await graphql({
			schema,
			source: `query { liveContext { state source stale liveRevision } }`,
			contextValue: context,
		});

		expect(result.errors).toBeUndefined();
		expect(result.data?.liveContext).toMatchObject({
			state: "LIVE_ACTIVE",
			source: "REDIS",
			stale: false,
			liveRevision: "8",
		});
	});

	it("fails closed when an immutable live item is missing", async () => {
		const core = buildLiveCore();
		const eventLives = buildLiveEventRows(core);
		const live = buildLivePublication(core, 1, "2627", 8, {
			eventLives,
			state: "live",
		});
		const redis = new TestRedis(buildCorePublication("2627", 7, core), live);
		const brokenSibling = live.manifest.items.find((item) => item.name === "fixtures")!;
		redis.values.delete(brokenSibling.key);
		let databaseReads = 0;
		const context = buildSnapshotContext(redis, {
			databaseQuery: async () => {
				databaseReads += 1;
				throw new Error("mutable live fallback must not run");
			},
		});

		const result = await graphql({
			schema,
			source: `query {
			liveSnapshot(eventId: 1) { revision state publishedAt eventLiveCount fixtureCount }
				eventLive(eventId: 1) { performances { totalPoints } }
			}`,
			contextValue: context,
		});

		expect(result.errors).toBeDefined();
		expect(result.data?.liveSnapshot).toBeNull();
		expect(result.data?.eventLive).toBeNull();
		expect(databaseReads).toBe(1);
	});
});
