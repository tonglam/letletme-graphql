import { describe, expect, it } from "bun:test";
import {
	hasLiveMatchesV2Contract,
	LIVE_MATCHES_CONTRACT_HEADER,
	LIVE_MATCHES_CONTRACT_VALUE,
	requiresLiveMatchesV2Contract,
} from "../../src/http/live-matches-contract";

describe("Live Matches V2 contract gate", () => {
	it("requires the exact V2 header for the liveMatchday root", () => {
		expect(requiresLiveMatchesV2Contract(["liveMatchday"])).toBe(true);
		expect(requiresLiveMatchesV2Contract(["events"])).toBe(false);
	});

	it("rejects missing and semantic header variants", () => {
		expect(hasLiveMatchesV2Contract(new Headers())).toBe(false);
		expect(
			hasLiveMatchesV2Contract(
				new Headers({ [LIVE_MATCHES_CONTRACT_HEADER]: LIVE_MATCHES_CONTRACT_VALUE })
			)
		).toBe(true);
		for (const value of ["live-matches-v1", "LIVE-MATCHES-V2", "live-matches-v2/"]) {
			expect(hasLiveMatchesV2Contract(new Headers({ [LIVE_MATCHES_CONTRACT_HEADER]: value }))).toBe(
				false
			);
		}
	});
});
