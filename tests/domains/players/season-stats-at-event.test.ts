import { describe, expect, it } from "bun:test";
import { resolvePlayerStatsContext } from "../../../src/domains/players/season-stats-at-event";
import {
	buildCorePublication,
	buildSnapshotContext,
	buildTestCoreData,
	TestRedis,
} from "../../helpers/data-publication";

describe("resolvePlayerStatsContext", () => {
	it("uses the request-pinned current event without querying a second authority", async () => {
		const publication = buildCorePublication("2627", 7, buildTestCoreData(3));
		const context = buildSnapshotContext(new TestRedis(publication));
		context.data = {
			read: () => {
				throw new Error("event state must not be re-read from PostgreSQL");
			},
		} as never;

		await expect(resolvePlayerStatsContext(context)).resolves.toEqual({
			scope: "CURRENT_SEASON",
			season: "2627",
			asOfEventId: 3,
		});
		await expect(resolvePlayerStatsContext(context, 1)).resolves.toEqual({
			scope: "CURRENT_SEASON",
			season: "2627",
			asOfEventId: 1,
		});
	});

	it("keeps pre-season stats unavailable when the publication has no started event", async () => {
		const publication = buildCorePublication("2627", 7, buildTestCoreData(null));
		const context = buildSnapshotContext(new TestRedis(publication));

		await expect(resolvePlayerStatsContext(context)).resolves.toEqual({
			scope: "UNAVAILABLE",
			season: "2627",
			asOfEventId: null,
		});
	});
});
