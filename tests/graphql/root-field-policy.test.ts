import { describe, expect, it } from "bun:test";
import { LIGHTWEIGHT_CORE_FIELDS } from "../../src/graphql/root-field-policy";

describe("root field policy", () => {
	it("classifies every My Tournament Review V2 root as lightweight", () => {
		for (const field of [
			"myTournamentReviewCatalog",
			"myTournamentGameweekReview",
			"myTournamentSeasonReview",
			"myTournamentReviewStatus",
		]) {
			expect(LIGHTWEIGHT_CORE_FIELDS.has(field)).toBe(true);
		}
	});
});
