import { describe, expect, it } from "bun:test";
import { fixturesRepository } from "../../../src/domains/fixtures/repository";
import {
	buildCorePublication,
	buildLivePublication,
	buildSnapshotContext,
	buildTestCoreData,
	TestRedis,
} from "../../helpers/data-publication";

describe("fixturesRepository over v3 snapshots", () => {
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

	it("reads current-event fixture state from the one pinned live revision", async () => {
		const core = buildTestCoreData(1);
		const liveFixtures = core.fixtures
			.filter((fixture) => fixture.eventId === 1)
			.map((fixture, index) =>
				index === 0
					? {
							...fixture,
							started: true,
							minutes: 34,
							teamHScore: 2,
							teamAScore: 1,
						}
					: fixture
			);
		const redis = new TestRedis(
			buildCorePublication("2627", 7, core),
			buildLivePublication(core, 1, "2627", 8, {
				fixtures: liveFixtures,
				state: "live",
			})
		);
		const context = buildSnapshotContext(redis);

		const explicit = await fixturesRepository.getEventFixtures(context, 1);
		const current = await fixturesRepository.getCurrentFixtures(context);

		expect(explicit).toEqual(current);
		expect(explicit).toHaveLength(10);
		expect(explicit[0]).toMatchObject({
			started: true,
			minutes: 34,
			teamHScore: 2,
			teamAScore: 1,
		});
	});

	it("returns an empty list for invalid event IDs without reading Redis", async () => {
		const context = buildSnapshotContext(new TestRedis());
		await expect(fixturesRepository.getEventFixtures(context, 0)).resolves.toEqual([]);
	});
});
