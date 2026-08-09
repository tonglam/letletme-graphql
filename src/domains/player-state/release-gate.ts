import type { PlayerStateTrend } from "./types";

export const PLAYER_STATE_RELEASE_EVIDENCE = {
	engineVersion: "player-state-v1.1",
	evaluatedAt: "2026-08-09",
	mode: "fpl-only",
	seasons: [],
	observations: 0,
	futureFivePointMeans: {
		RISING: null,
		STABLE: null,
		FALLING: null,
	},
	released: false,
	reason: "FPL_HISTORY_STORAGE_UNAVAILABLE",
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
