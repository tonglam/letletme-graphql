import type { GraphQLIngress } from "../infra/ingress-context";
import { env } from "../infra/env";
import { logger } from "../infra/logger";
import {
	rateLimitFingerprint,
	recordRateLimitAggregate,
	type RateLimitAggregateOutcome,
} from "../infra/rate-limit-observability";
import type { Principal } from "../infra/principal";
import { getRateLimitRedis } from "../infra/redis";
import {
	graphQLV3EarlyFailureRateLimitChecks,
	graphQLV3PreAuthRateLimitChecks,
	graphQLV3PrincipalAdmission,
} from "./graphql-policy-v3";
import {
	graphQLV4EarlyFailureRateLimitChecks,
	graphQLV4PreAuthRateLimitChecks,
	graphQLV4PrincipalAdmission,
} from "./graphql-policy-v4";
import {
	assertGraphQLRateLimitModeCanStart,
	productionGraphQLRateLimitPolicy,
} from "./rate-limit-policy-v3";
import {
	assertGraphQLRateLimitV4ModeCanStart,
	productionGraphQLRateLimitPolicyV4,
} from "./rate-limit-policy-v4";
import { handleRateLimitStorageFailure } from "./security";
import {
	checkTokenBucketStageV3,
	type GraphQLRateLimitHeaderScope,
	type TokenBucketCheckV3,
	type TokenBucketStageResultV3,
} from "./token-bucket-v3";
import { jsonError } from "./runtime-http";

assertGraphQLRateLimitModeCanStart(env.GRAPHQL_RATE_LIMIT_MODE, productionGraphQLRateLimitPolicy);
if (env.GRAPHQL_RATE_LIMIT_MODE === "shadow-v4" || env.GRAPHQL_RATE_LIMIT_MODE === "enforce-v4") {
	assertGraphQLRateLimitV4ModeCanStart(
		env.GRAPHQL_RATE_LIMIT_MODE,
		productionGraphQLRateLimitPolicyV4
	);
}

const isGraphQLV4Mode =
	env.GRAPHQL_RATE_LIMIT_MODE === "shadow-v4" || env.GRAPHQL_RATE_LIMIT_MODE === "enforce-v4";
export const isGraphQLRateLimitShadowMode =
	env.GRAPHQL_RATE_LIMIT_MODE === "shadow-v3" || env.GRAPHQL_RATE_LIMIT_MODE === "shadow-v4";
export const isGraphQLRateLimitEnforceMode =
	env.GRAPHQL_RATE_LIMIT_MODE === "enforce-v3" || env.GRAPHQL_RATE_LIMIT_MODE === "enforce-v4";
const activeGraphQLRateLimitPolicy = isGraphQLV4Mode
	? productionGraphQLRateLimitPolicyV4
	: productionGraphQLRateLimitPolicy;

/**
 * Only observational buckets are represented in the shadow response headers.
 * The global emergency valve remains an enforcing safety control even while
 * the rest of the policy is in shadow mode.
 */
export const isShadowOnlyRateLimitDecision = (decision: TokenBucketStageResultV3): boolean =>
	isGraphQLRateLimitShadowMode && !(decision.deniedScope === "global" && !decision.allowed);

const shouldEnforceRateLimitDecision = (
	decision: TokenBucketStageResultV3,
	enforce: boolean
): boolean => enforce || (isGraphQLRateLimitShadowMode && decision.deniedScope === "global");

export const graphQLVersionedPreAuthRateLimitChecks = (
	ingress: GraphQLIngress
): readonly TokenBucketCheckV3[] =>
	isGraphQLV4Mode
		? graphQLV4PreAuthRateLimitChecks(ingress, productionGraphQLRateLimitPolicyV4)
		: graphQLV3PreAuthRateLimitChecks(ingress, productionGraphQLRateLimitPolicy);

export const graphQLVersionedEarlyFailureRateLimitChecks = (): readonly TokenBucketCheckV3[] =>
	isGraphQLV4Mode
		? graphQLV4EarlyFailureRateLimitChecks(productionGraphQLRateLimitPolicyV4)
		: graphQLV3EarlyFailureRateLimitChecks(productionGraphQLRateLimitPolicy);

export const graphQLVersionedPrincipalAdmission = ({
	ingress,
	principal,
	cost,
}: {
	ingress: GraphQLIngress;
	principal: Principal | null;
	cost: number;
}) =>
	isGraphQLV4Mode
		? graphQLV4PrincipalAdmission({
				ingress,
				principal,
				cost,
				policy: productionGraphQLRateLimitPolicyV4,
			})
		: graphQLV3PrincipalAdmission({
				ingress,
				principal,
				cost,
				policy: productionGraphQLRateLimitPolicy,
			});

export type GraphQLRateLimitStageExecution = {
	readonly response: Response | null;
	readonly v3Decision?: TokenBucketStageResultV3;
};

export const checkV3GraphQLRateLimits = async ({
	checks,
	corsHeaders,
	enforce,
	rateLimitWorkload,
}: {
	checks: readonly TokenBucketCheckV3[];
	corsHeaders: Record<string, string>;
	enforce: boolean;
	rateLimitWorkload?: string;
}): Promise<{ response: Response | null; decision?: TokenBucketStageResultV3 }> => {
	try {
		const decision = await checkTokenBucketStageV3(getRateLimitRedis(), checks);
		if (!decision.allowed && shouldEnforceRateLimitDecision(decision, enforce)) {
			return {
				decision,
				response: jsonError(429, "RATE_LIMITED", "Too many requests", corsHeaders, {
					"Retry-After": String(decision.retryAfterSeconds),
					"X-RateLimit-Policy": activeGraphQLRateLimitPolicy.policyVersion,
					"X-RateLimit-Scope": decision.deniedScope ?? "client",
					...(decision.deniedScope === "workload" && rateLimitWorkload
						? { "X-RateLimit-Workload": rateLimitWorkload }
						: {}),
				}),
			};
		}
		return { decision, response: null };
	} catch (error) {
		const scope = checks[0]?.id ?? "graphql-v3";
		try {
			handleRateLimitStorageFailure({
				error,
				failClosed: enforce || isGraphQLRateLimitShadowMode,
				scope,
				logger,
			});
			return { response: null };
		} catch {
			return {
				response: jsonError(
					503,
					"RATE_LIMIT_STORAGE_UNAVAILABLE",
					"Request safety checks are temporarily unavailable",
					corsHeaders
				),
			};
		}
	}
};

export const runGraphQLRateLimitStage = async ({
	v3Checks,
	corsHeaders,
	rateLimitWorkload,
}: {
	v3Checks: readonly TokenBucketCheckV3[];
	corsHeaders: Record<string, string>;
	rateLimitWorkload?: string;
}): Promise<GraphQLRateLimitStageExecution> => {
	if (v3Checks.length === 0) return { response: null };
	// In shadow mode the global emergency valve is still enforcing. Evaluate it
	// separately so an observational client/workload denial cannot suppress the
	// global debit or turn a global outage into an allowed request.
	if (isGraphQLRateLimitShadowMode && v3Checks.length > 1) {
		const globalChecks = v3Checks.filter((check) => check.scope === "global");
		const observationalChecks = v3Checks.filter((check) => check.scope !== "global");
		if (globalChecks.length > 0 && observationalChecks.length > 0) {
			const global = await checkV3GraphQLRateLimits({
				checks: globalChecks,
				corsHeaders,
				enforce: true,
				rateLimitWorkload,
			});
			if (global.response || observationalChecks.length === 0) {
				return { response: global.response, v3Decision: global.decision };
			}
			const observational = await checkV3GraphQLRateLimits({
				checks: observationalChecks,
				corsHeaders,
				enforce: false,
				rateLimitWorkload,
			});
			return {
				response: observational.response,
				v3Decision: observational.decision,
			};
		}
	}
	const v3 = await checkV3GraphQLRateLimits({
		checks: v3Checks,
		corsHeaders,
		enforce: isGraphQLRateLimitEnforceMode,
		rateLimitWorkload,
	});
	return { response: v3.response, v3Decision: v3.decision };
};

export const logV3RateLimitDecision = ({
	requestId,
	operation,
	rootFields,
	ingress,
	stage,
	audience,
	identitySubject,
	decision,
}: {
	requestId: string;
	operation: string;
	rootFields: readonly string[];
	ingress: GraphQLIngress;
	stage: "pre-auth" | "weighted";
	audience?: string;
	identitySubject?: string | null;
	decision: TokenBucketStageResultV3;
}): void => {
	const selected =
		decision.details.find((detail) => detail.id === decision.deniedBucketId) ??
		decision.details.at(-1);
	logger.info(
		{
			requestId,
			operation,
			rootFields,
			trafficClass: ingress.trafficClass,
			workload: ingress.workload,
			stage,
			scope: decision.deniedScope ?? selected?.scope ?? "client",
			bucket: selected?.id ?? "unknown",
			cost: selected?.cost ?? 1,
			audience,
			burst: selected?.burst ?? 0,
			refill: selected?.refillPerSecond ?? 0,
			remaining: (selected?.remainingMilliTokens ?? 0) / 1000,
			retryAfter: decision.retryAfterSeconds,
			allowed: decision.allowed,
			outcome: isShadowOnlyRateLimitDecision(decision)
				? decision.allowed
					? "would_allow"
					: "would_deny"
				: decision.allowed
					? "allowed"
					: "denied",
			fingerprint: rateLimitFingerprint(identitySubject ?? ingress.subject),
			policy: activeGraphQLRateLimitPolicy.policyVersion,
		},
		`GraphQL ${activeGraphQLRateLimitPolicy.policyVersion.replace("graphql-", "")} rate-limit decision`
	);
};

export const recordRequestRateLimitOutcome = async ({
	ingress,
	scope,
	outcome,
}: {
	ingress: GraphQLIngress;
	scope: GraphQLRateLimitHeaderScope;
	outcome: RateLimitAggregateOutcome;
}): Promise<void> =>
	ingress.trafficClass === "untrusted"
		? Promise.resolve()
		: recordRateLimitAggregate({
				redis: getRateLimitRedis(),
				trafficClass: ingress.trafficClass,
				workload: ingress.workload,
				scope,
				outcome,
				fingerprint: rateLimitFingerprint(ingress.subject),
				policyVersion: activeGraphQLRateLimitPolicy.policyVersion,
				logger,
			});

export const terminalV3Outcome = (decision: TokenBucketStageResultV3): RateLimitAggregateOutcome =>
	isShadowOnlyRateLimitDecision(decision)
		? decision.allowed
			? "would_allow"
			: "would_deny"
		: decision.allowed
			? "allowed"
			: "denied";
