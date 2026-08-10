import { describe, expect, it } from "bun:test";
import {
	applyPlayerStateReleaseGate,
	PLAYER_STATE_RELEASE_EVIDENCE,
} from "../../../src/domains/player-state/release-gate";

describe("Player State release gate", () => {
	it("withholds directional FPL-only trends after the completed-season walk-forward", () => {
		expect(PLAYER_STATE_RELEASE_EVIDENCE.observations).toBe(41_425);
		expect(PLAYER_STATE_RELEASE_EVIDENCE.reason).toBe("FPL_WALK_FORWARD_ORDERING_FAILED");
		expect(PLAYER_STATE_RELEASE_EVIDENCE.released).toBe(false);
		expect(applyPlayerStateReleaseGate("RISING", false)).toEqual({
			trend: "UNKNOWN",
			withheld: true,
			reasonCode: "TREND_WITHHELD_BACKTEST",
		});
	});

	it("keeps deterministic Mixed and Unavailable conclusions", () => {
		expect(applyPlayerStateReleaseGate("MIXED", true).trend).toBe("MIXED");
		expect(applyPlayerStateReleaseGate("UNAVAILABLE", false).trend).toBe("UNAVAILABLE");
	});

	it("requires a separate cross-provider walk-forward before release", () => {
		expect(applyPlayerStateReleaseGate("FALLING", true).reasonCode).toBe(
			"TREND_WITHHELD_CROSS_PROVIDER_BACKTEST"
		);
	});
});
