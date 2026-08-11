import type { PlayerStateTrend } from "./types";

export const PLAYER_STATE_TREND_EVIDENCE = {
	evaluatedAt: "2026-08-09",
	mode: "fpl-only",
	seasons: ["1617", "1718", "1819", "1920", "2021", "2122", "2223", "2324", "2425", "2526"],
	observations: 41_425,
	futureFivePointMeans: {
		RISING: 12.71,
		STABLE: 13.87,
		FALLING: 11.92,
	},
	directionalTrendAccepted: false,
	reason: "FPL_WALK_FORWARD_ORDERING_FAILED",
} as const;

const directionalTrends = new Set<PlayerStateTrend>(["RISING", "STABLE", "FALLING"]);

export function applyPlayerStateEvidencePolicy(
	candidate: PlayerStateTrend,
	processAvailable: boolean
): { trend: PlayerStateTrend; withheld: boolean; reasonCode: string | null } {
	if (!directionalTrends.has(candidate)) {
		return { trend: candidate, withheld: false, reasonCode: null };
	}
	// Cross-provider publication needs its own sealed walk-forward evidence after
	// current Understat and season-specific verified links are available.
	if (processAvailable) {
		return {
			trend: "UNKNOWN",
			withheld: true,
			reasonCode: "TREND_WITHHELD_CROSS_PROVIDER_BACKTEST",
		};
	}
	if (!PLAYER_STATE_TREND_EVIDENCE.directionalTrendAccepted) {
		return {
			trend: "UNKNOWN",
			withheld: true,
			reasonCode: "TREND_WITHHELD_BACKTEST",
		};
	}
	return { trend: candidate, withheld: false, reasonCode: null };
}
