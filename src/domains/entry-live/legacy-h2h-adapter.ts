import type { ElementEventResultData } from "./calc-service";

/** FPL-rule provisional substitution projection shared by live entry and H2H desks. */
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
	picks: ElementEventResultData[]
): ElementEventResultData | null => {
	const captain = picks.find((pick) => pick.isCaptain) ?? null;
	if (!captain) return null;
	if (captain.isPlayed) return captain;
	if (!hasCompletedFixtures(captain)) return captain;
	return picks.find((pick) => pick.isViceCaptain) ?? captain;
};

/** Project the lineup FPL will settle once all currently completed fixtures are final. */
export const projectLiveLineup = (
	pickList: ElementEventResultData[],
	chip: string
): {
	activePicks: ElementEventResultData[];
	captainForScoring: ElementEventResultData | null;
	points: number;
} => {
	applyAutoSubs(pickList, chip);
	const isBenchBoost = chip === "BENCH_BOOST";
	const activePicks = pickList.filter((pick) => {
		const active = isBenchBoost || pick.multiplier > 0;
		pick.pickActive = active;
		pick.autoSub = !isBenchBoost && pick.position > 11 && pick.multiplier > 0;
		return active;
	});
	const captainForScoring = selectCaptainForScoring(pickList);
	const captainMultiplier = chip === "TRIPLE_CAPTAIN" ? 3 : 2;
	const captainIsActive =
		captainForScoring !== null &&
		activePicks.some((pick) => pick.element === captainForScoring.element);
	const points =
		activePicks.reduce((sum, pick) => sum + pick.totalPoints, 0) +
		(captainIsActive && captainForScoring
			? captainForScoring.totalPoints * (captainMultiplier - 1)
			: 0);
	return { activePicks, captainForScoring, points };
};
