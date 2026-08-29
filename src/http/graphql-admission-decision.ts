import type { GraphQLRateLimitHeaderScope, TokenBucketStageResultV3 } from "./token-bucket-v3";

export type ShadowRateLimitDecision = Readonly<{
	outcome: "allow" | "deny";
	scope: GraphQLRateLimitHeaderScope;
}>;

export const mergeShadowRateLimitDecision = (
	current: ShadowRateLimitDecision | null,
	decision: TokenBucketStageResultV3
): ShadowRateLimitDecision => {
	if (current?.outcome === "deny") return current;
	return {
		outcome: decision.allowed ? "allow" : "deny",
		scope: decision.deniedScope ?? decision.details.at(-1)?.scope ?? "client",
	};
};

export const selectTerminalRateLimitDecision = (
	preAuthDenial: TokenBucketStageResultV3 | null,
	fallbackDecision: TokenBucketStageResultV3
): TokenBucketStageResultV3 => preAuthDenial ?? fallbackDecision;
