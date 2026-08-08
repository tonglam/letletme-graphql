import type { PlayerStateTrend } from "./types";

export const PLAYER_STATE_RELEASE_EVIDENCE = {
	engineVersion: "player-state-v1.1",
	evaluatedAt: "2026-08-08",
	mode: "fpl-only",
	seasons: ["1617", "1718", "1819", "1920", "2021", "2122", "2223", "2324", "2425", "2526"],
	observations: 226_700,
	futureFivePointMeans: {
		RISING: 11.41,
		STABLE: 13.53,
		FALLING: 4.8,
	},
	released: false,
} as const;

const directionalTrends = new Set<PlayerStateTrend>(["RISING", "STABLE", "FALLING"]);

export function applyPlayerStateReleaseGate(
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
	if (!PLAYER_STATE_RELEASE_EVIDENCE.released) {
		return {
			trend: "UNKNOWN",
			withheld: true,
			reasonCode: "TREND_WITHHELD_BACKTEST",
		};
	}
	return { trend: candidate, withheld: false, reasonCode: null };
}
