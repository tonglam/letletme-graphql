import { describe, expect, it } from "bun:test";
import { graphql } from "graphql";
import { schema } from "../../../src/graphql/schema";
import {
	buildCorePublication,
	buildLivePublication,
	buildSnapshotContext,
	buildTestCoreData,
	TestRedis,
} from "../../helpers/data-publication";

const buildContext = (state: "scheduled" | "live" | "settled", finalized = false) => {
	const base = buildTestCoreData(1);
	const core = finalized
		? {
				...base,
				events: base.events.map((event) =>
					event.id === 1 ? { ...event, finished: true, dataChecked: true } : event
				),
			}
		: base;
	const live = buildLivePublication(core, 1, "2627", 8, {
		state,
		sourceCheckedAt: new Date().toISOString(),
	});
	return buildSnapshotContext(new TestRedis(buildCorePublication("2627", 7, core), live));
};

describe("liveContext lifecycle state", () => {
	const cases = [
		["scheduled publication", "scheduled", "SCHEDULED"],
		["live publication", "live", "LIVE_ACTIVE"],
		["settled publication awaiting review", "settled", "GW_REVIEW"],
		["settled publication finalized", "settled", "FINALIZED", true],
	] as const;

	for (const [name, publicationState, expectedState, finalized = false] of cases) {
		it(`maps ${name} correctly`, async () => {
			const result = await graphql({
				schema,
				source: `query { liveContext { currentEventId liveRevision state source } }`,
				contextValue: buildContext(publicationState, finalized),
			});

			expect(result.errors).toBeUndefined();
			expect(result.data?.liveContext).toMatchObject({
				currentEventId: 1,
				liveRevision: "8",
				state: expectedState,
				source: "REDIS",
			});
		});
	}

	it("lets a fresh active publication override a stale quiet-interval checkpoint", async () => {
		const base = buildTestCoreData(1);
		const core = {
			...base,
			fixtures: base.fixtures.map((fixture) =>
				fixture.eventId === 1
					? {
							...fixture,
							started: true,
							finished: false,
							kickoffTime: "2026-08-21T19:00:00.000Z",
						}
					: fixture
			),
		};
		const live = buildLivePublication(core, 1, "2627", 8, {
			state: "live",
			sourceCheckedAt: "2026-08-22T06:46:47.764Z",
			lastSuccessfulFetchAt: new Date().toISOString(),
		});
		const context = buildSnapshotContext(
			new TestRedis(buildCorePublication("2627", 7, core), live),
			{
				databaseQuery: async (query) => {
					if (String(query).includes("ops.live_lifecycle_status")) {
						return {
							rows: [
								{
									event_id: 1,
									state: "BETWEEN_FIXTURES",
									observed_at: "2026-08-22T09:32:58.000Z",
									last_changed_at: "2026-08-22T06:56:48.000Z",
									next_refresh_at: "2026-08-22T09:37:58.000Z",
									live_revision: "177",
									publication_id: live.manifest.publicationId,
									source_checked_at: "2026-08-22T06:46:47.764Z",
								},
							],
						};
					}
					throw new Error("Unexpected database query");
				},
			}
		);

		const result = await graphql({
			schema,
			source: `query { liveContext { state windowState producerState nextRefreshAt } }`,
			contextValue: context,
		});

		expect(result.errors).toBeUndefined();
		expect(result.data?.liveContext).toMatchObject({
			state: "LIVE_ACTIVE",
			windowState: "LIVE_ACTIVE",
			producerState: "LIVE_ACTIVE",
		});
	});
});
