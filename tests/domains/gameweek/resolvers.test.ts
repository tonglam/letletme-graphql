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

const deskQuery = `
	query Desk($eventId: Int) {
		gameweekDesk(eventId: $eventId) {
			season coreRevision liveRevision anchorEventId eventId currentEventId nextEventId
			isPreseason lifecycle deadlineTime publishedAt overviewState boardsState
			overview { averagePoints highestPoints }
			dreamTeam { id position totalPoints }
			hauls { id position totalPoints }
		}
	}
`;

describe("gameweekDesk", () => {
	it("returns a scheduled preseason desk without live reads or false unavailable boards", async () => {
		const core = buildTestCoreData(null);
		const redis = new TestRedis(buildCorePublication("2627", 7, core));
		const context = buildSnapshotContext(redis);

		const result = await graphql({
			schema,
			source: deskQuery,
			variableValues: { eventId: null },
			contextValue: context,
		});

		expect(result.errors).toBeUndefined();
		expect(result.data?.gameweekDesk).toMatchObject({
			season: "2627",
			coreRevision: "7",
			anchorEventId: 1,
			eventId: 1,
			currentEventId: null,
			nextEventId: 1,
			isPreseason: true,
			lifecycle: "SCHEDULED",
			overviewState: "PENDING",
			boardsState: "PENDING",
			overview: null,
			dreamTeam: [],
			hauls: [],
		});
	});

	it("returns one provisional board projection from the live publication", async () => {
		const baseCore = buildTestCoreData(1);
		const core = buildTestCoreData(1, {
			fixtures: baseCore.fixtures.map((fixture, index) =>
				index === 0 ? { ...fixture, started: true } : fixture
			),
		});
		const eventLives = buildTestEventLives(core, 1).map((row, index) =>
			index === 0
				? {
						...row,
						inDreamTeam: true,
						goalsScored: 2,
					}
				: row
		);
		const redis = new TestRedis(
			buildCorePublication("2627", 7, core),
			buildLivePublication(core, 1, "2627", 8, { state: "live", eventLives })
		);
		const result = await graphql({
			schema,
			source: deskQuery,
			variableValues: { eventId: 1 },
			contextValue: buildSnapshotContext(redis),
		});

		expect(result.errors).toBeUndefined();
		expect(result.data?.gameweekDesk).toMatchObject({
			eventId: 1,
			lifecycle: "PROVISIONAL",
			overviewState: "PENDING",
			boardsState: "AVAILABLE",
			dreamTeam: [{ id: core.players[0]!.id, position: "GOALKEEPER" }],
		});
	});

	it("rejects event IDs outside the published season range", async () => {
		const core = buildTestCoreData(null);
		const result = await graphql({
			schema,
			source: deskQuery,
			variableValues: { eventId: 39 },
			contextValue: buildSnapshotContext(new TestRedis(buildCorePublication("2627", 7, core))),
		});

		expect(result.data).toBeNull();
		expect(result.errors?.[0]?.extensions?.code).toBe("BAD_USER_INPUT");
	});
});
