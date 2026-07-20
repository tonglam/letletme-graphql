import { describe, expect, it } from "bun:test";
import type { ElementEventResultData } from "../../../src/domains/entry-live/calc-service";
import {
	applyAutoSubs,
	calcElementLivePoints,
	calcOfficialTotalWithEffectiveBonus,
} from "../../../src/domains/entry-live/calc-service";
import type { LivePerformance } from "../../../src/domains/live/repository";

const makeLive = (overrides: Partial<LivePerformance> = {}): LivePerformance => ({
	eventId: 1,
	playerId: 1,
	minutes: 90,
	goalsScored: 0,
	assists: 0,
	cleanSheets: 0,
	goalsConceded: 0,
	ownGoals: 0,
	penaltiesSaved: 0,
	penaltiesMissed: 0,
	yellowCards: 0,
	redCards: 0,
	saves: 0,
	bonus: 0,
	bps: 0,
	defensiveContribution: 0,
	starts: true,
	expectedGoals: null,
	expectedAssists: null,
	expectedGoalInvolvements: null,
	expectedGoalsConceded: null,
	inDreamTeam: null,
	totalPoints: 0,
	...overrides,
});

const makePick = (overrides: Partial<ElementEventResultData> = {}): ElementEventResultData => ({
	season: null,
	event: 1,
	element: 1,
	code: 1,
	webName: "Test",
	price: 10,
	elementType: 3,
	elementTypeName: "MID",
	teamId: 1,
	teamCode: 1,
	teamName: "Test FC",
	teamShortName: "TFC",
	againstId: 2,
	againstName: "Opp",
	againstShortName: "OPP",
	wasHome: "H",
	score: "1-0",
	position: 1,
	multiplier: 1,
	isCaptain: false,
	isViceCaptain: false,
	isGwStarted: true,
	isGwFinished: true,
	isPlayed: true,
	playStatus: 4,
	minutes: 90,
	goalsScored: 0,
	assists: 0,
	cleanSheets: 0,
	goalsConceded: 0,
	defensiveContribution: 0,
	ownGoals: 0,
	penaltiesSaved: 0,
	penaltiesMissed: 0,
	yellowCards: 0,
	redCards: 0,
	saves: 0,
	bonus: 0,
	bps: 0,
	totalPoints: 5,
	starts: true,
	expectedGoals: null,
	expectedAssists: null,
	expectedGoalInvolvements: null,
	expectedGoalsConceded: null,
	inDreamTeam: false,
	pickActive: false,
	autoSub: false,
	bgw: false,
	dgw: false,
	...overrides,
});

describe("calcElementLivePoints", () => {
	it("preserves official fixture rounding while replacing provisional bonus", () => {
		const live = makeLive({ totalPoints: 11, bonus: 2, minutes: 180 });
		expect(calcOfficialTotalWithEffectiveBonus(live, 5)).toBe(14);
		expect(calcOfficialTotalWithEffectiveBonus(live)).toBe(11);
	});
	it("returns 0 for undefined live", () => {
		expect(calcElementLivePoints(1, undefined)).toBe(0);
	});

	it("calculates midfielder points from current live stats", () => {
		const live = makeLive({
			totalPoints: 0,
			minutes: 90,
			goalsScored: 1,
			assists: 1,
			cleanSheets: 1,
			bonus: 2,
		});

		expect(calcElementLivePoints(3, live)).toBe(13);
	});

	it("does not use stale FPL totalPoints", () => {
		const live = makeLive({
			totalPoints: 99,
			minutes: 90,
			goalsScored: 0,
			assists: 0,
			cleanSheets: 0,
			bonus: 0,
		});

		expect(calcElementLivePoints(2, live)).toBe(2);
	});

	it("returns 0 when no scoring stats are present", () => {
		const live = makeLive({ totalPoints: 9, minutes: 0 });
		expect(calcElementLivePoints(2, live)).toBe(0);
	});

	it("calculates defender clean sheet, goals conceded, cards, and defensive contribution", () => {
		const live = makeLive({
			totalPoints: 0,
			minutes: 90,
			cleanSheets: 1,
			goalsConceded: 2,
			yellowCards: 1,
			defensiveContribution: 10,
		});

		expect(calcElementLivePoints(2, live)).toBe(6);
	});

	it("calculates goalkeeper save and penalty points", () => {
		const live = makeLive({
			totalPoints: 0,
			minutes: 90,
			cleanSheets: 1,
			saves: 7,
			penaltiesSaved: 1,
			bonus: 3,
		});

		expect(calcElementLivePoints(1, live)).toBe(16);
	});

	it("calculates forward attacking and negative points", () => {
		const live = makeLive({
			totalPoints: 0,
			minutes: 45,
			goalsScored: 1,
			assists: 1,
			ownGoals: 1,
			penaltiesMissed: 1,
			redCards: 1,
			bonus: 1,
			defensiveContribution: 12,
		});

		expect(calcElementLivePoints(4, live)).toBe(4);
	});
});

describe("applyAutoSubs", () => {
	it("does nothing during bench boost", () => {
		const picks = [
			makePick({ position: 1, elementType: 1, minutes: 0, multiplier: 1 }),
			makePick({ position: 12, elementType: 2, minutes: 90, multiplier: 0 }),
		];
		applyAutoSubs(picks, "BENCH_BOOST");
		expect(picks[0].multiplier).toBe(1);
		expect(picks[1].multiplier).toBe(0);
	});

	it("subjects bench player in for non-playing starter", () => {
		const picks = [
			// Starters
			makePick({ position: 1, elementType: 1, minutes: 90, multiplier: 1 }), // GK played
			makePick({ position: 2, elementType: 2, minutes: 0, multiplier: 1 }), // DEF didn't play
			makePick({ position: 3, elementType: 2, minutes: 90, multiplier: 1 }),
			makePick({ position: 4, elementType: 2, minutes: 90, multiplier: 1 }),
			makePick({ position: 5, elementType: 2, minutes: 90, multiplier: 1 }),
			makePick({ position: 6, elementType: 3, minutes: 90, multiplier: 1 }),
			makePick({ position: 7, elementType: 3, minutes: 90, multiplier: 1 }),
			makePick({ position: 8, elementType: 3, minutes: 90, multiplier: 1 }),
			makePick({ position: 9, elementType: 3, minutes: 90, multiplier: 1 }),
			makePick({ position: 10, elementType: 4, minutes: 90, multiplier: 1 }),
			makePick({ position: 11, elementType: 4, minutes: 90, multiplier: 1 }),
			// Bench
			makePick({
				position: 12,
				elementType: 2,
				minutes: 90,
				multiplier: 0,
				totalPoints: 6,
			}),
			makePick({ position: 13, elementType: 3, minutes: 0, multiplier: 0 }),
			makePick({ position: 14, elementType: 3, minutes: 0, multiplier: 0 }),
			makePick({ position: 15, elementType: 4, minutes: 0, multiplier: 0 }),
		];
		applyAutoSubs(picks, "NONE");
		// Position 2 (DEF, 0 min) should be subbed out
		// Position 12 (DEF, 90 min) should come on
		expect(picks[1].multiplier).toBe(0); // Starter subbed out
		expect(picks[11].multiplier).toBe(1); // Bench player came on
	});

	it("respects bench order (12 before 13)", () => {
		const picks = [
			makePick({ position: 1, elementType: 1, minutes: 90, multiplier: 1 }),
			makePick({ position: 2, elementType: 2, minutes: 0, multiplier: 1 }),
			makePick({ position: 3, elementType: 2, minutes: 90, multiplier: 1 }),
			makePick({ position: 4, elementType: 2, minutes: 90, multiplier: 1 }),
			makePick({ position: 5, elementType: 2, minutes: 90, multiplier: 1 }),
			makePick({ position: 6, elementType: 3, minutes: 90, multiplier: 1 }),
			makePick({ position: 7, elementType: 3, minutes: 90, multiplier: 1 }),
			makePick({ position: 8, elementType: 3, minutes: 90, multiplier: 1 }),
			makePick({ position: 9, elementType: 3, minutes: 90, multiplier: 1 }),
			makePick({ position: 10, elementType: 4, minutes: 90, multiplier: 1 }),
			makePick({ position: 11, elementType: 4, minutes: 90, multiplier: 1 }),
			makePick({
				position: 12,
				elementType: 3,
				minutes: 90,
				multiplier: 0,
				totalPoints: 8,
			}), // MID bench
			makePick({
				position: 13,
				elementType: 2,
				minutes: 90,
				multiplier: 0,
				totalPoints: 6,
			}), // DEF bench
		];
		applyAutoSubs(picks, "NONE");
		// Position 12 (MID) cannot replace position 2 (DEF) - would give 3 DEF, 6 MID, 2 FWD = valid
		// Actually wait: 1 GK + 2 DEF + 6 MID + 2 FWD = 11, that's valid!
		// So position 12 should come on first
		expect(picks[11].multiplier).toBe(1); // Position 12 came on
		expect(picks[1].multiplier).toBe(0); // Position 2 subbed out
	});

	it("skips bench player who did not play", () => {
		const picks = [
			makePick({ position: 1, elementType: 1, minutes: 90, multiplier: 1 }),
			makePick({ position: 2, elementType: 2, minutes: 0, multiplier: 1 }),
			makePick({ position: 3, elementType: 2, minutes: 90, multiplier: 1 }),
			makePick({ position: 4, elementType: 2, minutes: 90, multiplier: 1 }),
			makePick({ position: 5, elementType: 2, minutes: 90, multiplier: 1 }),
			makePick({ position: 6, elementType: 3, minutes: 90, multiplier: 1 }),
			makePick({ position: 7, elementType: 3, minutes: 90, multiplier: 1 }),
			makePick({ position: 8, elementType: 3, minutes: 90, multiplier: 1 }),
			makePick({ position: 9, elementType: 3, minutes: 90, multiplier: 1 }),
			makePick({ position: 10, elementType: 4, minutes: 90, multiplier: 1 }),
			makePick({ position: 11, elementType: 4, minutes: 90, multiplier: 1 }),
			makePick({ position: 12, elementType: 2, minutes: 0, multiplier: 0 }), // Didn't play
			makePick({ position: 13, elementType: 2, minutes: 90, multiplier: 0 }), // Played
		];
		applyAutoSubs(picks, "NONE");
		expect(picks[11].multiplier).toBe(0); // Position 12 stayed on bench (didn't play)
		expect(picks[12].multiplier).toBe(1); // Position 13 came on
		expect(picks[1].multiplier).toBe(0); // Starter subbed out
	});

	it("does not sub if formation would be invalid", () => {
		const picks = [
			makePick({ position: 1, elementType: 1, minutes: 90, multiplier: 1 }),
			makePick({ position: 2, elementType: 2, minutes: 0, multiplier: 1 }),
			makePick({ position: 3, elementType: 2, minutes: 0, multiplier: 1 }),
			makePick({ position: 4, elementType: 2, minutes: 90, multiplier: 1 }),
			makePick({ position: 5, elementType: 3, minutes: 90, multiplier: 1 }),
			makePick({ position: 6, elementType: 3, minutes: 90, multiplier: 1 }),
			makePick({ position: 7, elementType: 3, minutes: 90, multiplier: 1 }),
			makePick({ position: 8, elementType: 3, minutes: 90, multiplier: 1 }),
			makePick({ position: 9, elementType: 3, minutes: 90, multiplier: 1 }),
			makePick({ position: 10, elementType: 4, minutes: 90, multiplier: 1 }),
			makePick({ position: 11, elementType: 4, minutes: 90, multiplier: 1 }),
			makePick({ position: 12, elementType: 4, minutes: 90, multiplier: 0 }), // FWD bench
		];
		applyAutoSubs(picks, "NONE");
		// Replacing a DEF with a FWD would give: 1 GK + 1 DEF + 5 MID + 3 FWD
		// 1 DEF is invalid (< 3), so no sub should happen
		expect(picks[1].multiplier).toBe(1);
		expect(picks[2].multiplier).toBe(1);
		expect(picks[11].multiplier).toBe(0);
	});

	it("handles multiple auto-subs", () => {
		const picks = [
			makePick({ position: 1, elementType: 1, minutes: 90, multiplier: 1 }),
			makePick({ position: 2, elementType: 2, minutes: 0, multiplier: 1 }),
			makePick({ position: 3, elementType: 2, minutes: 0, multiplier: 1 }),
			makePick({ position: 4, elementType: 2, minutes: 90, multiplier: 1 }),
			makePick({ position: 5, elementType: 3, minutes: 90, multiplier: 1 }),
			makePick({ position: 6, elementType: 3, minutes: 90, multiplier: 1 }),
			makePick({ position: 7, elementType: 3, minutes: 90, multiplier: 1 }),
			makePick({ position: 8, elementType: 3, minutes: 90, multiplier: 1 }),
			makePick({ position: 9, elementType: 3, minutes: 90, multiplier: 1 }),
			makePick({ position: 10, elementType: 4, minutes: 90, multiplier: 1 }),
			makePick({ position: 11, elementType: 4, minutes: 90, multiplier: 1 }),
			makePick({ position: 12, elementType: 2, minutes: 90, multiplier: 0 }), // DEF bench
			makePick({ position: 13, elementType: 2, minutes: 90, multiplier: 0 }), // DEF bench
		];
		applyAutoSubs(picks, "NONE");
		expect(picks[1].multiplier).toBe(0); // First DEF subbed out
		expect(picks[2].multiplier).toBe(0); // Second DEF subbed out
		expect(picks[11].multiplier).toBe(1); // First bench DEF came on
		expect(picks[12].multiplier).toBe(1); // Second bench DEF came on
	});

	it("does nothing when all starters played", () => {
		const picks = [
			makePick({ position: 1, elementType: 1, minutes: 90, multiplier: 1 }),
			makePick({ position: 2, elementType: 2, minutes: 90, multiplier: 1 }),
			makePick({ position: 12, elementType: 2, minutes: 90, multiplier: 0 }),
		];
		applyAutoSubs(picks, "NONE");
		expect(picks[0].multiplier).toBe(1);
		expect(picks[1].multiplier).toBe(1);
		expect(picks[2].multiplier).toBe(0);
	});
});
