import type {
	AvailabilityAssessment,
	OutputAssessment,
	PlayerGameweekSample,
	PlayerStateBaselineSeason,
	PlayerStateConfidence,
	PlayerStateDirection,
	PlayerStateDimensionRating,
	PlayerStateOutlook,
	PlayerStateOutlookGameweek,
	PlayerStateOwnBaseline,
	PlayerStateReason,
	PlayerStateTrend,
	ProcessAssessment,
	ReliabilityAssessment,
	RoleAssessment,
} from "./types";

const HISTORY_WEIGHTS = [0.55, 0.3, 0.15] as const;
const EXPECTED_METRICS_FIRST_SEASON = "2223";

const round = (value: number, places = 2): number => {
	const scale = 10 ** places;
	return Math.round(value * scale) / scale;
};

const median = (values: number[]): number | null => {
	if (values.length === 0) return null;
	const sorted = [...values].sort((left, right) => left - right);
	const midpoint = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0
		? ((sorted[midpoint - 1] ?? 0) + (sorted[midpoint] ?? 0)) / 2
		: (sorted[midpoint] ?? null);
};

const roleRank = (rating: PlayerStateDimensionRating): number | null => {
	switch (rating) {
		case "SECURE":
			return 2;
		case "MANAGED":
			return 1;
		case "AT_RISK":
			return 0;
		default:
			return null;
	}
};

function roleForWindow(samples: PlayerGameweekSample[]): Omit<RoleAssessment, "direction"> {
	const covered = samples.filter((sample) => sample.covered).slice(0, 5);
	const starters = covered.filter((sample) => sample.started);
	const starterMinutes = starters.map((sample) => sample.minutes);
	const medianStarterMinutes = median(starterMinutes);
	const playedMinutes = covered
		.filter((sample) => sample.minutes > 0)
		.map((sample) => sample.minutes);
	const minutesRange =
		playedMinutes.length > 1 ? Math.max(...playedMinutes) - Math.min(...playedMinutes) : null;

	if (covered.length < 3) {
		return {
			rating: "UNKNOWN",
			starts: starters.length,
			medianStarterMinutes,
			minutesRange,
			reasonCodes: ["ROLE_INSUFFICIENT_WINDOW"],
		};
	}

	if (starters.length >= 4 && (medianStarterMinutes ?? 0) >= 70) {
		return {
			rating: "SECURE",
			starts: starters.length,
			medianStarterMinutes,
			minutesRange,
			reasonCodes: ["ROLE_SECURE"],
		};
	}

	if (starters.length <= 1 || (medianStarterMinutes !== null && medianStarterMinutes < 45)) {
		return {
			rating: "AT_RISK",
			starts: starters.length,
			medianStarterMinutes,
			minutesRange,
			reasonCodes: ["ROLE_AT_RISK"],
		};
	}

	return {
		rating: "MANAGED",
		starts: starters.length,
		medianStarterMinutes,
		minutesRange,
		reasonCodes: [
			minutesRange !== null && minutesRange >= 30 ? "ROLE_MINUTES_VOLATILE" : "ROLE_MANAGED",
		],
	};
}

export function assessRole(
	recent: PlayerGameweekSample[],
	previous: PlayerGameweekSample[]
): RoleAssessment {
	const current = roleForWindow(recent);
	const prior = roleForWindow(previous);
	const currentRank = roleRank(current.rating);
	const priorRank = roleRank(prior.rating);
	let direction: PlayerStateDirection = "UNKNOWN";
	if (currentRank !== null) {
		direction =
			priorRank === null
				? "STABLE"
				: currentRank > priorRank
					? "RISING"
					: currentRank < priorRank
						? "FALLING"
						: "STABLE";
	}
	const reasonCodes = [...current.reasonCodes];
	if (direction === "RISING") reasonCodes.push("ROLE_IMPROVING");
	if (direction === "FALLING") reasonCodes.push("ROLE_DECLINING");
	return { ...current, direction, reasonCodes };
}

export function assessAvailability(
	input: {
		status: string | null;
		chanceOfPlayingThisRound: number | null;
		stale: boolean;
	} | null
): AvailabilityAssessment {
	if (!input || input.status === null) {
		return {
			unavailable: false,
			authoritative: false,
			stale: true,
			status: null,
			chance: null,
			reasonCode: "AVAILABILITY_UNKNOWN",
		};
	}
	const status = input.status.trim().toLowerCase();
	const unavailableStatuses = new Set(["i", "s", "u", "n"]);
	const unavailable = unavailableStatuses.has(status) || input.chanceOfPlayingThisRound === 0;
	return {
		unavailable,
		authoritative: true,
		stale: input.stale,
		status,
		chance: input.chanceOfPlayingThisRound,
		reasonCode: unavailable
			? "AVAILABILITY_UNAVAILABLE"
			: status === "d" || (input.chanceOfPlayingThisRound ?? 100) < 100
				? "AVAILABILITY_DOUBTFUL"
				: "AVAILABILITY_AVAILABLE",
	};
}

export function percentile(value: number | null, population: Array<number | null>): number | null {
	if (value === null || !Number.isFinite(value)) return null;
	const values = population.filter(
		(candidate): candidate is number => candidate !== null && Number.isFinite(candidate)
	);
	if (values.length === 0) return null;
	const lower = values.filter((candidate) => candidate < value).length;
	const equal = values.filter((candidate) => candidate === value).length;
	return round(((lower + equal * 0.5) / values.length) * 100, 1);
}

export function averagePercentiles(values: Array<number | null>): number | null {
	const usable = values.filter(
		(value): value is number => value !== null && Number.isFinite(value)
	);
	return usable.length === 0
		? null
		: round(usable.reduce((sum, value) => sum + value, 0) / usable.length, 1);
}

export function assessOutput(input: {
	currentPercentile: number | null;
	recentPercentile: number | null;
	seasonBaselinePercentile: number | null;
	ownBaselinePercentile: number | null;
}): OutputAssessment {
	const current = input.currentPercentile;
	const baselinePercentile = averagePercentiles([
		input.seasonBaselinePercentile,
		input.ownBaselinePercentile,
	]);
	const rating: PlayerStateDimensionRating =
		current === null ? "UNKNOWN" : current >= 70 ? "STRONG" : current >= 30 ? "TYPICAL" : "WEAK";
	let direction: PlayerStateDirection = "UNKNOWN";
	if (input.recentPercentile !== null && baselinePercentile !== null) {
		const delta = input.recentPercentile - baselinePercentile;
		direction = delta >= 15 ? "RISING" : delta <= -15 ? "FALLING" : "STABLE";
	}
	const reasonCodes = [
		rating === "STRONG"
			? "OUTPUT_STRONG"
			: rating === "TYPICAL"
				? "OUTPUT_TYPICAL"
				: rating === "WEAK"
					? "OUTPUT_WEAK"
					: "OUTPUT_INSUFFICIENT",
	];
	if (direction === "RISING") reasonCodes.push("OUTPUT_RISING");
	if (direction === "FALLING") reasonCodes.push("OUTPUT_FALLING");
	if (direction === "STABLE") reasonCodes.push("OUTPUT_STABLE");
	return {
		rating,
		direction,
		currentPercentile: current,
		recentPercentile: input.recentPercentile,
		baselinePercentile,
		reasonCodes,
	};
}

export function expectedMetricsAvailableForSeason(season: string): boolean {
	return /^\d{4}$/.test(season) && season >= EXPECTED_METRICS_FIRST_SEASON;
}

export function buildOwnBaseline(seasons: PlayerStateBaselineSeason[]): PlayerStateOwnBaseline {
	const eligible = [...seasons]
		.filter((season) => season.minutes >= 450 && season.positionPercentile !== null)
		.sort((left, right) => right.season.localeCompare(left.season))
		.slice(0, HISTORY_WEIGHTS.length);
	const rawWeights = HISTORY_WEIGHTS.slice(0, eligible.length);
	const totalWeight = rawWeights.reduce((sum, weight) => sum + weight, 0);
	const weightedSeasons = eligible.map((season, index) => ({
		...season,
		weight: totalWeight === 0 ? 0 : round((rawWeights[index] ?? 0) / totalWeight, 4),
	}));
	const weightedPercentile =
		weightedSeasons.length === 0
			? null
			: round(
					weightedSeasons.reduce(
						(sum, season) => sum + (season.positionPercentile ?? 0) * season.weight,
						0
					),
					1
				);
	return { weightedPercentile, seasons: weightedSeasons };
}

export function assessReliability(
	seasons: PlayerStateBaselineSeason[],
	currentMinutes: number
): ReliabilityAssessment {
	const baseline = buildOwnBaseline(seasons);
	const percentiles = baseline.seasons
		.map((season) => season.positionPercentile)
		.filter((value): value is number => value !== null);
	let rating: PlayerStateDimensionRating;
	if (percentiles.length >= 2) {
		const span = Math.max(...percentiles) - Math.min(...percentiles);
		rating = span <= 20 ? "PROVEN" : "VARIABLE";
	} else if (currentMinutes >= 450) {
		rating = "EMERGING";
	} else {
		rating = "INSUFFICIENT";
	}
	return {
		rating,
		direction: "STABLE",
		baseline,
		reasonCodes: [
			rating === "PROVEN"
				? "HISTORY_PROVEN"
				: rating === "VARIABLE"
					? "HISTORY_VARIABLE"
					: rating === "EMERGING"
						? "HISTORY_EMERGING"
						: "HISTORY_INSUFFICIENT",
		],
	};
}

export function assessOutlook(
	gameweeks: PlayerStateOutlookGameweek[],
	horizon: number
): PlayerStateOutlook {
	const window = [...gameweeks]
		.sort((left, right) => left.eventId - right.eventId)
		.slice(0, horizon);
	const fixtures = window.flatMap((gameweek) => gameweek.fixtures);
	const hasBgw = window.some((gameweek) => gameweek.bgw);
	const favourableCount = fixtures.filter((fixture) => fixture.difficulty <= 2).length;
	const difficultCount = fixtures.filter((fixture) => fixture.difficulty >= 4).length;
	const rating: PlayerStateDimensionRating =
		hasBgw || difficultCount >= 3 ? "DIFFICULT" : favourableCount >= 3 ? "FAVOURABLE" : "NEUTRAL";
	const difficulties = fixtures
		.map((fixture) => fixture.difficulty)
		.filter((difficulty) => difficulty >= 1 && difficulty <= 5);
	return {
		rating,
		horizon,
		averageDifficulty:
			difficulties.length === 0
				? null
				: round(difficulties.reduce((sum, value) => sum + value, 0) / difficulties.length, 2),
		gameweeks: window,
	};
}

const confidenceRank = (confidence: PlayerStateConfidence): number =>
	confidence === "HIGH" ? 2 : confidence === "MEDIUM" ? 1 : 0;

const capConfidence = (
	confidence: PlayerStateConfidence,
	maximum: PlayerStateConfidence
): PlayerStateConfidence =>
	confidenceRank(confidence) <= confidenceRank(maximum) ? confidence : maximum;

const reason = (
	code: string,
	dimension: PlayerStateReason["dimension"],
	current: number | null = null,
	baseline: number | null = null,
	percentile: number | null = null
): PlayerStateReason => ({ code, dimension, current, baseline, percentile });

export function composePlayerState(input: {
	availability: AvailabilityAssessment;
	role: RoleAssessment;
	output: OutputAssessment;
	process: ProcessAssessment;
	fplSufficient: boolean;
	completeFplWindow: boolean;
	historySeasonCount: number;
}): {
	trend: PlayerStateTrend;
	confidence: PlayerStateConfidence;
	reasons: PlayerStateReason[];
} {
	if (input.availability.unavailable) {
		return {
			trend: "UNAVAILABLE",
			confidence: input.availability.authoritative && !input.availability.stale ? "HIGH" : "MEDIUM",
			reasons: [
				reason("AVAILABILITY_UNAVAILABLE", "AVAILABILITY_ROLE", input.availability.chance),
				reason(input.role.reasonCodes[0] ?? "ROLE_UNKNOWN", "AVAILABILITY_ROLE", input.role.starts),
			],
		};
	}

	if (!input.fplSufficient || input.output.direction === "UNKNOWN") {
		return {
			trend: "UNKNOWN",
			confidence: "LOW",
			reasons: [
				reason("CURRENT_FPL_INSUFFICIENT", "FPL_OUTPUT"),
				reason(input.role.reasonCodes[0] ?? "ROLE_UNKNOWN", "AVAILABILITY_ROLE", input.role.starts),
				...(input.process.available ? [] : [reason("FPL_ONLY", "REAL_WORLD_PROCESS")]),
			].slice(0, 3),
		};
	}

	const output = input.output.direction;
	const process = input.process.direction;
	const role = input.role.direction;
	let trend: PlayerStateTrend;
	let primaryReason: PlayerStateReason;

	if (input.process.available) {
		if (
			input.role.rating === "AT_RISK" &&
			(input.output.direction === "RISING" || input.process.direction === "RISING")
		) {
			trend = "MIXED";
			primaryReason = reason("ROLE_PERFORMANCE_CONFLICT", "AVAILABILITY_ROLE", input.role.starts);
		} else if (input.role.rating === "AT_RISK") {
			trend = "FALLING";
			primaryReason = reason("ROLE_AT_RISK", "AVAILABILITY_ROLE", input.role.starts);
		} else if (
			(output === "RISING" && process === "FALLING") ||
			(output === "FALLING" && process === "RISING")
		) {
			trend = "MIXED";
			primaryReason = reason(
				output === "RISING" ? "OUTPUT_UP_PROCESS_DOWN" : "OUTPUT_DOWN_PROCESS_UP",
				"REAL_WORLD_PROCESS",
				input.output.recentPercentile,
				input.output.baselinePercentile,
				input.output.currentPercentile
			);
		} else if (
			role !== "UNKNOWN" &&
			role !== "STABLE" &&
			((role === "RISING" && (output === "FALLING" || process === "FALLING")) ||
				(role === "FALLING" && (output === "RISING" || process === "RISING")))
		) {
			trend = "MIXED";
			primaryReason = reason("ROLE_PERFORMANCE_CONFLICT", "AVAILABILITY_ROLE", input.role.starts);
		} else if (output === "RISING" && process === "RISING" && role !== "FALLING") {
			trend = "RISING";
			primaryReason = reason(
				"OUTPUT_PROCESS_UP",
				"FPL_OUTPUT",
				input.output.recentPercentile,
				input.output.baselinePercentile,
				input.output.currentPercentile
			);
		} else if (
			(output === "FALLING" && process === "FALLING") ||
			(role === "FALLING" && output === "FALLING" && process === "FALLING")
		) {
			trend = "FALLING";
			primaryReason = reason(
				"OUTPUT_PROCESS_DOWN",
				"FPL_OUTPUT",
				input.output.recentPercentile,
				input.output.baselinePercentile,
				input.output.currentPercentile
			);
		} else {
			trend = "STABLE";
			primaryReason = reason("SIGNALS_STABLE", "FPL_OUTPUT", input.output.recentPercentile);
		}
	} else if (input.role.rating === "AT_RISK" && output === "RISING") {
		trend = "MIXED";
		primaryReason = reason("ROLE_OUTPUT_CONFLICT", "AVAILABILITY_ROLE", input.role.starts);
	} else if (input.role.rating === "AT_RISK") {
		trend = "FALLING";
		primaryReason = reason("ROLE_AT_RISK", "AVAILABILITY_ROLE", input.role.starts);
	} else if (
		(output === "RISING" && role === "FALLING") ||
		(output === "FALLING" && role === "RISING")
	) {
		trend = "MIXED";
		primaryReason = reason("ROLE_OUTPUT_CONFLICT", "AVAILABILITY_ROLE", input.role.starts);
	} else if (output === "RISING" || (output === "STABLE" && role === "RISING")) {
		trend = "RISING";
		primaryReason = reason(
			"FPL_OUTPUT_UP",
			"FPL_OUTPUT",
			input.output.recentPercentile,
			input.output.baselinePercentile,
			input.output.currentPercentile
		);
	} else if (output === "FALLING" || role === "FALLING") {
		trend = "FALLING";
		primaryReason = reason(
			output === "FALLING" ? "FPL_OUTPUT_DOWN" : "ROLE_DECLINING",
			output === "FALLING" ? "FPL_OUTPUT" : "AVAILABILITY_ROLE",
			output === "FALLING" ? input.output.recentPercentile : input.role.starts,
			output === "FALLING" ? input.output.baselinePercentile : null,
			input.output.currentPercentile
		);
	} else {
		trend = "STABLE";
		primaryReason = reason("FPL_SIGNALS_STABLE", "FPL_OUTPUT", input.output.recentPercentile);
	}

	let confidence: PlayerStateConfidence =
		input.completeFplWindow && input.process.sampleMinutes >= 450 && input.historySeasonCount >= 2
			? "HIGH"
			: "MEDIUM";
	if (input.process.smallSample) confidence = capConfidence(confidence, "MEDIUM");
	if (!input.process.available) confidence = "LOW";
	if (trend === "MIXED") confidence = capConfidence(confidence, "MEDIUM");

	const reasons = [
		primaryReason,
		reason(
			input.role.reasonCodes[0] ?? "ROLE_UNKNOWN",
			"AVAILABILITY_ROLE",
			input.role.starts,
			input.role.medianStarterMinutes
		),
		...(input.process.available
			? input.process.smallSample
				? [reason("SMALL_SAMPLE", "REAL_WORLD_PROCESS", input.process.sampleMinutes)]
				: []
			: [reason("FPL_ONLY", "REAL_WORLD_PROCESS")]),
	].slice(0, 3);

	return { trend, confidence, reasons };
}
