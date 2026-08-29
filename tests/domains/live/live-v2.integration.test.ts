import { describe, expect, it } from "bun:test";
import { graphql, getIntrospectionQuery } from "graphql";

import { schema } from "../../../src/graphql/schema";
import {
	buildCorePublication,
	buildLivePublication,
	buildSnapshotContext,
	buildTestCoreData,
	buildTestEventLives,
	TestRedis,
} from "../../helpers/data-publication";

describe("Live Points V2 GraphQL contract", () => {
	it("publishes one coherent V2 event snapshot across live roots", async () => {
		const core = buildTestCoreData(1, {
			fixtures: buildTestCoreData(1).fixtures.map((fixture, index) =>
				fixture.eventId === 1 && index === 0
					? { ...fixture, started: true, minutes: 45, teamHScore: 1, teamAScore: 0 }
					: fixture
			),
		});
		const live = buildLivePublication(core, 1, "2627", 8, {
			state: "live",
			sourceCheckedAt: new Date().toISOString(),
			eventLives: buildTestEventLives(core, 1).map((row, index) =>
				index === 0 ? { ...row, starts: true, minutes: 45, totalPoints: 8 } : row
			),
		});
		const result = await graphql({
			schema,
			source: `query {
				liveSnapshot(eventId: 1) {
					season eventId state
					revisions { publicationId generation scoreCore displayStats explain }
					times { sourceCheckedAt contentUpdatedAt publishedAt checkpointedAt servedAt staleAt nextRefreshAt }
					delivery { state servedFrom reasonCodes }
				}
				eventLive(eventId: 1) { performances { totalPoints } }
				liveMatchdayDesk { eventId state windowState dataAvailability source stale matches { fixtureId minutes started } }
			}`,
			contextValue: buildSnapshotContext(
				new TestRedis(buildCorePublication("2627", 7, core), live)
			),
		});

		expect(result.errors).toBeUndefined();
		const data = result.data as
			| { liveSnapshot: unknown; eventLive: { performances: unknown[] }; liveMatchdayDesk: unknown }
			| undefined;
		expect(data?.liveSnapshot).toMatchObject({
			season: "2627",
			eventId: 1,
			state: "LIVE_ACTIVE",
			revisions: { generation: 8 },
			delivery: { state: "FRESH", servedFrom: "REDIS_CURRENT" },
		});
		expect(data?.eventLive.performances).toHaveLength(core.players.length);
		expect(data?.liveMatchdayDesk).toMatchObject({
			eventId: 1,
			state: "LIVE_ACTIVE",
			windowState: "LIVE_ACTIVE",
			dataAvailability: "FRESH",
			source: "REDIS_CURRENT",
			stale: false,
		});
	});

	it("exposes stale delivery without removing the last complete event data", async () => {
		const core = buildTestCoreData(1);
		const live = buildLivePublication(core, 1, "2627", 8, {
			state: "live",
			sourceCheckedAt: "2026-08-09T01:00:00.000Z",
		});
		const result = await graphql({
			schema,
			source: `query { liveSnapshot(eventId: 1) { state delivery { state servedFrom } } eventLive(eventId: 1) { performances { totalPoints } } }`,
			contextValue: buildSnapshotContext(
				new TestRedis(buildCorePublication("2627", 7, core), live)
			),
		});

		expect(result.errors).toBeUndefined();
		const data = result.data as
			{ liveSnapshot: unknown; eventLive: { performances: unknown[] } } | undefined;
		expect(data?.liveSnapshot).toEqual({
			state: "LIVE_ACTIVE",
			delivery: { state: "STALE", servedFrom: "REDIS_CURRENT" },
		});
		expect(data?.eventLive.performances).toHaveLength(core.players.length);
	});

	it("fails closed when one immutable sibling is missing", async () => {
		const core = buildTestCoreData(1);
		const live = buildLivePublication(core, 1, "2627", 8, { state: "live" });
		const redis = new TestRedis(buildCorePublication("2627", 7, core), live);
		redis.values.delete(live.manifest.items.fixtures.key);
		const result = await graphql({
			schema,
			source: `query { liveSnapshot(eventId: 1) { eventId } eventLive(eventId: 1) { performances { totalPoints } } }`,
			contextValue: buildSnapshotContext(redis),
		});

		expect(result.errors).toBeUndefined();
		const data = result.data as
			{ liveSnapshot: unknown; eventLive: { performances: unknown[] } } | undefined;
		expect(data?.liveSnapshot).toBeNull();
		expect(data?.eventLive.performances).toEqual([]);
	});

	it("does not expose retired V1 live fields or the retired revision input", async () => {
		const result = await graphql({
			schema,
			source: `query { liveSnapshot { revision checkedAt } liveMatchdayDesk(ref: { season: "2627", eventId: 1, revision: "8" }) { state } }`,
		});
		expect(result.errors?.length).toBeGreaterThan(0);
		expect(result.errors?.map((error) => error.message).join(" ")).toMatch(
			/Cannot query field|Unknown argument|Field .* is not defined/
		);
	});

	it("keeps the V2 contract types explicit in the schema", async () => {
		const result = await graphql({ schema, source: getIntrospectionQuery() });
		expect(result.errors).toBeUndefined();
		const data = result.data as {
			__schema: { types: Array<{ name: string; enumValues?: Array<{ name: string }> }> };
		};
		const types = data.__schema.types;
		const snapshotState = types.find((type) => type.name === "LiveSnapshotState");
		const availability = types.find((type) => type.name === "LiveDataAvailability");
		expect(snapshotState?.enumValues?.map((value) => value.name)).toEqual([
			"PRE_DEADLINE",
			"PICKS_WAIT",
			"PICKS_PROBE",
			"PICKS_SYNC",
			"LIVE_ACTIVE",
			"BETWEEN_FIXTURES",
			"DAY_SETTLING",
			"GW_REVIEW",
			"FINALIZED",
			"UNAVAILABLE",
		]);
		expect(availability?.enumValues?.map((value) => value.name)).toEqual([
			"FRESH",
			"STALE",
			"DEGRADED",
			"FINAL",
			"UNAVAILABLE",
		]);
	});
});
