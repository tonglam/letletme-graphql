import { describe, expect, it } from "bun:test";
import type { DataPublicationManifest } from "../../src/infra/data-publication";
import {
	coreDatasetRevision,
	getCoreEventSnapshot,
	getCoreFixtureSnapshot,
	getCoreDataSnapshot,
} from "../../src/infra/data-snapshot";
import {
	buildCorePublication,
	buildSnapshotContext,
	buildTestCoreData,
	TestRedis,
	toPublicationFixture,
} from "../helpers/data-publication";

const uuid = "10000000-0000-4000-8000-000000000009";

describe("typed Data snapshots", () => {
	it("loads the fixture schedule from only the Core teams and fixtures items", async () => {
		const core = buildTestCoreData(1);
		const publication = buildCorePublication("2627", 7, core);
		const redis = new TestRedis(publication);
		let evalCalls = 0;
		let getCalls = 0;
		let mgetCalls = 0;
		const originalGet = redis.get;
		const originalMget = redis.mget;
		redis.get = async (key: string) => {
			getCalls += 1;
			return originalGet(key);
		};
		redis.mget = async (...keys: string[]) => {
			mgetCalls += 1;
			return originalMget(...keys);
		};
		Object.assign(redis, {
			eval: async (
				_script: string,
				numberOfKeys: number,
				activeKey: string,
				...names: string[]
			) => {
				evalCalls += 1;
				expect(numberOfKeys).toBe(1);
				const rawManifest = await originalGet(activeKey);
				if (!rawManifest) return [];
				const manifest = JSON.parse(rawManifest) as DataPublicationManifest;
				const payloads = names.map((name) => {
					const item = manifest.items.find((candidate) => candidate.name === name);
					return item ? (publication.store.get(item.key) ?? null) : null;
				});
				return [rawManifest, ...payloads];
			},
		});

		const snapshot = await getCoreFixtureSnapshot(buildSnapshotContext(redis));

		expect(snapshot.source).toBe("redis");
		expect(snapshot.teams).toHaveLength(20);
		expect(snapshot.fixtures).toHaveLength(380);
		expect(evalCalls).toBe(1);
		expect(getCalls).toBe(0);
		expect(mgetCalls).toBe(0);
	});

	it("loads current-event context from only Core events and currentEventId", async () => {
		const core = buildTestCoreData(1);
		const redis = new TestRedis(buildCorePublication("2627", 7, core));
		const requested: string[][] = [];
		const originalMget = redis.mget;
		redis.mget = async (...keys: string[]) => {
			requested.push(keys);
			return originalMget(...keys);
		};

		const snapshot = await getCoreEventSnapshot(buildSnapshotContext(redis));

		expect(snapshot.source).toBe("redis");
		expect(snapshot.events).toHaveLength(38);
		expect(snapshot.currentEventId).toBe(1);
		expect(requested).toHaveLength(1);
		expect(requested[0]?.map((key) => key.split(":").at(-1)).sort()).toEqual([
			"currentEventId",
			"events",
		]);
	});

	it("accepts and request-pins one complete core publication", async () => {
		const core = buildTestCoreData(1);
		const publication = buildCorePublication("2627", 7, core);
		const context = buildSnapshotContext(new TestRedis(publication));

		const first = await getCoreDataSnapshot(context);
		const second = await getCoreDataSnapshot(context);

		expect(first).toBe(second);
		expect(first.source).toBe("redis");
		expect(first.events).toHaveLength(38);
		expect(first.teams).toHaveLength(20);
		expect(first.players).toHaveLength(220);
		expect(first.fixtures).toHaveLength(380);
		expect(first.currentEventId).toBe(1);
		expect(first.teams[0]?.strength).toBeNull();
		expect(coreDatasetRevision(first)).toBe("core-7");
	});

	it("preserves the request pin across Apollo's shallow context clone", async () => {
		const core = buildTestCoreData(1);
		const publication = buildCorePublication("2627", 7, core);
		const context = buildSnapshotContext(new TestRedis(publication));
		context.requestScope = {};

		const first = await getCoreDataSnapshot(context);
		const clonedContext = { ...context };
		const second = await getCoreDataSnapshot(clonedContext);

		expect(second).toBe(first);
		expect(clonedContext.coreSnapshotMemoStatus).toBe("hit");
	});

	it("shares one core publication pin across full, fixture, and event reads", async () => {
		const revisionSevenData = buildTestCoreData(1);
		const revisionEightData = buildTestCoreData(2);
		const revisionSeven = buildCorePublication("2627", 7, revisionSevenData);
		const revisionEight = buildCorePublication("2627", 8, revisionEightData);

		const fullFirstRedis = new TestRedis(revisionSeven);
		const fullFirstContext = buildSnapshotContext(fullFirstRedis);
		const full = await getCoreDataSnapshot(fullFirstContext);
		for (const [key, value] of revisionEight.store) fullFirstRedis.values.set(key, value);
		const fixtureAfterFull = await getCoreFixtureSnapshot(fullFirstContext);
		const eventAfterFull = await getCoreEventSnapshot(fullFirstContext);
		expect([full.revision, fixtureAfterFull.revision, eventAfterFull.revision]).toEqual([
			"7",
			"7",
			"7",
		]);
		expect(eventAfterFull.currentEventId).toBe(1);

		const partialFirstRedis = new TestRedis(revisionSeven);
		const partialFirstContext = buildSnapshotContext(partialFirstRedis);
		const fixture = await getCoreFixtureSnapshot(partialFirstContext);
		for (const [key, value] of revisionEight.store) partialFirstRedis.values.set(key, value);
		const fullAfterPartial = await getCoreDataSnapshot(partialFirstContext);
		const eventAfterPartial = await getCoreEventSnapshot(partialFirstContext);
		expect([fixture.revision, fullAfterPartial.revision, eventAfterPartial.revision]).toEqual([
			"7",
			"7",
			"7",
		]);
		expect(fullAfterPartial.currentEventId).toBe(1);
		expect(eventAfterPartial.currentEventId).toBe(1);
	});

	it("rejects a truncated core revision and falls back through one PostgreSQL statement", async () => {
		const complete = buildTestCoreData(1);
		const truncated = buildTestCoreData(1, { fixtures: complete.fixtures.slice(0, 379) });
		const publication = buildCorePublication("2627", 7, truncated);
		let calls = 0;
		const context = buildSnapshotContext(new TestRedis(publication), {
			databaseQuery: async (sql: unknown, values: unknown) => {
				calls += 1;
				expect(String(sql)).toContain("ops.dataset_publications");
				expect(String(sql)).toContain("FROM fpl.events");
				expect(String(sql)).toContain("FROM fpl.fixtures");
				expect(values).toEqual([2026]);
				return {
					rows: [
						{
							authority_count: "1",
							publication_id: publication.manifest.publicationId,
							revision: "7",
							manifest: publication.manifest,
							source_checked_at: "2026-08-09T01:00:00.000Z",
							events: complete.events,
							teams: complete.teams,
							players: complete.players,
							phases: complete.phases,
							fixtures: complete.fixtures.map(toPublicationFixture),
						},
					],
				};
			},
		});

		const snapshot = await getCoreDataSnapshot(context);
		expect(snapshot.source).toBe("postgres");
		expect(snapshot.revision).toBe("7");
		expect(snapshot.fixtures).toHaveLength(380);
		expect(calls).toBe(1);
	});

	it("rejects a Core fallback that no longer matches a partial request pin", async () => {
		const complete = buildTestCoreData(1);
		const truncated = buildTestCoreData(1, { players: complete.players.slice(0, 219) });
		const pinnedPublication = buildCorePublication("2627", 7, truncated);
		const advancedPublication = buildCorePublication("2627", 9, complete);
		const context = buildSnapshotContext(new TestRedis(pinnedPublication), {
			databaseQuery: async () => ({
				rows: [
					{
						authority_count: "1",
						publication_id: advancedPublication.manifest.publicationId,
						revision: "9",
						manifest: advancedPublication.manifest,
						source_checked_at: "2026-08-09T01:00:00.000Z",
						events: complete.events,
						teams: complete.teams,
						players: complete.players,
						phases: complete.phases,
						fixtures: complete.fixtures.map(toPublicationFixture),
					},
				],
			}),
		});

		expect((await getCoreFixtureSnapshot(context)).revision).toBe("7");
		await expect(getCoreDataSnapshot(context)).rejects.toThrow(
			"Coherent PostgreSQL core publication is unavailable"
		);
	});

	it("retains the observed manifest when an atomic targeted payload read fails", async () => {
		const complete = buildTestCoreData(1);
		const pinnedPublication = buildCorePublication("2627", 7, complete);
		const advancedPublication = buildCorePublication("2627", 9, complete);
		const redis = new TestRedis(pinnedPublication);
		Object.assign(redis, {
			eval: async (_script: string, numberOfKeys: number, activeKey: string) => {
				expect(numberOfKeys).toBe(1);
				const rawManifest = redis.values.get(activeKey);
				const missingItem = pinnedPublication.manifest.items.find(
					(item) => item.name === "fixtures"
				);
				if (missingItem) redis.values.delete(missingItem.key);
				for (const [key, value] of advancedPublication.store) redis.values.set(key, value);
				return rawManifest ? [rawManifest, null, null] : [];
			},
		});
		const context = buildSnapshotContext(redis, {
			databaseQuery: async () => ({
				rows: [
					{
						authority_count: "1",
						publication_id: advancedPublication.manifest.publicationId,
						revision: "9",
						manifest: advancedPublication.manifest,
						source_checked_at: "2026-08-09T01:00:00.000Z",
						events: complete.events,
						teams: complete.teams,
						players: complete.players,
						phases: complete.phases,
						fixtures: complete.fixtures.map(toPublicationFixture),
					},
				],
			}),
		});

		await expect(getCoreFixtureSnapshot(context)).rejects.toThrow(
			"Coherent PostgreSQL core publication is unavailable"
		);
	});

	it("rejects a non-canonical active core publication during PostgreSQL fallback", async () => {
		const invalidManifest = {
			...buildCorePublication("2627", 9, buildTestCoreData(1)).manifest,
			publicationId: uuid,
			unexpectedField: true,
		};
		const context = buildSnapshotContext(new TestRedis(), {
			databaseQuery: async () => ({
				rows: [
					{
						authority_count: "1",
						publication_id: uuid,
						revision: "9",
						manifest: invalidManifest,
						source_checked_at: "2026-08-09T01:00:00.000Z",
						events: [],
						teams: [],
						players: [],
						phases: [],
						fixtures: [],
					},
				],
			}),
		});

		await expect(getCoreDataSnapshot(context)).rejects.toThrow(
			"Coherent PostgreSQL core publication is unavailable"
		);
	});

	it("fails closed when neither Redis nor PostgreSQL has one coherent core authority", async () => {
		const context = buildSnapshotContext(new TestRedis(), {
			databaseQuery: async () => ({ rows: [] }),
		});
		await expect(getCoreDataSnapshot(context)).rejects.toThrow(
			"Coherent PostgreSQL core publication is unavailable"
		);
	});
});
