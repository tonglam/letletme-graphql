import { describe, expect, it } from "bun:test";
import { loadLiveBonusByPlayerId } from "../../../src/domains/live/bonus-cache";
import {
	buildCorePublication,
	buildLivePublication,
	buildSnapshotContext,
	buildTestCoreData,
	buildTestEventLives,
	TestRedis,
	toPublicationFixture,
} from "../../helpers/data-publication";

describe("loadLiveBonusByPlayerId", () => {
	it("returns every player override from the validated live publication", async () => {
		const core = buildTestCoreData(1);
		const liveBonus = { "1": { "1": 5, "2": 0 }, "2": { "12": 3 } };
		const context = buildSnapshotContext(
			new TestRedis(
				buildCorePublication("2627", 7, core),
				buildLivePublication(core, 1, "2627", 8, {
					liveBonus,
				})
			)
		);

		const result = await loadLiveBonusByPlayerId(context, 1);
		expect(Object.fromEntries(result)).toEqual({ 1: 5, 2: 0, 12: 3 });
	});

	it("rejects a cross-team sibling and rebuilds bonus only from PostgreSQL fixture stats", async () => {
		const core = buildTestCoreData(1);
		const invalid = buildLivePublication(core, 1, "2627", 8, {
			liveBonus: { "1": { "12": 9 } },
		});
		const databaseLives = buildTestEventLives(core, 1);
		const eventFixtures = core.fixtures.filter((fixture) => fixture.eventId === 1);
		const targetFixture = eventFixtures[0]!;
		const homePlayers = core.players.filter((player) => player.teamId === targetFixture.teamHId);
		const awayPlayer = core.players.find((player) => player.teamId === targetFixture.teamAId)!;
		const databaseFixtures = eventFixtures.map((fixture) => ({
			...toPublicationFixture(fixture),
			started: fixture.id === targetFixture.id,
			stats:
				fixture.id === targetFixture.id
					? [
							{
								identifier: "bps",
								h: [
									{ element: homePlayers[0]!.id, value: 50 },
									{ element: homePlayers[1]!.id, value: 30 },
								],
								a: [{ element: awayPlayer.id, value: 40 }],
							},
						]
					: [],
		}));
		const context = buildSnapshotContext(
			new TestRedis(buildCorePublication("2627", 7, core), invalid),
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
							event_lives: databaseLives,
							fixtures: databaseFixtures,
						},
					],
				}),
			}
		);

		const result = await loadLiveBonusByPlayerId(context, 1);
		expect(result.get(homePlayers[0]!.id)).toBe(3);
		expect(result.get(awayPlayer.id)).toBe(2);
		expect(result.get(homePlayers[1]!.id)).toBe(1);
		expect(result.size).toBe(3);
	});
});
