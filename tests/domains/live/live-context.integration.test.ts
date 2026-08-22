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
});
