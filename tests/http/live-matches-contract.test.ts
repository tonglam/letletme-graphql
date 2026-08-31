import { describe, expect, it } from "bun:test";
import {
	hasLiveMatchesV2Contract,
	LIVE_MATCHES_CONTRACT_HEADER,
	LIVE_MATCHES_CONTRACT_VALUE,
	isLiveMatchesHotPathOperation,
	requiresLiveMatchesV2Contract,
} from "../../src/http/live-matches-contract";

describe("Live Matches V2 contract gate", () => {
	it("requires the exact V2 header for the liveMatchday root", () => {
		expect(requiresLiveMatchesV2Contract(["liveMatchday"])).toBe(true);
		expect(requiresLiveMatchesV2Contract(["events"])).toBe(false);
	});

	it("does not classify a mixed full-core operation as the match hot path", () => {
		expect(isLiveMatchesHotPathOperation(["liveMatchday"])).toBe(true);
		expect(isLiveMatchesHotPathOperation(["liveMatchday", "__typename"])).toBe(true);
		expect(isLiveMatchesHotPathOperation(["liveMatchday", "players"])).toBe(false);
		expect(isLiveMatchesHotPathOperation(["players"])).toBe(false);
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

	it("accepts the live-matches token when a review contract shares the header", () => {
		expect(
			hasLiveMatchesV2Contract(
				new Headers({
					[LIVE_MATCHES_CONTRACT_HEADER]: "live-matches-v2, my-tournament-review-v2",
				})
			)
		).toBe(true);
	});
});
