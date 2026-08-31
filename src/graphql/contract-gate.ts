import type { GraphQLContext } from "./context";

export const MY_TOURNAMENT_REVIEW_CONTRACT = "my-tournament-review-v2";
export const MY_TOURNAMENT_REVIEW_CONTRACT_HEADER = "x-letletme-contract";

const hasContractToken = (value: string | null | undefined, expected: string): boolean =>
	(value ?? "")
		.split(",")
		.map((token) => token.trim())
		.some((token) => token === expected);

export type ContractGateFailure = Readonly<{
	status: 426;
	code: "CLIENT_UPGRADE_REQUIRED";
	message: string;
}>;

export function requiresMyTournamentReviewV2(rootFields: readonly string[]): boolean {
	return rootFields.some((field) =>
		[
			"myTournamentReviewCatalog",
			"myTournamentGameweekReview",
			"myTournamentSeasonReview",
			"myTournamentReviewStatus",
		].includes(field)
	);
}

export function validateMyTournamentReviewContract(
	rootFields: readonly string[],
	headers: Headers
): ContractGateFailure | null {
	if (!requiresMyTournamentReviewV2(rootFields)) return null;
	if (
		hasContractToken(
			headers.get(MY_TOURNAMENT_REVIEW_CONTRACT_HEADER),
			MY_TOURNAMENT_REVIEW_CONTRACT
		)
	) {
		return null;
	}
	return {
		status: 426,
		code: "CLIENT_UPGRADE_REQUIRED",
		message: `The ${MY_TOURNAMENT_REVIEW_CONTRACT} client contract is required`,
	};
}

/** Resolver-level guard for callers that invoke a root directly in an
 * integration harness. The HTTP ingress gate remains authoritative for real
 * requests; this function deliberately does not inspect cookies or tokens. */
export function assertMyTournamentReviewContext(
	context: Pick<GraphQLContext, "requestScope">
): void {
	const contract = (context.requestScope as { myTournamentReviewContract?: string } | undefined)
		?.myTournamentReviewContract;
	if (contract !== undefined && !hasContractToken(contract, MY_TOURNAMENT_REVIEW_CONTRACT)) {
		throw new Error("CLIENT_UPGRADE_REQUIRED");
	}
}
