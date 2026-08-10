import { describe, expect, it } from "bun:test";
import { buildTeamMap } from "../../src/infra/team-map";
import {
	buildCorePublication,
	buildSnapshotContext,
	buildTestCoreData,
	TestRedis,
} from "../helpers/data-publication";

describe("team map core publication", () => {
	it("preserves nullable preseason strength and request-pins the map", async () => {
		const core = buildTestCoreData(1);
		const context = buildSnapshotContext(new TestRedis(buildCorePublication("2627", 7, core)));

		const first = await buildTeamMap(context);
		const second = await buildTeamMap(context);

		expect(first).toEqual(second);
		expect(first.size).toBe(20);
		expect(first.get(1)?.strength).toBeNull();
		expect(first.get(1)?.position).toBe(1);
	});
});
