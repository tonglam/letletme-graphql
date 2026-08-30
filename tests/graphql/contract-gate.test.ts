import { describe, expect, it } from "bun:test";
import {
	MY_TOURNAMENT_REVIEW_CONTRACT,
	MY_TOURNAMENT_REVIEW_CONTRACT_HEADER,
	requiresMyTournamentReviewV2,
	validateMyTournamentReviewContract,
} from "../../src/graphql/contract-gate";

describe("My Tournament Review V2 contract gate", () => {
	it("detects every V2 root and ignores unrelated roots", () => {
		expect(requiresMyTournamentReviewV2(["events"])).toBe(false);
		expect(requiresMyTournamentReviewV2(["myTournamentReviewCatalog"])).toBe(true);
		expect(requiresMyTournamentReviewV2(["myTournamentSeasonReview", "events"])).toBe(true);
	});

	it("requires the explicit V2 header", () => {
		const missing = validateMyTournamentReviewContract(
			["myTournamentGameweekReview"],
			new Headers()
		);
		expect(missing).toEqual({
			status: 426,
			code: "CLIENT_UPGRADE_REQUIRED",
			message: `The ${MY_TOURNAMENT_REVIEW_CONTRACT} client contract is required`,
		});

		const accepted = validateMyTournamentReviewContract(
			["myTournamentGameweekReview"],
			new Headers({ [MY_TOURNAMENT_REVIEW_CONTRACT_HEADER]: MY_TOURNAMENT_REVIEW_CONTRACT })
		);
		expect(accepted).toBeNull();
	});

	it("does not gate legacy roots", () => {
		expect(validateMyTournamentReviewContract(["myFplCompetitionBoard"], new Headers())).toBeNull();
	});
});
