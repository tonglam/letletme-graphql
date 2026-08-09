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

describe("liveSnapshot GraphQL v3 contract", () => {
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
						schemaVersion season eventId revision state
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
			schemaVersion: 3,
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
		});
		const redis = new TestRedis(buildCorePublication("2627", 7, core), live);
		const originalGet = redis.get;
		let liveManifestReads = 0;
		redis.get = async (key: string) => {
			if (key === `llm:v3:data:fpl:live:2627:1:active`) liveManifestReads += 1;
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

	it("falls the whole live dataset back to one coherent PostgreSQL snapshot", async () => {
		const core = buildLiveCore();
		const eventLives = buildLiveEventRows(core);
		const live = buildLivePublication(core, 1, "2627", 8, {
			eventLives,
			state: "live",
		});
		const redis = new TestRedis(buildCorePublication("2627", 7, core), live);
		const brokenSibling = live.manifest.items.find((item) => item.name === "liveFixtures")!;
		redis.values.delete(brokenSibling.key);
		let databaseReads = 0;
		const context = buildSnapshotContext(redis, {
			databaseQuery: async () => {
				databaseReads += 1;
				return {
					rows: [
						{
							authority_count: "1",
							publication_id: "00000000-0000-4000-8000-000000000044",
							revision: "44",
							schema_version: "v3",
							plan_version: "3.2.5",
							source_checked_at: "2026-08-09T01:02:00.000Z",
							published_at: "2026-08-09T01:03:00.000Z",
							event_checked_at: "2026-08-09T01:02:00.000Z",
							event_lives: eventLives,
							fixtures: live.values.fixtures,
						},
					],
				};
			},
		});

		const result = await graphql({
			schema,
			source: `query {
				liveSnapshot(eventId: 1) { revision state eventLiveCount fixtureCount }
				eventLive(eventId: 1) { performances { totalPoints } }
			}`,
			contextValue: context,
		});

		expect(result.errors).toBeUndefined();
		expect(result.data?.liveSnapshot).toEqual({
			revision: `db-${Date.parse("2026-08-09T01:02:00.000Z")}`,
			state: "LIVE",
			eventLiveCount: 220,
			fixtureCount: 10,
		});
		expect((result.data?.eventLive as { performances: unknown[] }).performances).toHaveLength(220);
		expect(databaseReads).toBe(1);
	});
});
