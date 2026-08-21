import { describe, expect, it } from "bun:test";
import { fixturesResolvers } from "../../../src/domains/fixtures/resolvers";
import { fixturesRepository } from "../../../src/domains/fixtures/repository";
import {
	buildCorePublication,
	buildSnapshotContext,
	buildTestCoreData,
	TestRedis,
} from "../../helpers/data-publication";

describe("fixturesRepository over canonical snapshots", () => {
	it("filters and paginates the full 380-fixture core dataset", async () => {
		const core = buildTestCoreData(1);
		const context = buildSnapshotContext(new TestRedis(buildCorePublication("2627", 7, core)));

		const eventFixtures = await fixturesRepository.listFixtures(context, { eventId: 1 }, 200, 0);
		const teamFixtures = await fixturesRepository.listFixtures(context, { teamId: 1 }, 200, 0);

		expect(eventFixtures).toHaveLength(10);
		expect(eventFixtures.every((fixture) => fixture.eventId === 1)).toBe(true);
		expect(teamFixtures).toHaveLength(38);
		expect(teamFixtures.every((fixture) => fixture.teamHId === 1 || fixture.teamAId === 1)).toBe(
			true
		);
	});

	it("reads the event schedule from the pinned core revision without a live publication", async () => {
		const core = buildTestCoreData(1);
		const redis = new TestRedis(buildCorePublication("2627", 7, core));
		const context = buildSnapshotContext(redis);
		const stages: string[] = [];
		Object.assign(context, {
			requestTiming: {
				start: (stage: string) => {
					stages.push(stage);
					return () => undefined;
				},
			},
		});

		const explicit = await fixturesRepository.getEventFixtures(context, 1);
		const current = await fixturesRepository.getCurrentFixtures(context);
		const resolved = await fixturesResolvers.Query.eventFixtures(
			undefined,
			{ eventId: 1 },
			context
		);

		expect(explicit).toEqual(current);
		expect(resolved).toEqual(explicit);
		expect(explicit).toHaveLength(10);
		expect(explicit.every((fixture) => fixture.eventId === 1)).toBe(true);
		expect(stages).toEqual(["fixtures.coreAcquisition"]);
	});

	it("fails closed for an unfinished current-event core score", async () => {
		const base = buildTestCoreData(1);
		const firstFixture = base.fixtures.find((fixture) => fixture.eventId === 1)!;
		const core = {
			...base,
			fixtures: base.fixtures.map((fixture) =>
				fixture.id === firstFixture.id
					? { ...fixture, started: true, teamHScore: 2, teamAScore: 0 }
					: fixture
			),
		};
		const context = buildSnapshotContext(new TestRedis(buildCorePublication("2627", 7, core)));

		const fixtures = await fixturesRepository.getEventFixtures(context, 1);

		expect(fixtures.find((fixture) => fixture.id === firstFixture.id)).toMatchObject({
			started: true,
			teamHScore: null,
			teamAScore: null,
		});
	});

	it("returns an empty list for invalid event IDs without reading Redis", async () => {
		const context = buildSnapshotContext(new TestRedis());
		await expect(fixturesRepository.getEventFixtures(context, 0)).resolves.toEqual([]);
	});
});
