import { describe, expect, it } from "bun:test";
import {
	isLiveSnapshotConsistencyActive,
	isLiveSnapshotDatabaseFallback,
	liveSnapshotMetaKey,
	loadLivePublicationMeta,
	loadLiveSnapshotMeta,
	parseLiveSnapshotMeta,
	withLiveSnapshotConsistency,
	withLiveSnapshotRoot,
} from "../../../src/domains/live/snapshot-meta";
import {
	buildCorePublication,
	buildLivePublication,
	buildSnapshotContext,
	buildTestCoreData,
	buildTestEventLives,
	TestRedis,
	toPublicationFixture,
} from "../../helpers/data-publication";

describe("live snapshot metadata", () => {
	it("parses the exact live manifest scope, state, revision, and item counts", () => {
		const core = buildTestCoreData(1);
		const publication = buildLivePublication(core, 1, "2627", 8);
		const parsed = parseLiveSnapshotMeta(JSON.stringify(publication.manifest), {
			season: "2627",
			eventId: 1,
		});

		expect(parsed).toEqual({
			season: "2627",
			eventId: 1,
			revision: "8",
			publicationId: publication.manifest.publicationId,
			state: "scheduled",
			publishedAt: "2026-08-09T01:00:00.000Z",
			checkedAt: "2026-08-09T01:00:00.000Z",
			eventLiveCount: 220,
			fixtureCount: 10,
			fixtureTeamCount: 20,
			bonusTeamCount: 0,
		});
		expect(
			parseLiveSnapshotMeta(JSON.stringify(publication.manifest), {
				season: "2526",
				eventId: 1,
			})
		).toBeNull();
	});

	it("rejects incomplete manifests and invalid live states", () => {
		const core = buildTestCoreData(1);
		const publication = buildLivePublication(core, 1, "2627", 8);
		const incomplete = {
			...publication.manifest,
			items: publication.manifest.items.slice(0, -1),
		};
		expect(parseLiveSnapshotMeta(JSON.stringify(incomplete))).toBeNull();

		const invalidState = { ...publication.manifest, state: "partial" };
		expect(parseLiveSnapshotMeta(JSON.stringify(invalidState))).toBeNull();
	});

	it("derives and memoizes metadata from the request-pinned live dataset", async () => {
		const core = buildTestCoreData(1);
		const context = buildSnapshotContext(
			new TestRedis(buildCorePublication("2627", 7, core), buildLivePublication(core, 1, "2627", 8))
		);

		const first = await loadLiveSnapshotMeta(context, 1);
		const second = await loadLiveSnapshotMeta(context, 1, { fresh: true });

		expect(second).toBe(first);
		expect(first).toMatchObject({ revision: "8", eventLiveCount: 220, fixtureCount: 10 });
		expect(isLiveSnapshotConsistencyActive(context, 1)).toBe(true);
		expect(isLiveSnapshotDatabaseFallback(context, 1)).toBe(false);
		expect(liveSnapshotMetaKey("2627", 1)).toBe("llm:data:fpl:live:2627:1:active");
	});

	it("reads bounded-path metadata without hydrating the eventLives payload", async () => {
		const core = buildTestCoreData(1);
		const live = buildLivePublication(core, 1, "2627", 8);
		const redis = new TestRedis(buildCorePublication("2627", 7, core), live);
		const eventLivesKey = live.manifest.items.find((item) => item.name === "eventLives")?.key;
		if (eventLivesKey) redis.values.delete(eventLivesKey);
		const context = buildSnapshotContext(redis);

		const meta = await loadLivePublicationMeta(context, 1);

		expect(meta).toMatchObject({ revision: "8", eventLiveCount: 220, fixtureCount: 10 });
	});

	it("shares one publication pin when bounded and full reads overlap", async () => {
		const core = buildTestCoreData(1);
		const revisionEight = buildLivePublication(core, 1, "2627", 8);
		const redis = new TestRedis(buildCorePublication("2627", 7, core), revisionEight);
		const originalGet = redis.get;
		let releaseActiveRead!: () => void;
		let markActiveReadStarted!: () => void;
		const activeReadStarted = new Promise<void>((resolve) => {
			markActiveReadStarted = resolve;
		});
		const activeReadGate = new Promise<void>((resolve) => {
			releaseActiveRead = resolve;
		});
		let delayFirstActiveRead = true;
		redis.get = async (key: string) => {
			const value = await originalGet(key);
			if (key === liveSnapshotMetaKey("2627", 1) && delayFirstActiveRead) {
				delayFirstActiveRead = false;
				markActiveReadStarted();
				await activeReadGate;
			}
			return value;
		};
		const context = buildSnapshotContext(redis);
		const bounded = loadLivePublicationMeta(context, 1);
		await activeReadStarted;

		const revisionNine = buildLivePublication(core, 1, "2627", 9);
		for (const [key, value] of revisionNine.store) redis.values.set(key, value);
		const full = loadLiveSnapshotMeta(context, 1);
		releaseActiveRead();

		const [boundedMeta, fullMeta] = await Promise.all([bounded, full]);
		expect(boundedMeta?.revision).toBe("8");
		expect(fullMeta?.revision).toBe("8");
	});

	it("runs each consistency/root operation once over the immutable request snapshot", async () => {
		const core = buildTestCoreData(1);
		const context = buildSnapshotContext(
			new TestRedis(buildCorePublication("2627", 7, core), buildLivePublication(core, 1, "2627", 8))
		);
		let calls = 0;
		const value = await withLiveSnapshotRoot(context, () =>
			withLiveSnapshotConsistency(context, 1, async () => {
				calls += 1;
				return "ok";
			})
		);
		expect(value).toBe("ok");
		expect(calls).toBe(1);
	});

	it("marks the whole operation as PostgreSQL fallback when live publication validation fails", async () => {
		const core = buildTestCoreData(1);
		const invalidLive = buildLivePublication(core, 1, "2627", 8, {
			eventLives: buildTestEventLives(core, 1).slice(1),
		});
		const context = buildSnapshotContext(
			new TestRedis(buildCorePublication("2627", 7, core), invalidLive),
			{
				databaseQuery: async () => ({
					rows: [
						{
							authority_count: "0",
							publication_id: null,
							revision: null,
							source_checked_at: null,
							published_at: null,
							event_checked_at: "2026-08-09T01:02:03.000Z",
							event_lives: buildTestEventLives(core, 1),
							fixtures: core.fixtures
								.filter((fixture) => fixture.eventId === 1)
								.map(toPublicationFixture),
						},
					],
				}),
			}
		);

		const meta = await loadLiveSnapshotMeta(context, 1);
		expect(meta?.revision).toBe(`db-${Date.parse("2026-08-09T01:02:03.000Z")}`);
		expect(isLiveSnapshotDatabaseFallback(context, 1)).toBe(true);
		expect(isLiveSnapshotConsistencyActive(context, 1)).toBe(false);
	});
});
