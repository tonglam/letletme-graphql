import { describe, expect, it } from "bun:test";
import type { DataPublicationManifest } from "../../src/infra/data-publication";
import {
	coreDatasetRevision,
	getCoreEventSnapshot,
	getCoreFixtureSnapshot,
	getCoreDataSnapshot,
	getLiveDataSnapshot,
	liveDatasetRevision,
} from "../../src/infra/data-snapshot";
import {
	buildCorePublication,
	buildLivePublication,
	buildSnapshotContext,
	buildTestCoreData,
	buildTestEventLives,
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

	it("accepts one complete live revision and validates every identity against core", async () => {
		const core = buildTestCoreData(1);
		const lives = buildTestEventLives(core, 1);
		lives[0] = { ...lives[0], bonus: 3, totalPoints: 6 };
		const corePublication = buildCorePublication("2627", 7, core);
		const livePublication = buildLivePublication(core, 1, "2627", 8, {
			eventLives: lives,
			liveBonus: { "1": { "1": 3 } },
		});
		const context = buildSnapshotContext(new TestRedis(corePublication, livePublication));

		const snapshot = await getLiveDataSnapshot(context, 1);
		expect(snapshot.source).toBe("redis");
		expect(snapshot.eventLives).toHaveLength(core.players.length);
		expect(snapshot.eventLives[0]).toMatchObject({ playerId: 1, bonus: 3, totalPoints: 6 });
		expect(snapshot.fixtures).toHaveLength(10);
		expect(Object.keys(snapshot.liveFixtures)).toHaveLength(20);
		expect(snapshot.liveBonus).toEqual({ "1": { "1": 3 } });
		expect(
			liveDatasetRevision(coreDatasetRevision(await getCoreDataSnapshot(context)), 1, "8")
		).toBe("core-7.live-1-8");
	});

	it("pins a live revision for one request and exposes a newer pointer only to a new request", async () => {
		const core = buildTestCoreData(1);
		const corePublication = buildCorePublication("2627", 7, core);
		const revisionEight = buildLivePublication(core, 1, "2627", 8);
		const redis = new TestRedis(corePublication, revisionEight);
		const firstContext = buildSnapshotContext(redis);

		await getLiveDataSnapshot(firstContext, 1);
		const nextLives = buildTestEventLives(core, 1);
		nextLives[0] = { ...nextLives[0], totalPoints: 12 };
		const revisionNine = buildLivePublication(core, 1, "2627", 9, {
			eventLives: nextLives,
		});
		for (const [key, value] of revisionNine.store) redis.values.set(key, value);

		expect((await getLiveDataSnapshot(firstContext, 1)).revision).toBe("8");
		expect((await getLiveDataSnapshot(firstContext, 1)).eventLives[0]?.totalPoints).toBe(0);

		const next = await getLiveDataSnapshot(buildSnapshotContext(redis), 1);
		expect(next.revision).toBe("9");
		expect(next.eventLives[0]?.totalPoints).toBe(12);
	});

	it("rejects an invalid live sibling and uses the PostgreSQL dataset as a whole", async () => {
		const core = buildTestCoreData(1);
		const corePublication = buildCorePublication("2627", 7, core);
		const incompleteLives = buildTestEventLives(core, 1).slice(1);
		const livePublication = buildLivePublication(core, 1, "2627", 8, {
			eventLives: incompleteLives,
		});
		const databaseLives = buildTestEventLives(core, 1).map((row, index) => ({
			...row,
			totalPoints: index === 0 ? 99 : 0,
		}));
		const eventFixtures = core.fixtures.filter((fixture) => fixture.eventId === 1);
		const databaseFixtures = eventFixtures.map((fixture, index) => ({
			...toPublicationFixture(fixture),
			...(index === 0 ? { started: true, teamHScore: 2, teamAScore: 1 } : {}),
			stats: [],
		}));
		let calls = 0;
		const context = buildSnapshotContext(new TestRedis(corePublication, livePublication), {
			databaseQuery: async (sql: unknown, values: unknown) => {
				calls += 1;
				expect(String(sql)).toContain("fpl.player_gameweek_stats");
				expect(values).toEqual([2026, 1]);
				return {
					rows: [
						{
							authority_count: "0",
							publication_id: null,
							revision: null,
							source_checked_at: null,
							published_at: null,
							event_checked_at: "2026-08-09T01:02:03.000Z",
							event_lives: databaseLives.map((row, index) =>
								index === 0
									? {
											...row,
											expected_goals: 0.75,
											expected_assists: 0.1,
											expected_goal_involvements: 0.85,
											expected_goals_conceded: 0.9,
										}
									: row
							),
							fixtures: databaseFixtures,
						},
					],
				};
			},
		});

		const first = await getLiveDataSnapshot(context, 1);
		const second = await getLiveDataSnapshot(context, 1);
		expect(first).toBe(second);
		expect(first.source).toBe("postgres");
		expect(first.revision).toBe("db-1786237323000");
		expect(first.eventLives[0]).toMatchObject({ playerId: 1, totalPoints: 99 });
		expect(first.eventLives).toHaveLength(core.players.length);
		expect(
			first.liveFixtures[String(eventFixtures[0]!.teamAId)].Playing.find(
				(fixture) => fixture.fixtureId === eventFixtures[0]!.id
			)?.score
		).toBe("1-2");
		expect(calls).toBe(1);
	});

	it("rejects an empty fallback live row once any fixture has started", async () => {
		const core = buildTestCoreData(1);
		const corePublication = buildCorePublication("2627", 7, core);
		const invalidLivePublication = buildLivePublication(core, 1, "2627", 8, {
			eventLives: [],
		});
		const databaseFixtures = core.fixtures
			.filter((fixture) => fixture.eventId === 1)
			.map((fixture, index) => ({
				...toPublicationFixture(fixture),
				...(index === 0 ? { started: true, teamHScore: 1, teamAScore: 0 } : {}),
			}));
		const context = buildSnapshotContext(new TestRedis(corePublication, invalidLivePublication), {
			databaseQuery: async () => ({
				rows: [
					{
						authority_count: "0",
						publication_id: null,
						revision: null,
						source_checked_at: null,
						published_at: null,
						event_checked_at: "2026-08-09T01:02:03.000Z",
						event_lives: [],
						fixtures: databaseFixtures,
					},
				],
			}),
		});

		await expect(getLiveDataSnapshot(context, 1)).rejects.toThrow(
			"Coherent PostgreSQL live publication is unavailable"
		);
	});

	it("rejects a non-canonical active live publication during PostgreSQL fallback", async () => {
		const core = buildTestCoreData(1);
		const live = buildLivePublication(core, 1, "2627", 8);
		const redis = new TestRedis(buildCorePublication("2627", 7, core), live);
		const brokenSibling = live.manifest.items.find((item) => item.name === "liveFixtures")!;
		redis.values.delete(brokenSibling.key);
		const invalidManifest = {
			...buildLivePublication(core, 1, "2627", 9).manifest,
			publicationId: uuid,
			unexpectedField: true,
		};
		const context = buildSnapshotContext(redis, {
			databaseQuery: async () => ({
				rows: [
					{
						authority_count: "1",
						publication_id: uuid,
						revision: "9",
						manifest: invalidManifest,
						source_checked_at: "2026-08-09T01:00:00.000Z",
						published_at: "2026-08-09T01:00:00.000Z",
						event_checked_at: "2026-08-09T01:00:00.000Z",
						event_lives: [],
						fixtures: [],
					},
				],
			}),
		});

		await expect(getLiveDataSnapshot(context, 1)).rejects.toThrow(
			"Coherent PostgreSQL live publication is unavailable"
		);
	});

	it("validates live bonus teams against the requested event, not current player teams", async () => {
		const core = buildTestCoreData(1);
		const firstPlayer = core.players[0]!;
		const secondTeamPlayer = core.players[11]!;
		core.players[0] = { ...firstPlayer, teamId: 2 };
		core.players[11] = { ...secondTeamPlayer, teamId: 1 };
		const corePublication = buildCorePublication("2627", 7, core);
		const livePublication = buildLivePublication(core, 1, "2627", 8, {
			liveBonus: { "1": { "1": 3 } },
		});
		const context = buildSnapshotContext(new TestRedis(corePublication, livePublication));

		await expect(getLiveDataSnapshot(context, 1)).resolves.toMatchObject({
			liveBonus: { "1": { "1": 3 } },
		});
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
