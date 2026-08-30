import { describe, expect, it } from "bun:test";
import {
	hasLivePointsV2Contract,
	LIVE_POINTS_CONTRACT_HEADER,
	LIVE_POINTS_CONTRACT_VALUE,
	requiresLivePointsV2Contract,
	isLivePointsHotPathOperation,
} from "../../src/http/live-points-contract";

describe("Live Points V2 contract gate", () => {
	it("requires the V2 header for every live read root, including no-argument roots", () => {
		expect(requiresLivePointsV2Contract(["calcLivePointsByEntry"])).toBe(true);
		expect(requiresLivePointsV2Contract(["liveContext"])).toBe(true);
		expect(requiresLivePointsV2Contract(["events"])).toBe(false);
	});

	it("accepts only the exact V2 header value", () => {
		const valid = new Headers({ [LIVE_POINTS_CONTRACT_HEADER]: LIVE_POINTS_CONTRACT_VALUE });
		expect(hasLivePointsV2Contract(valid)).toBe(true);
		// Headers normalizes optional surrounding HTTP whitespace before the
		// application sees it; reject semantic variants that survive parsing.
		for (const value of [
			"",
			"live-points-v1",
			"LIVE-POINTS-V2",
			"live-points-v2/",
			"live-points-v2;v=1",
		]) {
			expect(hasLivePointsV2Contract(new Headers({ [LIVE_POINTS_CONTRACT_HEADER]: value }))).toBe(
				false
			);
		}
		expect(hasLivePointsV2Contract(new Headers())).toBe(false);
	});

	it("keeps safe companion roots on the Redis-only hot path", () => {
		expect(isLivePointsHotPathOperation(["calcLivePointsByEntry", "events"])).toBe(true);
		expect(isLivePointsHotPathOperation(["calcLivePointsByEntry", "__typename"])).toBe(true);
		expect(isLivePointsHotPathOperation(["calcLivePointsByEntry", "homePersonalDesk"])).toBe(false);
	});
});
