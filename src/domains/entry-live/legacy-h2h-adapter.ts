import type { ElementEventResultData } from "./calc-service";

/**
 * Legacy H2H-only substitution adapter.
 *
 * FPL does not currently expose a usable live H2H aggregate. Keep the old
 * prediction logic isolated here so the single-entry, Classic, and
 * tournament paths cannot accidentally use it for their official headline.
 */
export const applyAutoSubs = (pickList: ElementEventResultData[], chip: string): void => {
	if (chip === "BENCH_BOOST") return;

	const starters = pickList.filter((pick) => pick.position <= 11);
	const bench = pickList
		.filter((pick) => pick.position > 11)
		.sort((left, right) => left.position - right.position);
	const nonPlayingStarters = starters.filter(
		(pick) => pick.minutes === 0 && pick.multiplier > 0 && (pick.isGwFinished || pick.bgw)
	);

	const isValidFormation = (active: ElementEventResultData[]): boolean => {
		const goalkeeperCount = active.filter((pick) => pick.elementType === 1).length;
		const defenderCount = active.filter((pick) => pick.elementType === 2).length;
		const midfielderCount = active.filter((pick) => pick.elementType === 3).length;
		const forwardCount = active.filter((pick) => pick.elementType === 4).length;
		return (
			goalkeeperCount === 1 &&
			defenderCount >= 3 &&
			defenderCount <= 5 &&
			midfielderCount >= 2 &&
			midfielderCount <= 5 &&
			forwardCount >= 1 &&
			forwardCount <= 3
		);
	};

	for (const benchPlayer of bench) {
		if (benchPlayer.minutes === 0) continue;
		if (nonPlayingStarters.length === 0) break;

		for (let index = 0; index < nonPlayingStarters.length; index += 1) {
			const starter = nonPlayingStarters[index];
			const originalStarterMultiplier = starter.multiplier;
			const originalBenchMultiplier = benchPlayer.multiplier;

			starter.multiplier = 0;
			benchPlayer.multiplier = 1;
			if (isValidFormation(pickList.filter((pick) => pick.multiplier > 0))) {
				nonPlayingStarters.splice(index, 1);
				break;
			}

			starter.multiplier = originalStarterMultiplier;
			benchPlayer.multiplier = originalBenchMultiplier;
		}
	}
};

const hasCompletedFixtures = (pick: ElementEventResultData): boolean =>
	pick.isGwFinished || pick.playStatus === 0 || pick.bgw;

export const selectCaptainForScoring = (
	picks: ElementEventResultData[],
): ElementEventResultData | null => {
	const captain = picks.find((pick) => pick.isCaptain) ?? null;
	if (!captain) return null;
	if (captain.isPlayed) return captain;
	if (!hasCompletedFixtures(captain)) return captain;
	return picks.find((pick) => pick.isViceCaptain) ?? captain;
};
