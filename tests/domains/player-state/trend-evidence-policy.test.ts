import { describe, expect, it } from "bun:test";
import {
	applyPlayerStateEvidencePolicy,
	PLAYER_STATE_TREND_EVIDENCE,
} from "../../../src/domains/player-state/trend-evidence-policy";

describe("Player State trend evidence policy", () => {
	it("withholds directional FPL-only trends after the completed-season walk-forward", () => {
		expect(PLAYER_STATE_TREND_EVIDENCE.observations).toBe(41_425);
		expect(PLAYER_STATE_TREND_EVIDENCE.reason).toBe("FPL_WALK_FORWARD_ORDERING_FAILED");
		expect(PLAYER_STATE_TREND_EVIDENCE.directionalTrendAccepted).toBe(false);
		expect(applyPlayerStateEvidencePolicy("RISING", false)).toEqual({
			trend: "UNKNOWN",
			withheld: true,
			reasonCode: "TREND_WITHHELD_BACKTEST",
		});
	});

	it("keeps deterministic Mixed and Unavailable conclusions", () => {
		expect(applyPlayerStateEvidencePolicy("MIXED", true).trend).toBe("MIXED");
		expect(applyPlayerStateEvidencePolicy("UNAVAILABLE", false).trend).toBe("UNAVAILABLE");
	});

	it("requires a separate cross-provider walk-forward before release", () => {
		expect(applyPlayerStateEvidencePolicy("FALLING", true).reasonCode).toBe(
			"TREND_WITHHELD_CROSS_PROVIDER_BACKTEST"
		);
	});
});
