import { describe, expect, it } from "bun:test";
import {
	assessAvailability,
	assessOutlook,
	assessOutput,
	assessReliability,
	assessRole,
	buildOwnBaseline,
	composePlayerState,
	expectedMetricsAvailableForSeason,
} from "../../../src/domains/player-state/engine";
import type {
	OutputAssessment,
	PlayerGameweekSample,
	PlayerStateBaselineSeason,
	ProcessAssessment,
	RoleAssessment,
} from "../../../src/domains/player-state/types";

const sample = (
	eventId: number,
	started: boolean,
	minutes: number,
	totalPoints = 2
): PlayerGameweekSample => ({
	eventId,
	started,
	minutes,
	totalPoints,
	bonus: 0,
	covered: true,
});

const output = (
	direction: OutputAssessment["direction"],
	current = 70,
	baseline = 50
): OutputAssessment => ({
	rating: current >= 70 ? "STRONG" : current >= 30 ? "TYPICAL" : "WEAK",
	direction,
	currentPercentile: current,
	recentPercentile: current,
	baselinePercentile: baseline,
	reasonCodes: [],
});

const role = (direction: RoleAssessment["direction"] = "STABLE"): RoleAssessment => ({
	rating: "SECURE",
	direction,
	starts: 5,
	medianStarterMinutes: 90,
	minutesRange: 0,
	reasonCodes: ["ROLE_SECURE"],
});

const process = (
	direction: ProcessAssessment["direction"],
	available = true
): ProcessAssessment => ({
	rating: available ? "STRONG" : "UNAVAILABLE",
	direction: available ? direction : "UNKNOWN",
	available,
	sampleMinutes: available ? 500 : 0,
	smallSample: false,
	reasonCodes: [],
	metrics: [],
});

const available = assessAvailability({
	status: "a",
	chanceOfPlayingThisRound: 100,
	stale: false,
});

const baselineSeason = (
	season: string,
	positionPercentile: number,
	minutes = 900
): PlayerStateBaselineSeason => ({
	season,
	position: 3,
	minutes,
	pointsPer90: 5,
	returnRate: 50,
	bonusPer90: 0.5,
	positionPercentile,
	weight: 0,
	expectedMetricsAvailable: expectedMetricsAvailableForSeason(season),
	understatProcessPercentile: null,
});

describe("Player State role and availability", () => {
	it("rates four durable starts with a 70+ median as secure", () => {
		const result = assessRole(
			[
				sample(5, true, 90),
				sample(4, true, 75),
				sample(3, true, 70),
				sample(2, true, 60),
				sample(1, false, 20),
			],
			[]
		);

		expect(result.rating).toBe("SECURE");
		expect(result.medianStarterMinutes).toBe(72.5);
		expect(result.reasonCodes).toContain("ROLE_SECURE");
	});

	it("does not call an early one-game window at risk", () => {
		const result = assessRole([sample(1, false, 0)], []);

		expect(result.rating).toBe("UNKNOWN");
		expect(result.reasonCodes).toContain("ROLE_INSUFFICIENT_WINDOW");
	});

	it("uses official status and zero chance as the availability gate", () => {
		expect(
			assessAvailability({ status: "i", chanceOfPlayingThisRound: 75, stale: false }).unavailable
		).toBe(true);
		expect(
			assessAvailability({ status: "a", chanceOfPlayingThisRound: 0, stale: false }).unavailable
		).toBe(true);
		expect(assessAvailability(null).authoritative).toBe(false);
	});

	it("does not let stale injury data override current FPL evidence", () => {
		expect(assessAvailability({ status: "i", chanceOfPlayingThisRound: 0, stale: true })).toEqual({
			unavailable: false,
			authoritative: false,
			stale: true,
			status: "i",
			chance: 0,
			reasonCode: "AVAILABILITY_STALE",
		});
	});
});

describe("Player State output and history", () => {
	it("requires a 15 percentile-point move for direction", () => {
		expect(
			assessOutput({
				currentPercentile: 72,
				recentPercentile: 70,
				seasonBaselinePercentile: 50,
				ownBaselinePercentile: 60,
			}).direction
		).toBe("RISING");
		expect(
			assessOutput({
				currentPercentile: 55,
				recentPercentile: 69,
				seasonBaselinePercentile: 55,
				ownBaselinePercentile: 55,
			}).direction
		).toBe("STABLE");
	});

	it("normalizes 55/30/15 weights when fewer seasons exist", () => {
		const three = buildOwnBaseline([
			baselineSeason("2526", 80),
			baselineSeason("2425", 60),
			baselineSeason("2324", 40),
		]);
		expect(three.seasons.map((season) => season.weight)).toEqual([0.55, 0.3, 0.15]);
		expect(three.weightedPercentile).toBe(68);

		const two = buildOwnBaseline([baselineSeason("2526", 80), baselineSeason("2425", 60)]);
		expect(two.seasons.map((season) => season.weight)).toEqual([0.6471, 0.3529]);
		expect(two.weightedPercentile).toBeCloseTo(72.94, 1);
	});

	it("classifies historical reliability without letting old seasons become current state", () => {
		expect(
			assessReliability([baselineSeason("2526", 78), baselineSeason("2425", 62)], 100).rating
		).toBe("PROVEN");
		expect(
			assessReliability([baselineSeason("2526", 85), baselineSeason("2425", 40)], 100).rating
		).toBe("VARIABLE");
		expect(assessReliability([], 500).rating).toBe("EMERGING");
	});

	it("masks FPL expected metrics before 2022/23", () => {
		expect(expectedMetricsAvailableForSeason("2122")).toBe(false);
		expect(expectedMetricsAvailableForSeason("2223")).toBe(true);
	});
});

describe("Player State outlook", () => {
	it("keeps DGW fixtures and makes any BGW difficult", () => {
		const result = assessOutlook(
			[
				{
					eventId: 1,
					bgw: false,
					dgw: true,
					averageDifficulty: 2,
					fixtures: [
						{
							id: 1,
							opponentTeamShortName: "ARS",
							wasHome: true,
							difficulty: 2,
							kickoffTime: null,
						},
						{
							id: 2,
							opponentTeamShortName: "CHE",
							wasHome: false,
							difficulty: 2,
							kickoffTime: null,
						},
					],
				},
				{
					eventId: 2,
					bgw: true,
					dgw: false,
					averageDifficulty: null,
					fixtures: [],
				},
			],
			5
		);

		expect(result.gameweeks[0]?.fixtures).toHaveLength(2);
		expect(result.rating).toBe("DIFFICULT");
	});

	it("does not treat unknown fixture difficulty as favourable", () => {
		const result = assessOutlook(
			[
				{
					eventId: 1,
					bgw: false,
					dgw: false,
					averageDifficulty: null,
					fixtures: [
						{
							id: 1,
							opponentTeamShortName: "ARS",
							wasHome: true,
							difficulty: 0,
							kickoffTime: null,
						},
						{
							id: 2,
							opponentTeamShortName: "CHE",
							wasHome: false,
							difficulty: 0,
							kickoffTime: null,
						},
						{
							id: 3,
							opponentTeamShortName: "LIV",
							wasHome: true,
							difficulty: 0,
							kickoffTime: null,
						},
					],
				},
			],
			1
		);

		expect(result.rating).toBe("NEUTRAL");
		expect(result.averageDifficulty).toBeNull();
	});
});

describe("Player State top-level composition", () => {
	it("returns Mixed when output rises while process falls", () => {
		const result = composePlayerState({
			availability: available,
			role: role(),
			output: output("RISING"),
			process: process("FALLING"),
			fplSufficient: true,
			completeFplWindow: true,
			historySeasonCount: 3,
		});

		expect(result.trend).toBe("MIXED");
		expect(result.confidence).toBe("MEDIUM");
		expect(result.reasons[0]?.code).toBe("OUTPUT_UP_PROCESS_DOWN");
	});

	it("lets official unavailability override positive current and historical signals", () => {
		const result = composePlayerState({
			availability: assessAvailability({
				status: "s",
				chanceOfPlayingThisRound: 0,
				stale: false,
			}),
			role: role("RISING"),
			output: output("RISING", 95),
			process: process("RISING"),
			fplSufficient: true,
			completeFplWindow: true,
			historySeasonCount: 3,
		});

		expect(result.trend).toBe("UNAVAILABLE");
		expect(result.confidence).toBe("HIGH");
	});

	it("publishes an FPL-only direction but caps confidence at Low", () => {
		const result = composePlayerState({
			availability: available,
			role: role(),
			output: output("RISING"),
			process: process("UNKNOWN", false),
			fplSufficient: true,
			completeFplWindow: true,
			historySeasonCount: 3,
		});

		expect(result.trend).toBe("RISING");
		expect(result.confidence).toBe("LOW");
		expect(result.reasons.map((item) => item.code)).toContain("FPL_ONLY");
	});

	it("does not label a persistently at-risk role as Stable", () => {
		const result = composePlayerState({
			availability: available,
			role: {
				...role(),
				rating: "AT_RISK",
				starts: 1,
				reasonCodes: ["ROLE_AT_RISK"],
			},
			output: output("STABLE", 45, 45),
			process: process("UNKNOWN", false),
			fplSufficient: true,
			completeFplWindow: true,
			historySeasonCount: 3,
		});

		expect(result.trend).toBe("FALLING");
		expect(result.reasons[0]?.code).toBe("ROLE_AT_RISK");
	});

	it("returns Unknown when current FPL evidence is insufficient", () => {
		const result = composePlayerState({
			availability: available,
			role: role(),
			output: output("UNKNOWN"),
			process: process("UNKNOWN", false),
			fplSufficient: false,
			completeFplWindow: false,
			historySeasonCount: 3,
		});

		expect(result.trend).toBe("UNKNOWN");
		expect(result.confidence).toBe("LOW");
		expect(result.reasons[0]?.code).toBe("CURRENT_FPL_INSUFFICIENT");
	});
});
